import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import tenantContext from '../src/tenant/tenantContext.js';
import { tenantMiddleware } from '../src/tenant/tenantMiddleware.js';
import { sendMessage, getMessages } from '../src/messages/messageService.js';

/** In-memory stand-in for one tenant's database, answering only the queries these flows issue. */
const fakeTenantDb = (members) => {
  const messages = [];
  return {
    messages,
    async query(sql, params = []) {
      if (sql.includes('FROM lms.chat_channel_members') && sql.includes('SELECT 1')) {
        const [channelId, userId] = params;
        return { rows: members.some((m) => m.channelId === channelId && m.userId === userId) ? [{}] : [] };
      }
      if (sql.includes('INSERT INTO lms.chat_messages')) {
        const [channelId, senderId, content, messageType] = params;
        const row = { id: `m${messages.length + 1}`, channel_id: channelId, sender_id: senderId, content, message_type: messageType };
        messages.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE lms.chat_channels')) return { rows: [] };
      if (sql.includes('FROM lms.chat_messages m') || sql.includes('FROM lms.chat_messages')) {
        return { rows: messages.filter((m) => m.channel_id === params[0]) };
      }
      return { rows: [] };
    },
  };
};

const inTenant = (tenantId, pool, fn) => tenantContext.run({ tenantId, pool }, fn);

describe('messaging', () => {
  it('stores a message sent by a channel member and returns it in history', async () => {
    const db = fakeTenantDb([{ channelId: 'c1', userId: 'u1' }]);

    const { message } = await inTenant('tenant-a', db, () =>
      sendMessage({ channelId: 'c1', senderId: 'u1', content: '  hello class  ' }));
    assert.equal(message.content, 'hello class');

    const history = await inTenant('tenant-a', db, () => getMessages('c1', 'u1'));
    const items = history.messages ?? history.items ?? history;
    assert.ok(JSON.stringify(items).includes('hello class'));
  });

  it('refuses a sender who is not a member of the channel', async () => {
    const db = fakeTenantDb([]);
    await assert.rejects(
      inTenant('tenant-a', db, () => sendMessage({ channelId: 'c1', senderId: 'u1', content: 'hi' })),
      (err) => err.statusCode === 403,
    );
    assert.equal(db.messages.length, 0);
  });

  it('rejects an empty message', async () => {
    const db = fakeTenantDb([{ channelId: 'c1', userId: 'u1' }]);
    await assert.rejects(
      inTenant('tenant-a', db, () => sendMessage({ channelId: 'c1', senderId: 'u1', content: '   ' })),
      (err) => err.statusCode === 400,
    );
  });

  it("writes only to the requesting tenant's database", async () => {
    const tenantA = fakeTenantDb([{ channelId: 'c1', userId: 'u1' }]);
    const tenantB = fakeTenantDb([{ channelId: 'c1', userId: 'u1' }]);

    await Promise.all([
      inTenant('tenant-a', tenantA, () => sendMessage({ channelId: 'c1', senderId: 'u1', content: 'for A' })),
      inTenant('tenant-b', tenantB, () => sendMessage({ channelId: 'c1', senderId: 'u1', content: 'for B' })),
    ]);

    assert.deepEqual(tenantA.messages.map((m) => m.content), ['for A']);
    assert.deepEqual(tenantB.messages.map((m) => m.content), ['for B']);
  });

  it('refuses database access outside a tenant context', async () => {
    await assert.rejects(sendMessage({ channelId: 'c1', senderId: 'u1', content: 'hi' }));
  });
});

describe('tenantMiddleware', () => {
  it('rejects a request that carries no tenant', async () => {
    let status;
    let nextCalled = false;
    const res = { status: (code) => { status = code; return { json: () => {} }; } };
    await tenantMiddleware({}, res, () => { nextCalled = true; });

    assert.equal(status, 400);
    assert.equal(nextCalled, false);
  });
});

describe('reactions', () => {
  it('rejects a reaction outside the supported set before touching the database', async () => {
    const { toggleReaction } = await import('../src/messages/reactionService.js');
    await assert.rejects(toggleReaction('m1', 'u1', '<img src=x onerror=alert(1)>'), (err) => err.statusCode === 400);
  });
});
