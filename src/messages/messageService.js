import * as messageRepo from './messageRepository.js';
import * as channelRepo from '../channels/channelRepository.js';
import * as auditService from '../audit/auditService.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../common/errors.js';
import env from '../config/environment.js';

/**
 * Sends a message to a channel.
 * Validates membership, length, and handles idempotency.
 */
export async function sendMessage({ channelId, senderId, content, messageType = 'TEXT', replyToMessageId, clientMessageId, attachments = [] }) {
  // Validate membership
  const isMember = await channelRepo.isMember(channelId, senderId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  // Validate content or attachments
  const trimmedContent = content?.trim() ?? '';
  if (!trimmedContent && (!attachments || attachments.length === 0)) {
    throw new BadRequestError('Message content or attachment is required');
  }
  if (trimmedContent.length > env.messageMaxLength) {
    throw new BadRequestError(`Message exceeds maximum length of ${env.messageMaxLength} characters`);
  }

  const resolvedMessageType = attachments?.length > 0 && !trimmedContent ? 'ATTACHMENT' : messageType;

  // Validate reply target exists (if replying)
  if (replyToMessageId) {
    const replyTarget = await messageRepo.findMessageById(replyToMessageId);
    if (!replyTarget || replyTarget.channel_id !== channelId) {
      throw new BadRequestError('Reply target message not found in this channel');
    }
  }

  // Create message (idempotent via clientMessageId)
  const { message, isDuplicate } = await messageRepo.createMessage({
    channelId,
    senderId,
    content: trimmedContent,
    messageType: resolvedMessageType,
    replyToMessageId,
    clientMessageId,
    attachments,
  });

  // Update channel's updated_at (for sorting in channel list)
  if (!isDuplicate) {
    await channelRepo.touchChannel(channelId);
  }

  return { message, isDuplicate };
}

/**
 * Gets message history for a channel with cursor-based pagination.
 */
export async function getMessages(channelId, userId, { before, limit } = {}) {
  // Validate membership
  const isMember = await channelRepo.isMember(channelId, userId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  return messageRepo.findMessages(channelId, { before, limit });
}

/**
 * Gets messages after a known message (for reconnect recovery).
 */
export async function getMissedMessages(channelId, userId, afterMessageId) {
  const isMember = await channelRepo.isMember(channelId, userId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  return messageRepo.findMessagesAfter(channelId, afterMessageId);
}

/**
 * Edits a message. Only the sender can edit their own messages.
 */
export async function editMessage(messageId, userId, newContent) {
  if (!newContent?.trim()) throw new BadRequestError('Message content is required');
  if (newContent.length > env.messageMaxLength) {
    throw new BadRequestError(`Message exceeds maximum length of ${env.messageMaxLength} characters`);
  }

  const message = await messageRepo.findMessageById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  if (message.sender_id !== userId) throw new ForbiddenError('You can only edit your own messages');
  if (message.deleted_at) throw new BadRequestError('Cannot edit a deleted message');

  const previousContent = message.content;
  const updated = await messageRepo.editMessage(messageId, userId, newContent.trim());

  if (updated) {
    await auditService.logAuditEvent({
      actorUserId: userId,
      action: auditService.AUDIT_ACTIONS.MESSAGE_EDITED,
      channelId: message.channel_id,
      messageId,
      metadata: {
        previousContent,
        newContent: updated.content,
      },
    });
  }

  return updated;
}

/**
 * Soft-deletes a message.
 * - Sender can delete their own message
 * - ADMIN/INSTRUCTOR roles can moderate-delete any message
 */
export async function deleteMessage(messageId, userId, userRoles = []) {
  const message = await messageRepo.findMessageById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  if (message.deleted_at) throw new BadRequestError('Message is already deleted');

  const isModerator = userRoles.some((r) =>
    ['ADMIN', 'SUPER_ADMIN', 'INSTRUCTOR'].includes(r)
  );
  const isOwner = message.sender_id === userId;

  if (!isOwner && !isModerator) {
    throw new ForbiddenError('You can only delete your own messages');
  }

  const isModeratedAction = isModerator && !isOwner;
  const deleted = await messageRepo.softDeleteMessage(messageId, userId, message.sender_id, isModeratedAction);

  if (deleted) {
    await auditService.logAuditEvent({
      actorUserId: userId,
      action: isModeratedAction
        ? auditService.AUDIT_ACTIONS.MESSAGE_MODERATED
        : auditService.AUDIT_ACTIONS.MESSAGE_DELETED,
      channelId: message.channel_id,
      messageId,
      metadata: {
        originalSenderId: message.sender_id,
        isModeratorAction: isModeratedAction,
      },
    });
  }

  return { message: deleted, channelId: message.channel_id };
}

/**
 * Marks a channel as read up to a specific message.
 */
export async function markChannelAsRead(channelId, userId, messageId) {
  const isMember = await channelRepo.isMember(channelId, userId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  await channelRepo.updateLastReadMessage(channelId, userId, messageId);
}

/**
 * Gets unread counts for all of a user's channels.
 */
export async function getUnreadCounts(userId) {
  const channels = await channelRepo.findChannelsByUserId(userId);
  const counts = {};

  for (const channel of channels) {
    const count = await messageRepo.countUnreadMessages(channel.id, channel.last_read_message_id);
    if (count > 0) {
      counts[channel.id] = count;
    }
  }

  return counts;
}

/**
 * Searches messages for a user with membership check.
 */
export async function searchMessages(query, channelId, userId) {
  const trimmed = query?.trim();
  if (!trimmed || trimmed.length < 1) {
    return [];
  }

  if (channelId) {
    const isMember = await channelRepo.isMember(channelId, userId);
    if (!isMember) {
      throw new ForbiddenError('You are not a member of this channel');
    }
  }

  return messageRepo.searchMessages({
    query: trimmed,
    channelId: channelId || null,
    userId,
  });
}

