import { verifyAccessToken } from '../auth/jwtService.js';
import { getPool } from '../tenant/tenantPool.js';
import logger from '../common/logger.js';

/**
 * Socket.IO authentication middleware.
 * Runs during the handshake to verify the JWT and resolve the tenant pool.
 *
 * After successful auth, attaches to socket:
 *   socket.user   = { userId, sessionId, tenantId, roles, permissions, email }
 *   socket.pool   = pg.Pool for the tenant
 */
export async function socketAuth(socket, next) {
  try {
    // Extract token from handshake auth or query
    const token = socket.handshake.auth?.token ?? socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    // Verify JWT
    const user = verifyAccessToken(token);
    if (!user.tenantId) {
      return next(new Error('Token is missing tenant claim'));
    }

    // Resolve tenant DB pool
    const pool = await getPool(user.tenantId);

    // Attach to socket for use in event handlers
    socket.user = user;
    socket.pool = pool;

    logger.debug({ userId: user.userId, tenantId: user.tenantId }, 'Socket authenticated');
    next();
  } catch (err) {
    logger.warn({ err: err.message }, 'Socket auth failed');
    next(new Error(err.message || 'Authentication failed'));
  }
}

export default socketAuth;
