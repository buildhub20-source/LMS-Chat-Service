import tenantContext from '../tenant/tenantContext.js';

/** SQL queries for chat_channels and chat_channel_members. */

/**
 * Creates a new channel.
 */
export async function createChannel({ type, name, description, courseId, createdBy }) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `INSERT INTO lms.chat_channels (type, name, description, course_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [type, name, description, courseId, createdBy]
  );
  return result.rows[0];
}

/**
 * Finds a channel by ID, optionally enriched with display_name for the requesting user.
 */
export async function findChannelById(channelId, userId = null) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT 
       c.*,
       CASE 
         WHEN c.type = 'DIRECT' AND $2::uuid IS NOT NULL THEN (
           SELECT COALESCE(u.name, split_part(u.email, '@', 1))
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $2::uuid AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE c.name
       END AS display_name,
       CASE 
         WHEN c.type = 'DIRECT' AND $2::uuid IS NOT NULL THEN (
           SELECT COALESCE(u.name, split_part(u.email, '@', 1))
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $2::uuid AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS other_user_name,
       CASE 
         WHEN c.type = 'DIRECT' AND $2::uuid IS NOT NULL THEN (
           SELECT other_m.user_id
           FROM lms.chat_channel_members other_m
           WHERE other_m.channel_id = c.id AND other_m.user_id != $2::uuid AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS other_user_id,
       CASE 
         WHEN c.type = 'DIRECT' AND $2::uuid IS NOT NULL THEN (
           SELECT u.email
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $2::uuid AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS direct_user_email
     FROM lms.chat_channels c
     WHERE c.id = $1`,
    [channelId, userId]
  );
  const row = result.rows[0] ?? null;
  if (!row) return null;
  return {
    ...row,
    displayName: row.display_name,
    otherUserName: row.other_user_name || row.display_name,
    otherUserId: row.other_user_id,
    directUserEmail: row.direct_user_email,
    isArchived: row.is_archived,
    courseId: row.course_id,
    createdBy: row.created_by,
  };
}

/**
 * Finds the ORG General channel (there should be exactly one per tenant).
 */
export async function findOrgGeneralChannel() {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT * FROM lms.chat_channels WHERE type = 'ORG' AND name = 'General' AND is_archived = FALSE LIMIT 1`
  );
  return result.rows[0] ?? null;
}

/**
 * Finds a DIRECT channel between exactly two users.
 */
export async function findDirectChannel(userId1, userId2) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT c.* FROM lms.chat_channels c
     WHERE c.type = 'DIRECT' AND c.is_archived = FALSE
       AND (SELECT COUNT(*) FROM lms.chat_channel_members m WHERE m.channel_id = c.id AND m.left_at IS NULL) = 2
       AND EXISTS (SELECT 1 FROM lms.chat_channel_members m WHERE m.channel_id = c.id AND m.user_id = $1 AND m.left_at IS NULL)
       AND EXISTS (SELECT 1 FROM lms.chat_channel_members m WHERE m.channel_id = c.id AND m.user_id = $2 AND m.left_at IS NULL)
     LIMIT 1`,
    [userId1, userId2]
  );
  return result.rows[0] ?? null;
}

/**
 * Finds a COURSE channel by course ID.
 */
export async function findCourseChannel(courseId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT * FROM lms.chat_channels WHERE type = 'COURSE' AND course_id = $1 AND is_archived = FALSE LIMIT 1`,
    [courseId]
  );
  return result.rows[0] ?? null;
}

/**
 * Lists all channels the user is a member of.
 */
export async function findChannelsByUserId(userId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT 
       c.*,
       m.role AS member_role,
       m.notification_preference,
       m.last_read_message_id,
       m.joined_at AS member_joined_at,
       CASE 
         WHEN c.type = 'DIRECT' THEN (
           SELECT COALESCE(u.name, split_part(u.email, '@', 1))
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $1 AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE c.name
       END AS display_name,
       CASE 
         WHEN c.type = 'DIRECT' THEN (
           SELECT COALESCE(u.name, split_part(u.email, '@', 1))
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $1 AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS other_user_name,
       CASE 
         WHEN c.type = 'DIRECT' THEN (
           SELECT other_m.user_id
           FROM lms.chat_channel_members other_m
           WHERE other_m.channel_id = c.id AND other_m.user_id != $1 AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS other_user_id,
       CASE 
         WHEN c.type = 'DIRECT' THEN (
           SELECT u.email
           FROM lms.chat_channel_members other_m
           JOIN lms.users u ON u.id = other_m.user_id
           WHERE other_m.channel_id = c.id AND other_m.user_id != $1 AND other_m.left_at IS NULL
           LIMIT 1
         )
         ELSE NULL
       END AS direct_user_email
     FROM lms.chat_channels c
     INNER JOIN lms.chat_channel_members m ON m.channel_id = c.id
     WHERE m.user_id = $1 AND m.left_at IS NULL AND c.is_archived = FALSE
     ORDER BY c.updated_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    ...row,
    displayName: row.display_name,
    otherUserName: row.other_user_name || row.display_name,
    otherUserId: row.other_user_id,
    directUserEmail: row.direct_user_email,
    isArchived: row.is_archived,
    courseId: row.course_id,
    createdBy: row.created_by,
  }));
}

/**
 * Adds a member to a channel. Returns the membership row.
 * Uses ON CONFLICT to handle re-joins (clears left_at).
 */
export async function addMember(channelId, userId, role = 'MEMBER') {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `INSERT INTO lms.chat_channel_members (channel_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_id, user_id) DO UPDATE SET left_at = NULL, role = $3, joined_at = now()
     RETURNING *`,
    [channelId, userId, role]
  );
  return result.rows[0];
}

/**
 * Removes a member from a channel (soft: sets left_at).
 */
export async function removeMember(channelId, userId) {
  const pool = tenantContext.getPool();
  await pool.query(
    `UPDATE lms.chat_channel_members SET left_at = now() WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [channelId, userId]
  );
}

/**
 * Checks if a user is an active member of a channel.
 */
export async function isMember(channelId, userId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT 1 FROM lms.chat_channel_members WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [channelId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Lists active members of a channel with user details.
 */
export async function findMembers(channelId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT m.*,
            u.name,
            u.email,
            COALESCE(u.name, split_part(u.email, '@', 1)) AS display_name
     FROM lms.chat_channel_members m
     LEFT JOIN lms.users u ON u.id = m.user_id
     WHERE m.channel_id = $1 AND m.left_at IS NULL
     ORDER BY m.joined_at`,
    [channelId]
  );
  return result.rows;
}

/**
 * Gets a member record.
 */
export async function findMember(channelId, userId) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `SELECT * FROM lms.chat_channel_members WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [channelId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Updates last_read_message_id for a member.
 */
export async function updateLastReadMessage(channelId, userId, messageId) {
  const pool = tenantContext.getPool();
  await pool.query(
    `UPDATE lms.chat_channel_members SET last_read_message_id = $3
     WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [channelId, userId, messageId]
  );
}

/**
 * Updates the channel's updated_at timestamp (used when new messages arrive).
 */
export async function touchChannel(channelId) {
  const pool = tenantContext.getPool();
  await pool.query(
    `UPDATE lms.chat_channels SET updated_at = now() WHERE id = $1`,
    [channelId]
  );
}

/**
 * Updates channel name and/or description.
 */
export async function updateChannel(channelId, { name, description }) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `UPDATE lms.chat_channels
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [channelId, name, description]
  );
  return result.rows[0] ?? null;
}

/**
 * Sets archive status for a channel.
 */
export async function setChannelArchived(channelId, isArchived) {
  const pool = tenantContext.getPool();
  const result = await pool.query(
    `UPDATE lms.chat_channels
     SET is_archived = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [channelId, isArchived]
  );
  return result.rows[0] ?? null;
}

/**
 * Archives a channel.
 */
export async function archiveChannel(channelId) {
  return setChannelArchived(channelId, true);
}
