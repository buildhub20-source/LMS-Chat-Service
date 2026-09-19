import { getAllActiveTenants } from '../tenant/tenantService.js';
import { getPool as getTenantPool } from '../tenant/tenantPool.js';
import { deleteObjects } from '../storage/r2StorageService.js';
import logger from '../common/logger.js';
import env from '../config/environment.js';

/**
 * Extracts Cloudflare R2 object key from attachment object or URL.
 * Handles both:
 * - Direct object key: att.key (e.g. "tenants/{tenantId}/chat/{uuid}-{file}")
 * - Public URL: att.url (e.g. "https://pub-xxx.r2.dev/tenants/{tenantId}/chat/...")
 */
function extractObjectKey(att) {
  if (!att) return null;
  if (typeof att === 'object' && att.key) {
    return att.key;
  }

  const url = typeof att === 'string' ? att : att.url;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    // Remove leading slash
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    // If not a valid URL, check if it already looks like a key
    if (url.startsWith('tenants/')) {
      return url;
    }
    return null;
  }
}

/**
 * Executes retention cleanup for a single tenant.
 * Purges files from Cloudflare R2 older than the tenant's configured retention period.
 *
 * @param {Object} tenant
 * @param {string} tenant.tenantId
 * @param {string} tenant.slug
 * @param {number} [tenant.chatFileRetentionDays]
 */
export async function cleanupTenantChatFiles(tenant) {
  const retentionDays = Number(tenant.chatFileRetentionDays || 30);
  const tenantId = tenant.tenantId;

  try {
    const pool = await getTenantPool(tenantId);

    // Find messages with attachments older than retentionDays
    const query = `
      SELECT id, attachments
      FROM lms.chat_messages
      WHERE created_at < NOW() - ($1 || ' days')::interval
        AND attachments IS NOT NULL
        AND attachments != '[]'::jsonb
      ORDER BY created_at ASC
      LIMIT 1000
    `;

    const result = await pool.query(query, [retentionDays]);
    if (result.rows.length === 0) {
      return { tenantSlug: tenant.slug, retentionDays, purgedMessages: 0, purgedFiles: 0 };
    }

    const keysToDelete = [];
    const messageIdsToUpdate = [];

    for (const row of result.rows) {
      messageIdsToUpdate.push(row.id);
      let atts = row.attachments;
      if (typeof atts === 'string') {
        try {
          atts = JSON.parse(atts);
        } catch {
          atts = [];
        }
      }

      if (Array.isArray(atts)) {
        for (const att of atts) {
          const key = extractObjectKey(att);
          if (key && key.includes('chat/')) {
            keysToDelete.push(key);
          }
        }
      }
    }

    // 1. Delete expired objects from Cloudflare R2
    if (keysToDelete.length > 0) {
      await deleteObjects(keysToDelete);
    }

    // 2. Mark attachments as expired in tenant database to release storage
    if (messageIdsToUpdate.length > 0) {
      await pool.query(
        `UPDATE lms.chat_messages
         SET attachments = '[]'::jsonb
         WHERE id = ANY($1::uuid[])`,
        [messageIdsToUpdate]
      );
    }

    logger.info(
      {
        tenant: tenant.slug,
        retentionDays,
        purgedMessages: messageIdsToUpdate.length,
        purgedFiles: keysToDelete.length,
      },
      'Completed chat attachment retention cleanup for tenant'
    );

    return {
      tenantSlug: tenant.slug,
      retentionDays,
      purgedMessages: messageIdsToUpdate.length,
      purgedFiles: keysToDelete.length,
    };
  } catch (err) {
    logger.error(
      { tenant: tenant.slug, error: err.message },
      'Failed chat attachment retention cleanup for tenant'
    );
    return { tenantSlug: tenant.slug, error: err.message };
  }
}

/**
 * Runs the retention cleanup job across all active tenants.
 */
export async function runRetentionCleanup() {
  logger.info('Starting scheduled chat file retention cleanup job...');
  try {
    const tenants = await getAllActiveTenants();
    if (!tenants || tenants.length === 0) {
      logger.info('No active tenants found for retention cleanup.');
      return;
    }

    const results = [];
    for (const tenant of tenants) {
      const result = await cleanupTenantChatFiles(tenant);
      results.push(result);
    }

    logger.info({ tenantsProcessed: results.length }, 'Retention cleanup job completed');
    return results;
  } catch (err) {
    logger.error({ error: err.message }, 'Retention cleanup job encountered an error');
  }
}

/**
 * Starts the background timer that runs the retention cleanup job daily.
 */
export function startRetentionCleanupScheduler() {
  // Run first check 30 seconds after server boot
  setTimeout(() => {
    runRetentionCleanup().catch((err) => {
      logger.error({ error: err.message }, 'Error in initial retention cleanup execution');
    });
  }, 30 * 1000);

  // Then schedule to run every 24 hours
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    runRetentionCleanup().catch((err) => {
      logger.error({ error: err.message }, 'Error in daily scheduled retention cleanup');
    });
  }, TWENTY_FOUR_HOURS);

  logger.info('Chat file retention cleanup scheduler initialized (runs daily).');
}

export default {
  runRetentionCleanup,
  cleanupTenantChatFiles,
  startRetentionCleanupScheduler,
};
