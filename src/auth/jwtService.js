import jwt from 'jsonwebtoken';
import env from '../config/environment.js';
import { UnauthorizedError } from '../common/errors.js';

/**
 * Claim keys — must match SecurityConstants.java in LMS-BackEnd.
 */
const CLAIMS = Object.freeze({
  USER_ID: 'userId',
  SESSION_ID: 'sessionId',
  TENANT_ID: 'tenantId',
  ROLES: 'roles',
  PERMISSIONS: 'permissions',
  TOKEN_TYPE: 'tokenType',
});

const TOKEN_TYPE_ACCESS = 'ACCESS';

/**
 * Verifies an LMS access JWT using the shared HS256 secret.
 *
 * @param {string} token — Raw JWT string
 * @returns {{ userId: string, sessionId: string, tenantId: string|null, roles: string[], permissions: string[], email: string }}
 * @throws {UnauthorizedError} if the token is invalid, expired, or not an access token
 */
export function verifyAccessToken(token) {
  if (!token) {
    throw new UnauthorizedError('No token provided');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtSecret, {
      issuer: env.jwtIssuer,
      clockTolerance: 30, // seconds — matches JwtConfig.clockSkew
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Token has expired');
    }
    throw new UnauthorizedError('Token is not valid');
  }

  // Must be an access token
  const tokenType = decoded.typ ?? decoded.tokenType;
  if (!tokenType || (tokenType.toLowerCase() !== 'access' && tokenType.toLowerCase() !== 'platform_access')) {
    throw new UnauthorizedError('Expected an access token');
  }

  // Extract required claims
  const userId = decoded.uid ?? decoded.userId ?? decoded.pid ?? decoded.sub;
  const sessionId = decoded.sid ?? decoded.sessionId ?? 'default-session';
  if (!userId) {
    throw new UnauthorizedError('Token is missing required claims');
  }

  return {
    userId,
    sessionId,
    tenantId: decoded.tid ?? decoded.tenantId ?? null,
    roles: decoded.roles ?? [],
    permissions: decoded.permissions ?? [],
    email: decoded.sub, // subject = username/email
  };
}

export default { verifyAccessToken };
