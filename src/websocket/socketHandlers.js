import tenantContext from '../tenant/tenantContext.js';
import * as channelService from '../channels/channelService.js';
import * as messageService from '../messages/messageService.js';
import * as channelRepo from '../channels/channelRepository.js';
import * as reactionService from '../messages/reactionService.js';
import * as pinService from '../channels/pinService.js';
import connectionManager from './connectionManager.js';
import logger from '../common/logger.js';
import env from '../config/environment.js';

/** Per-user rate limiter for messages (Phase 2). */
const rateLimiters = new Map();

/**
 * Registers all Socket.IO event handlers for a connected socket.
 * Each handler runs inside the tenant context for DB access.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerSocketHandlers(io, socket) {
  const { userId, tenantId, email, roles } = socket.user;

  /**
   * Helper: runs a callback inside the tenant context.
   */
  function withTenantContext(fn) {
    return (...args) => {
      tenantContext.run({ tenantId, pool: socket.pool }, () => fn(...args));
    };
  }

  /**
   * Helper: emits to all sockets in a channel's Socket.IO room.
   */
  function emitToChannel(channelId, event, data) {
    io.to(`${tenantId}:${channelId}`).emit(event, data);
  }

  /**
   * Helper: emits to all sockets of a specific user (multi-device).
   */
  function emitToUser(targetUserId, event, data) {
    const sockets = connectionManager.getUserSockets(tenantId, targetUserId);
    for (const sid of sockets) {
      io.to(sid).emit(event, data);
    }
  }

  // ─── Connection Setup ────────────────────────────────────

  // Register connection
  const { wasOffline } = connectionManager.add(tenantId, userId, socket.id);
  logger.info({ userId, tenantId, socketId: socket.id }, 'Client connected');

  // Broadcast presence if user just transitioned to online
  if (wasOffline) {
    io.emit('user_presence', {
      userId,
      status: 'ONLINE',
      tenantId,
    });
  }

  // Auto-setup: ensure ORG General channel exists and user is a member
  withTenantContext(async () => {
    try {
      await channelService.ensureOrgGeneralChannel(userId);

      // Join Socket.IO rooms for all user's channels
      const channels = await channelService.getUserChannels(userId);
      for (const ch of channels) {
        socket.join(`${tenantId}:${ch.id}`);
      }

      // Send channel list and presence state to client
      const presence = connectionManager.getPresence(tenantId);
      socket.emit('authenticated', {
        userId,
        email,
        onlineUserIds: presence.onlineUserIds,
        lastSeen: presence.lastSeen,
        channels: channels.map((ch) => ({
          id: ch.id,
          type: ch.type,
          name: ch.name,
          displayName: ch.display_name,
          display_name: ch.display_name,
          otherUserId: ch.other_user_id,
          other_user_id: ch.other_user_id,
          otherUserName: ch.other_user_name || ch.display_name,
          other_user_name: ch.other_user_name || ch.display_name,
          directUserEmail: ch.direct_user_email,
          direct_user_email: ch.direct_user_email,
          description: ch.description,
          courseId: ch.course_id,
          isArchived: ch.is_archived,
          memberRole: ch.member_role,
          lastReadMessageId: ch.last_read_message_id,
        })),
      });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'Error during connection setup');
      socket.emit('error', { code: 'SETUP_ERROR', message: 'Failed to initialize chat' });
    }
  })();

  // ─── join_channel ────────────────────────────────────────

  socket.on('join_channel', withTenantContext(async ({ channelId }) => {
    try {
      const isMember = await channelRepo.isMember(channelId, userId);
      if (!isMember) {
        return socket.emit('error', { code: 'FORBIDDEN', message: 'Not a member of this channel' });
      }
      socket.join(`${tenantId}:${channelId}`);
      socket.emit('joined_channel', { channelId });
    } catch (err) {
      logger.error({ err, channelId, userId }, 'join_channel error');
      socket.emit('error', { code: 'JOIN_ERROR', message: err.message });
    }
  }));

  // ─── leave_channel ───────────────────────────────────────

  socket.on('leave_channel', ({ channelId }) => {
    socket.leave(`${tenantId}:${channelId}`);
  });

  // ─── send_message ────────────────────────────────────────

  socket.on('send_message', withTenantContext(async ({ channelId, content, clientMessageId, replyToMessageId, attachments }) => {
    try {
      // Phase 2: Rate limiting
      if (!checkRateLimit(userId)) {
        return socket.emit('error', { code: 'RATE_LIMIT', message: 'Too many messages. Please slow down.' });
      }

      const { message, isDuplicate } = await messageService.sendMessage({
        channelId,
        senderId: userId,
        content,
        replyToMessageId,
        clientMessageId,
        attachments: attachments || [],
      });

      const senderDisplayName = message.sender_name || email?.split('@')[0];

      // Broadcast to all members in the channel (including sender's other devices)
      emitToChannel(channelId, 'new_message', {
        id: message.id,
        channelId: message.channel_id,
        senderId: message.sender_id,
        senderEmail: message.sender_email || email,
        senderName: message.sender_name || null,
        content: message.content,
        messageType: message.message_type,
        replyToMessageId: message.reply_to_message_id,
        replyToContent: message.reply_to_content || null,
        replyToSenderName: message.reply_to_sender_name || message.reply_to_sender_email?.split('@')[0] || null,
        clientMessageId: message.client_message_id,
        attachments: message.attachments || attachments || [],
        createdAt: message.created_at,
        isDuplicate,
      });

      // Notify recipient for Direct messages
      if (!isDuplicate) {
        notifyMessageRecipient(tenantId, channelId, userId, senderDisplayName, content);
      }
    } catch (err) {
      logger.error({ err, channelId, userId }, 'send_message error');
      socket.emit('error', { code: 'SEND_ERROR', message: err.message });
    }
  }));

  // ─── edit_message (Phase 2) ──────────────────────────────

  socket.on('edit_message', withTenantContext(async ({ messageId, content }) => {
    try {
      const updated = await messageService.editMessage(messageId, userId, content);
      if (updated) {
        emitToChannel(updated.channel_id, 'message_edited', {
          messageId: updated.id,
          channelId: updated.channel_id,
          content: updated.content,
          editedAt: updated.edited_at,
        });
      }
    } catch (err) {
      logger.error({ err, messageId, userId }, 'edit_message error');
      socket.emit('error', { code: 'EDIT_ERROR', message: err.message });
    }
  }));

  // ─── delete_message (Phase 2) ────────────────────────────

  socket.on('delete_message', withTenantContext(async ({ messageId }) => {
    try {
      const result = await messageService.deleteMessage(messageId, userId, roles);
      if (result.message) {
        emitToChannel(result.channelId, 'message_deleted', {
          messageId: result.message.id,
          channelId: result.channelId,
          deletedAt: result.message.deleted_at,
          deletedBy: userId,
        });
      }
    } catch (err) {
      logger.error({ err, messageId, userId }, 'delete_message error');
      socket.emit('error', { code: 'DELETE_ERROR', message: err.message });
    }
  }));

  // ─── typing_start / typing_stop ──────────────────────────

  socket.on('typing_start', ({ channelId }) => {
    socket.to(`${tenantId}:${channelId}`).emit('user_typing', { channelId, userId, email });
  });

  socket.on('typing_stop', ({ channelId }) => {
    socket.to(`${tenantId}:${channelId}`).emit('user_stop_typing', { channelId, userId });
  });

  // ─── mark_read (Phase 2) ─────────────────────────────────

  socket.on('mark_read', withTenantContext(async ({ channelId, messageId }) => {
    try {
      await messageService.markChannelAsRead(channelId, userId, messageId);
      // Notify user's other devices
      emitToUser(userId, 'unread_updated', { channelId, count: 0 });
    } catch (err) {
      logger.error({ err, channelId, userId }, 'mark_read error');
    }
  }));

  // ─── sync (Phase 2 — reconnect recovery) ─────────────────

  socket.on('sync', withTenantContext(async ({ lastMessageIds }) => {
    try {
      // lastMessageIds: { channelId: lastKnownMessageId }
      if (!lastMessageIds || typeof lastMessageIds !== 'object') return;

      for (const [channelId, lastMessageId] of Object.entries(lastMessageIds)) {
        const missed = await messageService.getMissedMessages(channelId, userId, lastMessageId);
        if (missed.length > 0) {
          socket.emit('missed_messages', { channelId, messages: missed });
        }
      }
    } catch (err) {
      logger.error({ err, userId }, 'sync error');
    }
  }));

  // ─── create_dm ───────────────────────────────────────────

  socket.on('create_dm', withTenantContext(async ({ targetUserId }) => {
    try {
      const channel = await channelService.createDirectChannel(userId, targetUserId);
      // Join both users to the DM room
      socket.join(`${tenantId}:${channel.id}`);
      const targetSockets = connectionManager.getUserSockets(tenantId, targetUserId);
      for (const sid of targetSockets) {
        io.sockets.sockets.get(sid)?.join(`${tenantId}:${channel.id}`);
      }

      // Look up names for both participants
      const pool = tenantContext.getPool();
      const usersRes = await pool.query(
        `SELECT id, name, email FROM lms.users WHERE id IN ($1, $2)`,
        [userId, targetUserId]
      );
      const userRows = usersRes.rows;
      const creatorObj = userRows.find((u) => u.id === userId);
      const targetObj = userRows.find((u) => u.id === targetUserId);

      const creatorName = creatorObj?.name || creatorObj?.email?.split('@')[0] || 'User';
      const targetName = targetObj?.name || targetObj?.email?.split('@')[0] || 'User';

      socket.emit('channel_created', {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        displayName: targetName,
        display_name: targetName,
        otherUserId: targetUserId,
        other_user_id: targetUserId,
        otherUserName: targetName,
        other_user_name: targetName,
        createdBy: channel.created_by,
      });

      // Also notify the target user
      emitToUser(targetUserId, 'channel_created', {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        displayName: creatorName,
        display_name: creatorName,
        otherUserId: userId,
        other_user_id: userId,
        otherUserName: creatorName,
        other_user_name: creatorName,
        createdBy: channel.created_by,
      });
    } catch (err) {
      logger.error({ err, userId, targetUserId }, 'create_dm error');
      socket.emit('error', { code: 'DM_ERROR', message: err.message });
    }
  }));

  // ─── toggle_reaction (Phase 3) ───────────────────────────

  socket.on('toggle_reaction', withTenantContext(async ({ messageId, reaction }) => {
    try {
      const result = await reactionService.toggleReaction(messageId, userId, reaction);
      const map = await reactionService.getReactionsByMessageIds([messageId]);
      emitToChannel(result.channelId, 'reaction_updated', {
        messageId,
        channelId: result.channelId,
        reactions: map[messageId] || [],
        action: result.added ? 'ADDED' : 'REMOVED',
        userId,
        reaction,
      });
    } catch (err) {
      logger.error({ err, messageId, userId }, 'toggle_reaction error');
      socket.emit('error', { code: 'REACTION_ERROR', message: err.message });
    }
  }));

  // ─── pin_message / unpin_message (Phase 3) ───────────────

  socket.on('pin_message', withTenantContext(async ({ channelId, messageId }) => {
    try {
      const pinned = await pinService.pinMessage(channelId, messageId, userId, roles);
      emitToChannel(channelId, 'message_pinned', {
        channelId,
        messageId,
        pinnedBy: userId,
        pinnedAt: pinned.pinned_at,
        content: pinned.content,
      });
    } catch (err) {
      logger.error({ err, channelId, messageId, userId }, 'pin_message error');
      socket.emit('error', { code: 'PIN_ERROR', message: err.message });
    }
  }));

  socket.on('unpin_message', withTenantContext(async ({ channelId, messageId }) => {
    try {
      await pinService.unpinMessage(channelId, messageId, userId, roles);
      emitToChannel(channelId, 'message_unpinned', { channelId, messageId });
    } catch (err) {
      logger.error({ err, channelId, messageId, userId }, 'unpin_message error');
      socket.emit('error', { code: 'UNPIN_ERROR', message: err.message });
    }
  }));

  // ─── archive_channel (Phase 3) ───────────────────────────

  socket.on('archive_channel', withTenantContext(async ({ channelId, isArchived = true }) => {
    try {
      const updated = await channelService.archiveChannel(channelId, userId, roles, isArchived);
      emitToChannel(channelId, 'channel_archived', {
        channelId,
        isArchived: updated.is_archived,
      });
    } catch (err) {
      logger.error({ err, channelId, userId }, 'archive_channel error');
      socket.emit('error', { code: 'ARCHIVE_ERROR', message: err.message });
    }
  }));

  // ─── Disconnect ──────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    const meta = connectionManager.remove(socket.id);
    if (meta?.isNowOffline) {
      io.emit('user_presence', {
        userId: meta.userId,
        status: 'OFFLINE',
        lastSeen: meta.lastSeen,
        tenantId: meta.tenantId,
      });
    }
    logger.info({ userId, tenantId, socketId: socket.id, reason }, 'Client disconnected');
  });
}

// ─── Rate Limiting (Phase 2) ─────────────────────────────────

/**
 * Simple sliding-window rate limiter per user.
 * Returns true if the message is allowed, false if rate limited.
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute
  const maxMessages = env.rateLimitMessagesPerMinute;

  if (!rateLimiters.has(userId)) {
    rateLimiters.set(userId, []);
  }

  const timestamps = rateLimiters.get(userId);

  // Remove timestamps outside the window
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= maxMessages) {
    return false;
  }

  timestamps.push(now);
  return true;
}

// Clean up rate limiter entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of rateLimiters) {
    while (timestamps.length > 0 && timestamps[0] < now - 60_000) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimiters.delete(userId);
  }
}, 60_000);

async function notifyMessageRecipient(tenantId, channelId, senderId, senderName, content) {
  try {
    const channel = await channelRepo.findChannelById(channelId);
    if (!channel) return;

    const members = await channelRepo.findMembers(channelId);
    const linkUrl = `/chat?channelId=${channelId}`;

    // 1. Direct Message notification
    if (channel.type === 'DIRECT') {
      const recipient = members.find((m) => m.user_id !== senderId);
      if (recipient) {
        fetch('http://localhost:3002/api/v1/internal/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': env.serviceKeySecret,
          },
          body: JSON.stringify({
            tenantId,
            userId: recipient.user_id,
            type: 'CHAT_DM',
            title: senderName || 'Direct Message',
            message: content ? (content.length > 80 ? content.slice(0, 77) + '...' : content) : 'Sent an attachment',
            linkUrl,
            data: {
              channelId,
              channelType: channel.type,
              senderId,
              senderName: senderName || 'Someone',
              content,
            },
          }),
        }).catch((e) => logger.warn({ err: e.message }, 'Failed to post notification for chat'));
      }
      return;
    }

    // 2. Channel messages (COURSE, ORG General, GROUP, ANNOUNCEMENT)
    const mentionMatches = content && content.includes('@') ? content.match(/@([\w.-]+)/g) : null;
    const mentionedUserIds = new Set();

    if (mentionMatches && mentionMatches.length > 0) {
      const cleanedNames = mentionMatches.map((m) => m.slice(1).toLowerCase());
      const hasEveryone = cleanedNames.includes('everyone') || cleanedNames.includes('all');

      members.forEach((m) => {
        if (m.user_id === senderId) return;
        if (
          hasEveryone ||
          cleanedNames.some(
            (name) =>
              (m.name && m.name.toLowerCase().includes(name)) ||
              (m.email && m.email.toLowerCase().includes(name))
          )
        ) {
          mentionedUserIds.add(m.user_id);
        }
      });
    }

    // 2a. Send @Mention notifications to specifically mentioned members
    for (const targetId of mentionedUserIds) {
      fetch('http://localhost:3002/api/v1/internal/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': env.serviceKeySecret,
        },
        body: JSON.stringify({
          tenantId,
          userId: targetId,
          type: 'CHAT_MENTION',
          title: `${senderName || 'Someone'} mentioned you in #${channel.name || 'chat'}`,
          message: content ? (content.length > 80 ? content.slice(0, 77) + '...' : content) : 'Sent an attachment',
          linkUrl,
          data: {
            channelId,
            channelName: channel.name || 'chat',
            channelType: channel.type,
            senderId,
            senderName: senderName || 'Someone',
            content,
          },
        }),
      }).catch((e) => logger.warn({ err: e.message }, 'Failed to post mention notification'));
    }

    // 2b. Broadcast notification to all other channel members (excluding sender, mentioned users, and muted users)
    const channelMembersToNotify = members.filter((m) => {
      if (m.user_id === senderId) return false;
      if (mentionedUserIds.has(m.user_id)) return false;
      const pref = (m.notification_preference || 'ALL').toUpperCase();
      if (pref === 'MUTED' || pref === 'MENTIONS_ONLY') return false;
      return true;
    });

    if (channelMembersToNotify.length > 0) {
      const targetUserIds = channelMembersToNotify.map((m) => m.user_id);
      const channelDisplayName = channel.name || (channel.type === 'ORG' ? 'General' : 'Discussion');
      const channelTitle = channel.type === 'COURSE'
        ? `${senderName || 'Someone'} in [Course] #${channelDisplayName}`
        : `${senderName || 'Someone'} in #${channelDisplayName}`;

      fetch('http://localhost:3002/api/v1/internal/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': env.serviceKeySecret,
        },
        body: JSON.stringify({
          tenantId,
          userIds: targetUserIds,
          type: 'CHAT_CHANNEL',
          title: channelTitle,
          message: content ? (content.length > 80 ? content.slice(0, 77) + '...' : content) : 'Sent an attachment',
          linkUrl,
          data: {
            channelId,
            channelName: channelDisplayName,
            channelType: channel.type,
            senderId,
            senderName: senderName || 'Someone',
            content,
          },
        }),
      }).catch((e) => logger.warn({ err: e.message }, 'Failed to post channel notification'));
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error in notifyMessageRecipient');
  }
}
