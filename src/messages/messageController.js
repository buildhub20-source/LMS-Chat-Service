import { Router } from 'express';
import * as messageService from './messageService.js';
import * as reactionService from './reactionService.js';

const router = Router();

/**
 * GET /api/v1/chat/messages/search
 * Searches messages within a channel or across all user's channels.
 * Query: ?q=<searchQuery>&channelId=<optionalChannelId>
 */
router.get('/messages/search', async (req, res, next) => {
  try {
    const { q, channelId } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.json({ data: [] });
    }
    const results = await messageService.searchMessages(q, channelId, req.user.userId);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/channels/:channelId/messages
 * Fetches message history with cursor-based pagination.
 * Query: ?before=<messageId>&limit=50
 */
router.get('/channels/:channelId/messages', async (req, res, next) => {
  try {
    const { before, limit } = req.query;
    const messages = await messageService.getMessages(
      req.params.channelId,
      req.user.userId,
      { before, limit: limit ? parseInt(limit, 10) : undefined }
    );
    res.json({ data: messages });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/chat/messages/:messageId
 * Edits a message (Phase 2).
 */
router.put('/messages/:messageId', async (req, res, next) => {
  try {
    const { content } = req.body;
    const message = await messageService.editMessage(req.params.messageId, req.user.userId, content);
    res.json({ data: message });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/chat/messages/:messageId
 * Soft-deletes a message (Phase 2).
 */
router.delete('/messages/:messageId', async (req, res, next) => {
  try {
    const result = await messageService.deleteMessage(
      req.params.messageId,
      req.user.userId,
      req.user.roles
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels/:channelId/read
 * Marks a channel as read up to a specific message (Phase 2).
 */
router.post('/channels/:channelId/read', async (req, res, next) => {
  try {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });

    await messageService.markChannelAsRead(req.params.channelId, req.user.userId, messageId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/unread-counts
 * Gets unread message counts for all user's channels (Phase 2).
 */
router.get('/unread-counts', async (req, res, next) => {
  try {
    const counts = await messageService.getUnreadCounts(req.user.userId);
    res.json({ data: counts });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/messages/:messageId/reactions
 * Toggles a reaction on a message (Phase 3).
 */
router.post('/messages/:messageId/reactions', async (req, res, next) => {
  try {
    const { reaction } = req.body;
    const result = await reactionService.toggleReaction(
      req.params.messageId,
      req.user.userId,
      reaction
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/messages/:messageId/reactions
 * Gets reactions for a message (Phase 3).
 */
router.get('/messages/:messageId/reactions', async (req, res, next) => {
  try {
    const map = await reactionService.getReactionsByMessageIds([req.params.messageId]);
    res.json({ data: map[req.params.messageId] || [] });
  } catch (err) {
    next(err);
  }
});

export default router;
