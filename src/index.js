import express from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import env, { isAllowedOrigin } from './config/environment.js';
import logger from './common/logger.js';
import { AppError } from './common/errors.js';
import { authMiddleware } from './auth/authMiddleware.js';
import { tenantMiddleware } from './tenant/tenantMiddleware.js';
import tenantContext from './tenant/tenantContext.js';
import { createSocketServer } from './websocket/socketServer.js';
import { closeAllPools } from './tenant/tenantPool.js';
import connectionManager from './websocket/connectionManager.js';

import channelController from './channels/channelController.js';
import messageController from './messages/messageController.js';

// ─── Express App ───────────────────────────────────────────

const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Rate limiting for REST endpoints
app.use('/api/', rateLimit({
  windowMs: 60_000,
  max: env.rateLimitRequestsPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
}));

// ─── Health Check ──────────────────────────────────────────

app.get('/health', (_req, res) => {
  const stats = connectionManager.getStats();
  res.json({
    status: 'UP',
    service: 'lms-chat-service',
    uptime: process.uptime(),
    connections: stats,
  });
});

// ─── API Routes ────────────────────────────────────────────

import uploadController, { uploadsDir } from './upload/uploadController.js';

// Static file serving for uploads (public for <img> tags)
app.use('/api/v1/chat/uploads', express.static(uploadsDir));

// All chat API routes require authentication + tenant context
app.use('/api/v1/chat', authMiddleware, tenantMiddleware);

app.use('/api/v1/chat/upload', uploadController);
app.use('/api/v1/chat/channels', channelController);
app.use('/api/v1/chat', messageController);

app.get('/api/v1/chat/users', async (req, res, next) => {
  try {
    const pool = tenantContext.getPool();
    const { q } = req.query;
    let query = `
      SELECT id, name, email, profile_image_url
      FROM lms.users
      WHERE is_active = TRUE AND id != $1
    `;
    const params = [req.user.userId];
    if (q?.trim()) {
      query += ` AND (name ILIKE $2 OR email ILIKE $2)`;
      params.push(`%${q.trim()}%`);
    }
    query += ` ORDER BY name ASC LIMIT 50`;
    const result = await pool.query(query, params);
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─── Error Handling ────────────────────────────────────────

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ─── HTTP + WebSocket Server ───────────────────────────────

const server = http.createServer(app);
const io = createSocketServer(server);

// ─── Graceful Shutdown ─────────────────────────────────────

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');

  // Close Socket.IO
  io.close();

  // Close HTTP server
  server.close();

  // Close all tenant DB pools
  await closeAllPools();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ─────────────────────────────────────────────────

server.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, `LMS Chat Service listening on port ${env.port}`);
});
