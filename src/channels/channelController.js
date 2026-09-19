import { Router } from 'express';
import * as channelService from './channelService.js';
import * as pinService from './pinService.js';

const router = Router();

/**
 * GET /api/v1/chat/channels
 * Lists all channels the authenticated user belongs to.
 */
router.get('/', async (req, res, next) => {
  try {
    const channels = await channelService.getUserChannels(req.user.userId);
    res.json({ data: channels });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels
 * Creates a new channel (DIRECT or GROUP).
 */
router.post('/', async (req, res, next) => {
  try {
    const { type, name, description, targetUserId, memberIds } = req.body;

    let channel;
    if (type === 'DIRECT') {
      if (!targetUserId) {
        return res.status(400).json({ error: 'targetUserId is required for DIRECT channels' });
      }
      channel = await channelService.createDirectChannel(req.user.userId, targetUserId);
    } else if (type === 'GROUP') {
      channel = await channelService.createGroupChannel(
        name,
        description,
        req.user.userId,
        memberIds ?? []
      );
    } else {
      return res.status(400).json({ error: 'Only DIRECT and GROUP channel creation is allowed' });
    }

    res.status(201).json({ data: channel });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/channels/:channelId
 * Gets channel details (must be a member).
 */
router.get('/:channelId', async (req, res, next) => {
  try {
    const channel = await channelService.getChannel(req.params.channelId, req.user.userId);
    res.json({ data: channel });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/channels/:channelId/members
 * Lists channel members.
 */
router.get('/:channelId/members', async (req, res, next) => {
  try {
    const members = await channelService.getChannelMembers(req.params.channelId, req.user.userId);
    res.json({ data: members });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels/:channelId/members
 * Adds a member to a GROUP channel.
 */
router.post('/:channelId/members', async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const member = await channelService.addChannelMember(req.params.channelId, userId, req.user.userId);
    res.status(201).json({ data: member });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/chat/channels/:channelId/members/:userId
 * Removes a member from a GROUP channel.
 */
router.delete('/:channelId/members/:userId', async (req, res, next) => {
  try {
    await channelService.removeChannelMember(
      req.params.channelId,
      req.params.userId,
      req.user.userId
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/chat/channels/:channelId
 * Updates channel name or description (Phase 3).
 */
router.put('/:channelId', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const channel = await channelService.updateChannel(
      req.params.channelId,
      { name, description },
      req.user.userId,
      req.user.roles
    );
    res.json({ data: channel });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels/:channelId/archive
 * Archives a channel (Phase 3).
 */
router.post('/:channelId/archive', async (req, res, next) => {
  try {
    const channel = await channelService.archiveChannel(
      req.params.channelId,
      req.user.userId,
      req.user.roles,
      true
    );
    res.json({ data: channel });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels/:channelId/unarchive
 * Unarchives a channel (Phase 3).
 */
router.post('/:channelId/unarchive', async (req, res, next) => {
  try {
    const channel = await channelService.archiveChannel(
      req.params.channelId,
      req.user.userId,
      req.user.roles,
      false
    );
    res.json({ data: channel });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/chat/channels/:channelId/pins
 * Lists pinned messages in a channel (Phase 3).
 */
router.get('/:channelId/pins', async (req, res, next) => {
  try {
    const pins = await pinService.getPinnedMessages(req.params.channelId, req.user.userId);
    res.json({ data: pins });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/chat/channels/:channelId/pins/:messageId
 * Pins a message in a channel (Phase 3).
 */
router.post('/:channelId/pins/:messageId', async (req, res, next) => {
  try {
    const pinned = await pinService.pinMessage(
      req.params.channelId,
      req.params.messageId,
      req.user.userId,
      req.user.roles
    );
    res.status(201).json({ data: pinned });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/chat/channels/:channelId/pins/:messageId
 * Unpins a message in a channel (Phase 3).
 */
router.delete('/:channelId/pins/:messageId', async (req, res, next) => {
  try {
    const result = await pinService.unpinMessage(
      req.params.channelId,
      req.params.messageId,
      req.user.userId,
      req.user.roles
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
