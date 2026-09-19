import * as reactionRepo from './reactionRepository.js';
import * as messageRepo from './messageRepository.js';
import * as channelRepo from '../channels/channelRepository.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../common/errors.js';

const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🔥', '👏'];

/**
 * Toggles an emoji reaction on a message.
 */
export async function toggleReaction(messageId, userId, reaction) {
  if (!reaction || !reaction.trim()) {
    throw new BadRequestError('Reaction is required');
  }

  const message = await messageRepo.findMessageById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  if (message.deleted_at) throw new BadRequestError('Cannot react to a deleted message');

  // Verify user is a member of the channel
  const isMember = await channelRepo.isMember(message.channel_id, userId);
  if (!isMember) throw new ForbiddenError('You are not a member of this channel');

  const result = await reactionRepo.toggleReaction(messageId, userId, reaction.trim());
  return { ...result, channelId: message.channel_id };
}

/**
 * Gets reactions for messages.
 */
export async function getReactionsByMessageIds(messageIds) {
  return reactionRepo.getReactionsByMessageIds(messageIds);
}
