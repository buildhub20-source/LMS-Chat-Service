import tenantContext from '../tenant/tenantContext.js';
import { getReactionsByMessageIds } from './reactionRepository.js';

/** SQL queries for chat_messages. */

/**
 * Inserts a new message. If client_message_id already exists, returns the
 * existing message (idempotent).
 */
export async function createMessage({ channelId, senderId, content, messageType = 'TEXT', replyToMessageId, clientMessageId, attachments = [] }) {
  const pool = tenantContext.getPool();

  // Idempotency: check if clientMessageId already exists
  if (clientMessageId) {
    const existing = await pool.query(
      `SELECT m.*,
              u.email AS sender_email,
              u.name AS sender_name,
              rm.content AS reply_to_content,
              rm.sender_id AS reply_to_sender_id,
              ru.name AS reply_to_sender_name,
              ru.email AS reply_to_sender_email
       FROM lms.chat_messages m
       LEFT JOIN lms.users u ON u.id = m.sender_id
       LEFT JOIN lms.chat_messages rm ON rm.id = m.reply_to_message_id
       LEFT JOIN lms.users ru ON ru.id = rm.sender_id
       WHERE m.channel_id = $1 AND m.client_message_id = $2`,
      [channelId, clientMessageId]
    );
    if (existing.rows.length > 0) {
      return { message: existing.rows[0], isDuplicate: true };
    }
  }

  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO lms.chat_messages (channel_id, sender_id, content, message_type, reply_to_message_id, client_message_id, attachments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *
     )
     SELECT inserted.*,
            u.email AS sender_email,
            u.name AS sender_name,
            rm.content AS reply_to_content,
            rm.sender_id AS reply_to_sender_id,
            ru.name AS reply_to_sender_name,
            ru.email AS reply_to_sender_email
     FROM inserted
     LEFT JOIN lms.users u ON u.id = inserted.sender_id
     LEFT JOIN lms.chat_messages rm ON rm.id = inserted.reply_to_message_id
     LEFT JOIN lms.users ru ON ru.id = rm.sender_id`,
    [channelId, senderId, content, messageType, replyToMessageId, clientMessageId, JSON.stringify(attachments || [])]
  );
  return { message: result.rows[0], isDuplicate: false };
}

/**
 * Finds a message by ID.
 */
export async function findMessageById(messageId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT * FROM lms.chat_messages WHERE id = $1`,
    [messageId]
  );
  return result.rows[0] ?? null;
}

/**
 * Fetches message history for a channel with cursor-based pagination.
 *
 * @param {string} channelId
 * @param {Object} opts
 * @param {string} [opts.before] - Cursor: messages before this message ID
 * @param {number} [opts.limit=50] - Max messages to return
 */
export async function findMessages(channelId, { before, limit = 50 } = {}) {
  const pool = tenantContext.getPool();
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  let query;
  let params;

  if (before) {
    query = `
      SELECT m.*,
             u.email AS sender_email,
             u.name AS sender_name,
             rm.content AS reply_to_content,
             rm.sender_id AS reply_to_sender_id,
             ru.name AS reply_to_sender_name,
             ru.email AS reply_to_sender_email
      FROM lms.chat_messages m
      LEFT JOIN lms.users u ON u.id = m.sender_id
      LEFT JOIN lms.chat_messages rm ON rm.id = m.reply_to_message_id
      LEFT JOIN lms.users ru ON ru.id = rm.sender_id
      WHERE m.channel_id = $1
        AND m.created_at < (SELECT created_at FROM lms.chat_messages WHERE id = $2)
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    params = [channelId, before, safeLimit];
  } else {
    query = `
      SELECT m.*,
             u.email AS sender_email,
             u.name AS sender_name,
             rm.content AS reply_to_content,
             rm.sender_id AS reply_to_sender_id,
             ru.name AS reply_to_sender_name,
             ru.email AS reply_to_sender_email
      FROM lms.chat_messages m
      LEFT JOIN lms.users u ON u.id = m.sender_id
      LEFT JOIN lms.chat_messages rm ON rm.id = m.reply_to_message_id
      LEFT JOIN lms.users ru ON ru.id = rm.sender_id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2
    `;
    params = [channelId, safeLimit];
  }

  const result = await pool.query(query, params);
  const rows = result.rows.reverse();

  if (rows.length > 0) {
    const messageIds = rows.map((r) => r.id);
    const reactionsMap = await getReactionsByMessageIds(messageIds);
    for (const r of rows) {
      r.reactions = reactionsMap[r.id] || [];
    }
  }

  return rows;
}

/**
 * Fetches messages after a given message ID (for reconnect/missed messages).
 */
export async function findMessagesAfter(channelId, afterMessageId, limit = 200) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT m.*,
            u.email AS sender_email,
            u.name AS sender_name,
            rm.content AS reply_to_content,
            rm.sender_id AS reply_to_sender_id,
            ru.name AS reply_to_sender_name,
            ru.email AS reply_to_sender_email
     FROM lms.chat_messages m
     LEFT JOIN lms.users u ON u.id = m.sender_id
     LEFT JOIN lms.chat_messages rm ON rm.id = m.reply_to_message_id
     LEFT JOIN lms.users ru ON ru.id = rm.sender_id
     WHERE m.channel_id = $1
       AND m.created_at > (SELECT created_at FROM lms.chat_messages WHERE id = $2)
     ORDER BY m.created_at ASC
     LIMIT $3`,
    [channelId, afterMessageId, limit]
  );

  const rows = result.rows;
  if (rows.length > 0) {
    const messageIds = rows.map((r) => r.id);
    const reactionsMap = await getReactionsByMessageIds(messageIds);
    for (const r of rows) {
      r.reactions = reactionsMap[r.id] || [];
    }
  }

  return rows;
}

/**
 * Edits a message's content. Only the sender can edit.
 */
export async function editMessage(messageId, senderId, newContent) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `UPDATE lms.chat_messages
     SET content = $3, edited_at = now()
     WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [messageId, senderId, newContent]
  );
  return result.rows[0] ?? null;
}

/**
 * Soft-deletes a message.
 * @param {string} messageId
 * @param {string} deletedBy - The user performing the deletion
 * @param {string} senderId  - The message's original sender (null = admin/mod delete)
 * @param {boolean} isModerator - If true, allows deleting other users' messages
 */
export async function softDeleteMessage(messageId, deletedBy, senderId, isModerator = false) {
  const pool = tenantContext.getPool();

  let query;
  let params;

  if (isModerator) {
    // Moderators/admins can delete any message
    query = `UPDATE lms.chat_messages SET deleted_at = now(), deleted_by = $2, content = '[Message deleted]'
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`;
    params = [messageId, deletedBy];
  } else {
    // Users can only delete their own messages
    query = `UPDATE lms.chat_messages SET deleted_at = now(), deleted_by = $2, content = '[Message deleted]'
             WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING *`;
    params = [messageId, deletedBy];
  }

  const result = await pool.query(query, params);
  return result.rows[0] ?? null;
}

/**
 * Counts unread messages for a user in a channel.
 */
export async function countUnreadMessages(channelId, lastReadMessageId) {
  const pool = tenantContext.getPool();

  if (!lastReadMessageId) {
    // Never read — count all messages
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM lms.chat_messages WHERE channel_id = $1 AND deleted_at IS NULL`,
      [channelId]
    );
    return result.rows[0].count;
  }

  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM lms.chat_messages
     WHERE channel_id = $1
       AND deleted_at IS NULL
       AND created_at > (SELECT created_at FROM lms.chat_messages WHERE id = $2)`,
    [channelId, lastReadMessageId]
  );
  return result.rows[0].count;
}

/**
 * Gets the latest message for a channel (for channel list preview).
 */
export async function findLatestMessage(channelId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT * FROM lms.chat_messages WHERE channel_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [channelId]
  );
  return result.rows[0] ?? null;
}

/**
 * Searches messages by content, either within a specific channel or across all channels the user belongs to.
 */
export async function searchMessages({ query, channelId = null, userId, limit = 25 }) {
  const pool = tenantContext.getPool();
  const searchPattern = `%${query}%`;

  if (channelId) {
    const result = await pool.query(
      `SELECT m.*,
              c.name AS channel_name,
              c.type AS channel_type,
              u.name AS sender_name,
              u.email AS sender_email
       FROM lms.chat_messages m
       JOIN lms.chat_channels c ON c.id = m.channel_id
       JOIN lms.chat_channel_members ccm ON ccm.channel_id = c.id AND ccm.user_id = $3 AND ccm.left_at IS NULL
       LEFT JOIN lms.users u ON u.id = m.sender_id
       WHERE m.channel_id = $1
         AND m.content ILIKE $2
         AND m.deleted_at IS NULL
         AND c.is_archived = FALSE
       ORDER BY m.created_at DESC
       LIMIT $4`,
      [channelId, searchPattern, userId, limit]
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT m.*,
            c.name AS channel_name,
            c.type AS channel_type,
            CASE 
              WHEN c.type = 'DIRECT' THEN (
                SELECT COALESCE(other_u.name, split_part(other_u.email, '@', 1))
                FROM lms.chat_channel_members other_m
                JOIN lms.users other_u ON other_u.id = other_m.user_id
                WHERE other_m.channel_id = c.id AND other_m.user_id != $2 AND other_m.left_at IS NULL
                LIMIT 1
              )
              ELSE c.name
            END AS channel_display_name,
            u.name AS sender_name,
            u.email AS sender_email
     FROM lms.chat_messages m
     JOIN lms.chat_channels c ON c.id = m.channel_id
     JOIN lms.chat_channel_members ccm ON ccm.channel_id = c.id AND ccm.user_id = $2 AND ccm.left_at IS NULL
     LEFT JOIN lms.users u ON u.id = m.sender_id
     WHERE m.content ILIKE $1
       AND m.deleted_at IS NULL
       AND c.is_archived = FALSE
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [searchPattern, userId, limit]
  );
  return result.rows;
}

