import 'dotenv/config';

const required = [
  'JWT_SECRET',
  'JWT_ISSUER',
  'LMS_BACKEND_URL',
  'SERVICE_KEY_SECRET',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export const env = Object.freeze({
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',

  // JWT — must match LMS-BackEnd
  jwtSecret: process.env.JWT_SECRET,
  jwtIssuer: process.env.JWT_ISSUER,

  // LMS-BackEnd internal API
  lmsBackendUrl: process.env.LMS_BACKEND_URL,
  serviceKeySecret: process.env.SERVICE_KEY_SECRET,

  // CORS
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim()),

  // Rate limiting
  rateLimitMessagesPerMinute: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE ?? '30', 10),
  rateLimitRequestsPerMinute: parseInt(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE ?? '100', 10),
  messageMaxLength: parseInt(process.env.MESSAGE_MAX_LENGTH ?? '4000', 10),

  // Cloudflare R2 Storage
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKey: process.env.R2_ACCESS_KEY,
    secretKey: process.env.R2_SECRET_KEY,
    bucket: process.env.R2_BUCKET ?? 'buildhub-lms',
    endpoint: process.env.R2_ENDPOINT ?? (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
    publicUrl: (process.env.R2_PUBLIC_URL ?? 'https://pub-2a36fd02f599435bb41928e391c5ac50.r2.dev').replace(/\/+$/, ''),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL ?? 'info',
});

/**
 * Validates whether an incoming HTTP Origin or Socket.IO origin is permitted.
 * Allows configured origins, plus any localhost subdomain on any port.
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (env.corsAllowedOrigins.includes(origin)) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

export default env;
