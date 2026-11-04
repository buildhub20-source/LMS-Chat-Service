import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from '../common/logger.js';

/**
 * Connects Socket.IO to Redis so that with more than one chat-service copy a
 * message sent through copy A still reaches users connected to copy B.
 *
 * Does nothing when REDIS_URL is not set (a single copy needs no adapter).
 *
 * @param {import('socket.io').Server} io
 * @param {string | undefined} redisUrl
 * @returns {Promise<() => Promise<void>>} closes the Redis connections
 */
export async function attachRedisAdapter(io, redisUrl) {
  if (!redisUrl) {
    logger.info('REDIS_URL not set; Socket.IO runs in single-instance mode');
    return async () => {};
  }

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();
  for (const client of [pubClient, subClient]) {
    client.on('error', (err) => logger.error({ err: err.message }, 'Redis client error'));
  }

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO Redis adapter attached');

  return async () => {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  };
}

export default attachRedisAdapter;
