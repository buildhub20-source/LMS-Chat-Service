import tenantContext from '../tenant/tenantContext.js';
import logger from '../common/logger.js';

/**
 * Audit actions for chat moderation and changes.
 */
export const AUDIT_ACTIONS = Object.freeze({
  MESSAGE_EDITED: 'MESSAGE_EDITED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  MESSAGE_MODERATED: 'MESSAGE_MODERATED',
  CHANNEL_CREATED: 'CHANNEL_CREATED',
  CHANNEL_ARCHIVED: 'CHANNEL_ARCHIVED',
  MEMBER_ADDED: 'MEMBER_ADDED',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
});

/**
 * Logs an audit event to the chat_audit_logs table.
 *
 * @param {Object} params
 * @param {string} params.actorUserId - User who performed the action
 * @param {string} params.action - One of AUDIT_ACTIONS
 * @param {string} [params.channelId] - Related channel
 * @param {string} [params.messageId] - Related message
 * @param {Object} [params.metadata] - Additional context (JSON)
 */
export async function logAuditEvent({ actorUserId, action, channelId, messageId, metadata }) {
  try {
    const pool = tenantContext.getPool();
    await pool.query(
      `INSERT INTO lms.chat_audit_logs (actor_user_id, action, channel_id, message_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorUserId, action, channelId, messageId, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    // Audit logging should never break the main flow
    logger.error({ err, actorUserId, action }, 'Failed to log audit event');
  }
}

export default { logAuditEvent, AUDIT_ACTIONS };
