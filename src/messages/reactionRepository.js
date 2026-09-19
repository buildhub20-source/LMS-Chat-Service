import tenantContext from '../tenant/tenantContext.js';

/**
 * SQL queries for chat_message_reactions.
 */

/**
 * Toggles a reaction for a user on a message.
 * Returns { added: boolean, reaction: string, messageId: string }
 */
export async function toggleReaction(messageId, userId, reaction) {
  const pool = tenantContext.getPool();

  // Check if user already reacted with this emoji
  const existing = await pool.query(
    `SELECT id FROM lms.chat_message_reactions
     WHERE message_id = $1 AND user_id = $2 AND reaction = $3`,
    [messageId, userId, reaction]
  );

  if (existing.rows.length > 0) {
    // Remove reaction
    await pool.query(
      `DELETE FROM lms.chat_message_reactions WHERE id = $1`,
      [existing.rows[0].id]
    );
    return { added: false, reaction, messageId, userId };
  } else {
    // Add reaction
    await pool.query(
      `INSERT INTO lms.chat_message_reactions (message_id, user_id, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, reaction) DO NOTHING`,
      [messageId, userId, reaction]
    );
    return { added: true, reaction, messageId, userId };
  }
}

/**
 * Gets aggregated reactions for an array of message IDs.
 * Returns map of messageId -> [{ reaction, count, userIds }]
 */
export async function getReactionsByMessageIds(messageIds) {
  if (!messageIds || messageIds.length === 0) return {};

  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT r.message_id, r.reaction, COUNT(*)::int as count,
            ARRAY_AGG(r.user_id::text) as user_ids,
            ARRAY_AGG(COALESCE(u.name, split_part(u.email, '@', 1))) as user_names
     FROM lms.chat_message_reactions r
     LEFT JOIN lms.users u ON u.id = r.user_id
     WHERE r.message_id = ANY($1::uuid[])
     GROUP BY r.message_id, r.reaction
     ORDER BY MIN(r.created_at) ASC`,
    [messageIds]
  );

  const map = {};
  for (const row of result.rows) {
    if (!map[row.message_id]) {
      map[row.message_id] = [];
    }
    map[row.message_id].push({
      reaction: row.reaction,
      count: row.count,
      userIds: row.user_ids || [],
      userNames: row.user_names || [],
    });
  }

  return map;
}

/**
 * Removes all reactions for a message (used on hard delete).
 */
export async function clearReactions(messageId) {
  const pool = tenantContext.getPool();
  await pool.query(
    `DELETE FROM lms.chat_message_reactions WHERE message_id = $1`,
    [messageId]
  );
}
