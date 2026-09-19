import { Server } from 'socket.io';
import { socketAuth } from './socketAuth.js';
import { registerSocketHandlers } from './socketHandlers.js';
import env, { isAllowedOrigin } from '../config/environment.js';
import logger from '../common/logger.js';

/**
 * Creates and configures the Socket.IO server.
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, origin || true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    },
    // Connection settings
    pingTimeout: 30_000,
    pingInterval: 25_000,
    connectTimeout: 10_000,
    // Allow binary
    maxHttpBufferSize: 1e6, // 1MB
  });

  // Authentication middleware — runs before any event handler
  io.use(socketAuth);

  // Register handlers for each new connection
  io.on('connection', (socket) => {
    registerSocketHandlers(io, socket);
  });

  logger.info('Socket.IO server initialized');
  return io;
}

export default createSocketServer;
