import * as channelRepo from './channelRepository.js';
import tenantContext from '../tenant/tenantContext.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../common/errors.js';
import logger from '../common/logger.js';

/** Valid channel types for Phase 1 */
const CHANNEL_TYPES = ['ORG', 'COURSE', 'DIRECT', 'GROUP', 'ANNOUNCEMENT', 'LIVE_SESSION'];

/**
 * Ensures the ORG General channel exists for a tenant. Called on first
 * user connection. Idempotent.
 */
export async function ensureOrgGeneralChannel(userId) {
  let channel = await channelRepo.findOrgGeneralChannel();
  if (channel) {
    // Make sure this user is a member
    const member = await channelRepo.isMember(channel.id, userId);
    if (!member) {
      await channelRepo.addMember(channel.id, userId, 'MEMBER');
    }
    return channel;
  }

  // Create the General channel
  channel = await channelRepo.createChannel({
    type: 'ORG',
    name: 'General',
    description: 'Organization-wide general discussion',
    courseId: null,
    createdBy: userId,
  });
  await channelRepo.addMember(channel.id, userId, 'OWNER');
  logger.info({ channelId: channel.id }, 'Created ORG General channel');
  return channel;
}

/**
 * Creates a direct message channel between two users.
 * Returns existing channel if one already exists.
 */
export async function createDirectChannel(userId1, userId2) {
  if (userId1 === userId2) {
    throw new BadRequestError('Cannot create a DM with yourself');
  }

  // Check if DM already exists
  const existing = await channelRepo.findDirectChannel(userId1, userId2);
  let channel = existing;
  if (!channel) {
    channel = await channelRepo.createChannel({
      type: 'DIRECT',
      name: null,
      description: null,
      courseId: null,
      createdBy: userId1,
    });
    await channelRepo.addMember(channel.id, userId1, 'MEMBER');
    await channelRepo.addMember(channel.id, userId2, 'MEMBER');
  }

  // Return channel enriched with display_name and other_user_id for creator
  return channelRepo.findChannelById(channel.id, userId1);
}

/**
 * Creates a group channel.
 */
export async function createGroupChannel(name, description, createdBy, memberIds) {
  if (!name?.trim()) {
    throw new BadRequestError('Group name is required');
  }

  const channel = await channelRepo.createChannel({
    type: 'GROUP',
    name: name.trim(),
    description: description?.trim() ?? null,
    courseId: null,
    createdBy,
  });

  // Add creator as owner
  await channelRepo.addMember(channel.id, createdBy, 'OWNER');

  // Add other members
  for (const memberId of memberIds) {
    if (memberId !== createdBy) {
      await channelRepo.addMember(channel.id, memberId, 'MEMBER');
    }
  }

  return channel;
}

/**
 * Synchronizes course channels for courses where the user is an instructor or enrolled student.
 */
export async function syncUserCourseChannels(userId) {
  try {
    const pool = tenantContext.getPool();
    const coursesRes = await pool.query(
      `SELECT DISTINCT c.id, c.title, c.instructor_id
       FROM lms.courses c
       LEFT JOIN lms.enrollments e ON e.course_id = c.id AND e.status = 'ACTIVE'
       WHERE c.instructor_id = $1 OR e.student_id = $1`,
      [userId]
    );

    for (const course of coursesRes.rows) {
      let ch = await channelRepo.findCourseChannel(course.id);
      if (!ch) {
        ch = await channelRepo.createChannel({
          type: 'COURSE',
          name: course.title,
          description: `Discussion channel for ${course.title}`,
          courseId: course.id,
          createdBy: course.instructor_id || userId,
        });
        if (course.instructor_id) {
          await channelRepo.addMember(ch.id, course.instructor_id, 'ADMIN');
        }
      }
      const isMem = await channelRepo.isMember(ch.id, userId);
      if (!isMem) {
        const role = course.instructor_id === userId ? 'ADMIN' : 'MEMBER';
        await channelRepo.addMember(ch.id, userId, role);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Course channel sync non-blocking error');
  }
}

/**
 * Lists all channels for a user, enriched with latest message preview and unread count.
 */
export async function getUserChannels(userId) {
  await syncUserCourseChannels(userId);
  return channelRepo.findChannelsByUserId(userId);
}

/**
 * Gets channel details with membership check.
 */
export async function getChannel(channelId, userId) {
  const channel = await channelRepo.findChannelById(channelId, userId);
  if (!channel) throw new NotFoundError('Channel not found');

  const member = await channelRepo.isMember(channelId, userId);
  if (!member) throw new ForbiddenError('You are not a member of this channel');

  return channel;
}

/**
 * Gets channel members.
 */
export async function getChannelMembers(channelId, userId) {
  // Verify requesting user is a member
  const member = await channelRepo.isMember(channelId, userId);
  if (!member) throw new ForbiddenError('You are not a member of this channel');

  return channelRepo.findMembers(channelId);
}

/**
 * Adds a member to a group channel (only OWNER/ADMIN can do this).
 */
export async function addChannelMember(channelId, targetUserId, actorUserId) {
  const channel = await channelRepo.findChannelById(channelId);
  if (!channel) throw new NotFoundError('Channel not found');
  if (channel.type !== 'GROUP') throw new BadRequestError('Can only add members to group channels');

  const actorMember = await channelRepo.findMember(channelId, actorUserId);
  if (!actorMember || !['OWNER', 'ADMIN'].includes(actorMember.role)) {
    throw new ForbiddenError('Only channel owners/admins can add members');
  }

  return channelRepo.addMember(channelId, targetUserId, 'MEMBER');
}

/**
 * Removes a member from a group channel.
 */
export async function removeChannelMember(channelId, targetUserId, actorUserId) {
  const channel = await channelRepo.findChannelById(channelId);
  if (!channel) throw new NotFoundError('Channel not found');
  if (channel.type !== 'GROUP') throw new BadRequestError('Can only remove members from group channels');

  // Users can leave themselves; OWNER/ADMIN can remove others
  if (targetUserId !== actorUserId) {
    const actorMember = await channelRepo.findMember(channelId, actorUserId);
    if (!actorMember || !['OWNER', 'ADMIN'].includes(actorMember.role)) {
      throw new ForbiddenError('Only channel owners/admins can remove members');
    }
  }

  await channelRepo.removeMember(channelId, targetUserId);
}

/**
 * Auto-joins user to ORG General channel.
 * Called when user first connects.
 */
export async function autoJoinOrgChannel(userId) {
  const channel = await channelRepo.findOrgGeneralChannel();
  if (!channel) return null;

  const member = await channelRepo.isMember(channel.id, userId);
  if (!member) {
    await channelRepo.addMember(channel.id, userId, 'MEMBER');
  }
  return channel;
}

/**
 * Updates channel details (rename or change description).
 */
export async function updateChannel(channelId, { name, description }, actorUserId, userRoles = []) {
  const channel = await channelRepo.findChannelById(channelId);
  if (!channel) throw new NotFoundError('Channel not found');

  const actorMember = await channelRepo.findMember(channelId, actorUserId);
  const isPrivileged =
    userRoles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r)) ||
    ['OWNER', 'ADMIN'].includes(actorMember?.role);

  if (!isPrivileged) {
    throw new ForbiddenError('Only channel administrators can edit channel settings');
  }

  return channelRepo.updateChannel(channelId, { name: name?.trim(), description: description?.trim() });
}

/**
 * Archives or unarchives a channel.
 */
export async function archiveChannel(channelId, actorUserId, userRoles = [], isArchived = true) {
  const channel = await channelRepo.findChannelById(channelId);
  if (!channel) throw new NotFoundError('Channel not found');

  const actorMember = await channelRepo.findMember(channelId, actorUserId);
  const isPrivileged =
    userRoles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r)) ||
    ['OWNER', 'ADMIN'].includes(actorMember?.role);

  if (!isPrivileged) {
    throw new ForbiddenError('Only channel administrators can archive this channel');
  }

  return channelRepo.setChannelArchived(channelId, isArchived);
}
