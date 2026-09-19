import * as pinRepo from './pinRepository.js';
import * as channelRepo from './channelRepository.js';
import * as messageRepo from '../messages/messageRepository.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../common/errors.js';

/**
 * Pins a message in a channel.
 */
export async function pinMessage(channelId, messageId, userId, userRoles = []) {
  const channel = await channelRepo.findChannelById(channelId);
  if (!channel) throw new NotFoundError('Channel not found');
  if (channel.is_archived) throw new BadRequestError('Cannot pin messages in an archived channel');

  const message = await messageRepo.findMessageById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  if (message.channel_id !== channelId) throw new BadRequestError('Message does not belong to this channel');
  if (message.deleted_at) throw new BadRequestError('Cannot pin a deleted message');

  const member = await channelRepo.findMember(channelId, userId);
  if (!member) throw new ForbiddenError('You are not a member of this channel');

  const isPrivileged =
    userRoles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'INSTRUCTOR'].includes(r)) ||
    ['OWNER', 'ADMIN'].includes(member.role) ||
    channel.type === 'DIRECT';

  if (!isPrivileged) {
    throw new ForbiddenError('Only channel administrators can pin messages');
  }

  const pinned = await pinRepo.pinMessage(channelId, messageId, userId);
  return {
    ...pinned,
    messageId,
    channelId,
    content: message.content,
  };
}

/**
 * Unpins a message in a channel.
 */
export async function unpinMessage(channelId, messageId, userId, userRoles = []) {
  const member = await channelRepo.findMember(channelId, userId);
  if (!member) throw new ForbiddenError('You are not a member of this channel');

  const channel = await channelRepo.findChannelById(channelId);
  const isPrivileged =
    userRoles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'INSTRUCTOR'].includes(r)) ||
    ['OWNER', 'ADMIN'].includes(member.role) ||
    channel?.type === 'DIRECT';

  if (!isPrivileged) {
    throw new ForbiddenError('Only channel administrators can unpin messages');
  }

  await pinRepo.unpinMessage(channelId, messageId);
  return { channelId, messageId };
}

/**
 * Gets pinned messages for a channel.
 */
export async function getPinnedMessages(channelId, userId) {
  const isMember = await channelRepo.isMember(channelId, userId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  return pinRepo.getPinnedMessages(channelId);
}
