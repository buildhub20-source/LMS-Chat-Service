import pg from 'pg';
import logger from '../common/logger.js';
import { getTenantById } from './tenantService.js';

const { Pool } = pg;

/**
 * Manages per-tenant PostgreSQL connection pools.
 * Mirrors the pattern in TenantRoutingDataSource.java.
 */

/** @type {Map<string, pg.Pool>} */
const pools = new Map();

/** @type {Map<string, Promise<pg.Pool>>} */
const pending = new Map();

/**
 * Returns a pg.Pool for the given tenant. Creates one lazily if needed,
 * fetching credentials from the LMS-BackEnd internal API.
 *
 * Uses a pending-promise map to prevent concurrent pool creation for the
 * same tenant (equivalent to Java's ConcurrentHashMap.computeIfAbsent).
 *
 * @param {string} tenantId
 * @returns {Promise<pg.Pool>}
 */
export async function getPool(tenantId) {
  // Fast path: pool already exists
  const existing = pools.get(tenantId);
  if (existing) return existing;

  // Check if another caller is already creating this pool
  const pendingPromise = pending.get(tenantId);
  if (pendingPromise) return pendingPromise;

  // Create pool
  const promise = createPool(tenantId);
  pending.set(tenantId, promise);

  try {
    const pool = await promise;
    pools.set(tenantId, pool);
    return pool;
  } finally {
    pending.delete(tenantId);
  }
}

/**
 * Evicts and closes a tenant's pool (e.g. on tenant deactivation).
 */
export async function evictPool(tenantId) {
  const pool = pools.get(tenantId);
  if (pool) {
    pools.delete(tenantId);
    await pool.end();
    logger.info({ tenantId }, 'Evicted tenant pool');
  }
}

/**
 * Closes all pools (for graceful shutdown).
 */
export async function closeAllPools() {
  const entries = [...pools.entries()];
  pools.clear();
  await Promise.all(
    entries.map(([tenantId, pool]) =>
      pool.end().then(() => logger.info({ tenantId }, 'Closed tenant pool'))
    )
  );
}

// ─── Internal ──────────────────────────────────────────────

async function createPool(tenantId) {
  const tenant = await getTenantById(tenantId);

  // Parse JDBC URL into host, port, database
  // e.g. jdbc:postgresql://aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
  const rawUrl = tenant.jdbcUrl.replace(/^jdbc:postgresql:\/\//, '').replace(/^jdbc:/, '');
  const [hostPortPart, queryPart] = rawUrl.split('?');
  const [hostPort, dbName] = hostPortPart.split('/');
  const [host, portStr] = hostPort.split(':');
  const port = portStr ? parseInt(portStr, 10) : 5432;
  const database = dbName || 'postgres';

  const needsSsl = (queryPart && queryPart.includes('sslmode=require')) || host.includes('supabase.co') || host.includes('supabase.com');

  const pool = new Pool({
    host,
    port,
    database,
    user: tenant.username,
    password: tenant.password,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 3,
    min: 0,
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 30_000,
    // Force the lms schema for all connections
    options: '-c search_path=lms,public',
  });

  pool.on('error', (err) => {
    logger.error({ tenantId, err: err.message }, 'Tenant pool error');
  });

  // Verify connectivity + run migrations
  try {
    const client = await pool.connect();
    try {
      await runMigrations(client, tenantId);
    } finally {
      client.release();
    }
    logger.info({ tenantId, slug: tenant.slug }, 'Tenant pool created');
  } catch (err) {
    await pool.end();
    throw err;
  }

  return pool;
}

/**
 * Runs chat-specific migrations for a tenant database.
 * Uses a simple idempotent approach — each migration is wrapped in
 * IF NOT EXISTS / CREATE IF NOT EXISTS.
 */
async function runMigrations(client, tenantId) {
  logger.info({ tenantId }, 'Running chat migrations...');

  // Ensure lms schema exists
  await client.query(`CREATE SCHEMA IF NOT EXISTS lms`);

  // chat_channels
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_channels (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type            VARCHAR(20) NOT NULL,
      name            VARCHAR(200),
      description     TEXT,
      course_id       UUID,
      created_by      UUID NOT NULL,
      is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON lms.chat_channels(type)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_channels_course_id ON lms.chat_channels(course_id)`);

  // chat_channel_members
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_channel_members (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id              UUID NOT NULL REFERENCES lms.chat_channels(id),
      user_id                 UUID NOT NULL,
      role                    VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
      notification_preference VARCHAR(20) NOT NULL DEFAULT 'ALL',
      joined_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at                 TIMESTAMPTZ,
      last_read_message_id    UUID,
      UNIQUE (channel_id, user_id)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON lms.chat_channel_members(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_channel ON lms.chat_channel_members(channel_id)`);

  // chat_messages
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_messages (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id          UUID NOT NULL REFERENCES lms.chat_channels(id),
      sender_id           UUID NOT NULL,
      content             TEXT NOT NULL,
      message_type        VARCHAR(20) NOT NULL DEFAULT 'TEXT',
      reply_to_message_id UUID,
      client_message_id   VARCHAR(64),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_at           TIMESTAMPTZ,
      deleted_at          TIMESTAMPTZ,
      deleted_by          UUID
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON lms.chat_messages(channel_id, created_at DESC)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_id ON lms.chat_messages(channel_id, client_message_id) WHERE client_message_id IS NOT NULL`);
  await client.query(`ALTER TABLE lms.chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`);

  // chat_audit_logs (Phase 2)
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_audit_logs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id   UUID NOT NULL,
      action          VARCHAR(40) NOT NULL,
      channel_id      UUID,
      message_id      UUID,
      metadata        JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_audit_actor ON lms.chat_audit_logs(actor_user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_audit_channel ON lms.chat_audit_logs(channel_id)`);

  // chat_message_reactions (Phase 3)
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_message_reactions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id      UUID NOT NULL REFERENCES lms.chat_messages(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL,
      reaction        VARCHAR(32) NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (message_id, user_id, reaction)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON lms.chat_message_reactions(message_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_reactions_user ON lms.chat_message_reactions(user_id)`);

  // chat_pinned_messages (Phase 3)
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_pinned_messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id      UUID NOT NULL REFERENCES lms.chat_channels(id) ON DELETE CASCADE,
      message_id      UUID NOT NULL REFERENCES lms.chat_messages(id) ON DELETE CASCADE,
      pinned_by       UUID NOT NULL,
      pinned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (channel_id, message_id)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_pinned_channel ON lms.chat_pinned_messages(channel_id)`);

  // chat_user_presence (Phase 3)
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms.chat_user_presence (
      user_id         UUID PRIMARY KEY,
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  logger.info({ tenantId }, 'Chat migrations complete');
}
