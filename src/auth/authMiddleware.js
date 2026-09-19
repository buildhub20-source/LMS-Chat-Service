import { verifyAccessToken } from './jwtService.js';
import { UnauthorizedError } from '../common/errors.js';

/**
 * Express middleware that authenticates requests using the Authorization header
 * or the `token` query parameter.
 *
 * On success, attaches `req.user` with the decoded JWT claims and
 * `req.tenantId` with the tenant UUID.
 */
export function authMiddleware(req, _res, next) {
  const token = extractToken(req);
  try {
    const user = verifyAccessToken(token);
    if (!user.tenantId) {
      throw new UnauthorizedError('Token is missing tenant claim');
    }
    req.user = user;
    req.tenantId = user.tenantId;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Extracts a Bearer token from the Authorization header or query string.
 */
function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Query parameter (used by WebSocket upgrade before Socket.IO handshake)
  if (req.query?.token) {
    return req.query.token;
  }

  return null;
}

export default authMiddleware;
