import tenantContext from '../tenant/tenantContext.js';

/**
 * SQL queries for chat_pinned_messages.
 */

export async function pinMessage(channelId, messageId, pinnedBy) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `INSERT INTO lms.chat_pinned_messages (channel_id, message_id, pinned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_id, message_id) DO UPDATE SET pinned_at = now()
     RETURNING *`,
    [channelId, messageId, pinnedBy]
  );
  return result.rows[0];
}

export async function unpinMessage(channelId, messageId) {
  const pool = tenantContext.getPool();
  await pool.query(
    `DELETE FROM lms.chat_pinned_messages WHERE channel_id = $1 AND message_id = $2`,
    [channelId, messageId]
  );
}

export async function getPinnedMessages(channelId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT p.id as pin_id, p.pinned_at, p.pinned_by,
            pu.name as pinned_by_name, pu.email as pinned_by_email,
            m.id as message_id, m.content, m.sender_id, m.created_at, m.message_type,
            su.name as sender_name, su.email as sender_email
     FROM lms.chat_pinned_messages p
     JOIN lms.chat_messages m ON m.id = p.message_id
     LEFT JOIN lms.users pu ON pu.id = p.pinned_by
     LEFT JOIN lms.users su ON su.id = m.sender_id
     WHERE p.channel_id = $1 AND m.deleted_at IS NULL
     ORDER BY p.pinned_at DESC`,
    [channelId]
  );
  return result.rows;
}

export async function isPinned(channelId, messageId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT 1 FROM lms.chat_pinned_messages WHERE channel_id = $1 AND message_id = $2`,
    [channelId, messageId]
  );
  return result.rows.length > 0;
}
