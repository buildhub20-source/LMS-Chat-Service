import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { registerSocketHandlers, onlineUserIds, countUserSockets } from '../src/websocket/socketHandlers.js';

/** A database that has nothing in it; enough for the connection handlers to run. */
const emptyDb = { query: async () => ({ rows: [] }) };

/**
 * One copy of the chat socket server. Real handlers; the JWT check is replaced
 * by reading the user from the handshake, since tokens are not what is tested.
 */
async function startCopy(adapter) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, adapter ? { adapter } : {});
  io.use((socket, next) => {
    const { userId, tenantId } = socket.handshake.auth;
    socket.user = { userId, tenantId, email: `${userId}@example.test`, roles: ['STUDENT'] };
    socket.pool = emptyDb;
    next();
  });
  io.on('connection', (socket) => registerSocketHandlers(io, socket));
  await new Promise((resolve) => httpServer.listen(0, resolve));
  return { io, url: `http://localhost:${httpServer.address().port}`, close: () => io.close() };
}

const clients = [];
function connect(url, userId, tenantId) {
  const client = connectClient(url, { auth: { userId, tenantId }, transports: ['websocket'], forceNew: true });
  clients.push(client);
  return new Promise((resolve) => client.on('connect', () => resolve(client)));
}

/** Collects user_presence events a client receives. */
function presenceLog(client) {
  const events = [];
  client.on('user_presence', (e) => events.push(e));
  return events;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

after(() => clients.forEach((c) => c.disconnect()));

describe('presence', () => {
  it('announces a user only inside their own institute', async () => {
    const copy = await startCopy();
    const watcherA = await connect(copy.url, 'watcher-a', 'tenant-a');
    const watcherB = await connect(copy.url, 'watcher-b', 'tenant-b');
    const seenA = presenceLog(watcherA);
    const seenB = presenceLog(watcherB);

    await connect(copy.url, 'student-1', 'tenant-a');
    await settle();

    assert.ok(seenA.some((e) => e.userId === 'student-1' && e.status === 'ONLINE'));
    assert.equal(seenB.length, 0, 'another institute must not see this user come online');
    copy.close();
  });

  it('stays online until the last device disconnects', async () => {
    const copy = await startCopy();
    const watcher = await connect(copy.url, 'watcher', 'tenant-a');
    const phone = await connect(copy.url, 'student-2', 'tenant-a');
    const laptop = await connect(copy.url, 'student-2', 'tenant-a');
    const seen = presenceLog(watcher);

    assert.equal(await countUserSockets(copy.io, 'tenant-a', 'student-2'), 2);
    assert.deepEqual((await onlineUserIds(copy.io, 'tenant-a')).sort(), ['student-2', 'watcher']);

    phone.disconnect();
    await settle();
    assert.ok(!seen.some((e) => e.status === 'OFFLINE'), 'one device is still connected');

    laptop.disconnect();
    await settle();
    assert.ok(seen.some((e) => e.userId === 'student-2' && e.status === 'OFFLINE' && e.lastSeen));
    copy.close();
  });

  it('does not ask other copies about presence while shutting down', async () => {
    // With Redis, those questions would go out after the Redis connection is
    // closed and crash the shutdown (seen in CI).
    const copy = await startCopy();
    await connect(copy.url, 'student-4', 'tenant-a');
    await connect(copy.url, 'student-5', 'tenant-a');
    await settle();

    const adapter = copy.io.of('/').adapter;
    const original = adapter.fetchSockets.bind(adapter);
    let lookups = 0;
    adapter.fetchSockets = (opts) => {
      lookups++;
      return original(opts);
    };

    copy.close();
    await settle();
    assert.equal(lookups, 0);
  });
});

// Two copies sharing a real Redis. Runs when TEST_REDIS_URL is set, e.g.
//   docker run --rm -p 6390:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://localhost:6390 npm test
const redisUrl = process.env.TEST_REDIS_URL;

describe('two copies through Redis', { skip: !redisUrl && 'set TEST_REDIS_URL to run' }, () => {
  it('shares presence between users connected to different copies', async () => {
    const redisClients = [];
    const adapterFor = async () => {
      const pub = createClient({ url: redisUrl });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      redisClients.push(pub, sub);
      return createAdapter(pub, sub, { key: `test-${process.pid}` });
    };
    const copy1 = await startCopy(await adapterFor());
    const copy2 = await startCopy(await adapterFor());

    try {
      const teacher = await connect(copy1.url, 'teacher', 'tenant-a');
      const seen = presenceLog(teacher);

      const student = await connect(copy2.url, 'student-3', 'tenant-a');
      await settle(300);
      assert.ok(seen.some((e) => e.userId === 'student-3' && e.status === 'ONLINE'),
        'copy 1 hears a user who connected to copy 2');
      assert.deepEqual((await onlineUserIds(copy1.io, 'tenant-a')).sort(), ['student-3', 'teacher'],
        'copy 1 lists users connected to copy 2');

      student.disconnect();
      await settle(300);
      assert.ok(seen.some((e) => e.userId === 'student-3' && e.status === 'OFFLINE'),
        'copy 1 hears the user leave copy 2');
    } finally {
      // Same order as the service's shutdown: let each adapter finish
      // unsubscribing before its Redis clients are closed.
      copy1.close();
      copy2.close();
      await Promise.allSettled([copy1, copy2].map((c) => c.io.of('/').adapter.close()));
      await Promise.allSettled(redisClients.map((c) => c.close()));
    }
  });
});
