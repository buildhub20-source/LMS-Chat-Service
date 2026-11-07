import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import env from '../config/environment.js';
import logger from '../common/logger.js';

/**
 * Redis connections for running more than one copy of the chat service.
 *
 * With REDIS_ENABLED=false (the default) nothing here connects and the service
 * behaves as a single copy. With it on, Socket.IO passes events between copies
 * through Redis, and the daily cleanup job takes a Redis lock.
 *
 * If Redis cannot be reached at startup the service still starts, as a single
 * copy, and logs an error: users connected to this copy keep chatting with each
 * other rather than nobody being able to connect at all.
 */

const CONNECT_TIMEOUT_MS = 5_000;

/** @type {import('redis').RedisClientType | null} */
let pubClient = null;
/** @type {import('redis').RedisClientType | null} */
let subClient = null;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Connects to Redis when enabled.
 * @returns {Promise<ReturnType<typeof createAdapter> | null>} a Socket.IO adapter, or null for single-copy mode
 */
export async function connectRedis() {
  if (!env.redis.enabled) {
    logger.info('Redis disabled: running as a single copy');
    return null;
  }

  const pub = createClient({
    url: env.redis.url,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Keep retrying after a drop, backing off to 5 s; the adapter resumes once back.
      reconnectStrategy: (retries) => Math.min(retries * 200, 5_000),
    },
  });
  const sub = pub.duplicate();
  // Without listeners, a dropped connection would crash the process.
  pub.on('error', (err) => logger.warn({ err: err.message }, 'Redis publisher error'));
  sub.on('error', (err) => logger.warn({ err: err.message }, 'Redis subscriber error'));

  try {
    await withTimeout(Promise.all([pub.connect(), sub.connect()]), CONNECT_TIMEOUT_MS, 'Redis connect');
  } catch (err) {
    logger.error({ err: err.message }, 'Redis unreachable at startup: running as a single copy');
    pub.destroy();
    sub.destroy();
    return null;
  }

  pubClient = pub;
  subClient = sub;
  logger.info('Redis connected: chat events are shared across copies');
  return createAdapter(pub, sub, { key: `${env.redis.keyPrefix}socket.io` });
}

/**
 * Runs `task` on one copy only, for jobs that every copy schedules. Without
 * Redis it always runs (single copy). The lock is never released early: it
 * simply expires after `holdMs`, so set that a little below the job interval.
 *
 * @param {string} name
 * @param {number} holdMs
 * @param {() => Promise<unknown>} task
 * @returns {Promise<boolean>} whether this copy ran the task
 */
export async function runOnOneCopy(name, holdMs, task) {
  if (pubClient) {
    let acquired;
    try {
      acquired = await pubClient.set(`${env.redis.keyPrefix}lock:${name}`, String(process.pid), {
        condition: 'NX',
        expiration: { type: 'PX', value: holdMs },
      });
    } catch (err) {
      // The job is idempotent; running it twice beats not running it.
      logger.warn({ err: err.message, job: name }, 'Redis lock unavailable: running job on this copy');
      acquired = 'OK';
    }
    if (acquired !== 'OK') {
      logger.info({ job: name }, 'Another copy is running this job');
      return false;
    }
  }
  await task();
  return true;
}

/**
 * Closes the Redis connections, if any. Pass the Socket.IO server so its adapter
 * finishes unsubscribing first: closing the clients under it makes those calls
 * reject ("The client is closed") and the process exit with an error.
 *
 * @param {import('socket.io').Server} [io]
 */
export async function closeRedis(io) {
  if (io && pubClient) {
    await Promise.allSettled([io.of('/').adapter.close()]);
  }
  const clients = [pubClient, subClient].filter(Boolean);
  pubClient = null;
  subClient = null;
  await Promise.allSettled(clients.map((client) => client.close()));
}
