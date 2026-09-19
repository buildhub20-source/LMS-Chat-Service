import env from '../config/environment.js';
import logger from '../common/logger.js';

/**
 * Fetches tenant database credentials from the LMS-BackEnd internal API.
 * Caches results in memory with a 5-minute TTL to avoid repeated calls.
 */

/** @type {Map<string, { data: TenantInfo, expiresAt: number }>} */
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @typedef {Object} TenantInfo
 * @property {string} tenantId
 * @property {string} slug
 * @property {string} jdbcUrl
 * @property {string} username
 * @property {string} password
 */

/**
 * Fetches tenant info from LMS-BackEnd by tenant ID.
 * @param {string} tenantId
 * @returns {Promise<TenantInfo>}
 */
export async function getTenantById(tenantId) {
  const cacheKey = `id:${tenantId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const url = `${env.lmsBackendUrl}/api/v1/internal/tenants/${tenantId}`;
  const data = await fetchTenant(url);

  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  cache.set(`slug:${data.slug}`, { data, expiresAt: Date.now() + CACHE_TTL_MS });

  return data;
}

/**
 * Fetches tenant info from LMS-BackEnd by slug.
 * @param {string} slug
 * @returns {Promise<TenantInfo>}
 */
export async function getTenantBySlug(slug) {
  const cacheKey = `slug:${slug}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const url = `${env.lmsBackendUrl}/api/v1/internal/tenants/by-slug/${slug}`;
  const data = await fetchTenant(url);

  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  cache.set(`id:${data.tenantId}`, { data, expiresAt: Date.now() + CACHE_TTL_MS });

  return data;
}

/**
 * Fetches all active tenants from LMS-BackEnd.
 * @returns {Promise<Array<TenantInfo & { chatFileRetentionDays?: number }>>}
 */
export async function getAllActiveTenants() {
  const url = `${env.lmsBackendUrl}/api/v1/internal/tenants`;
  const result = await fetchTenant(url);
  return Array.isArray(result) ? result : (result?.data ?? []);
}

/**
 * Fetches user details in batch from LMS-BackEnd.
 * @param {string} tenantId
 * @param {string[]} userIds
 * @returns {Promise<Array<{ userId: string, name: string, email: string, avatarUrl: string|null }>>}
 */
export async function getUsersBatch(tenantId, userIds) {
  const url = `${env.lmsBackendUrl}/api/v1/internal/users/batch`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': env.serviceKeySecret,
      'X-Tenant-Slug': tenantId, // backend resolves via tenant header
    },
    body: JSON.stringify({ userIds }),
  });

  if (!response.ok) {
    logger.error({ status: response.status, url }, 'Failed to fetch users batch');
    return [];
  }

  const body = await response.json();
  return body.data ?? body ?? [];
}

/**
 * Evicts a tenant from the cache.
 */
export function evictTenantCache(tenantId) {
  for (const [key, value] of cache) {
    if (value.data.tenantId === tenantId) {
      cache.delete(key);
    }
  }
}

// ─── Internal ──────────────────────────────────────────────

async function fetchTenant(url) {
  const response = await fetch(url, {
    headers: {
      'X-Service-Key': env.serviceKeySecret,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error({ status: response.status, url, body: text }, 'Failed to fetch tenant from LMS-BackEnd');
    throw new Error(`Tenant lookup failed (HTTP ${response.status})`);
  }

  const body = await response.json();
  // LMS-BackEnd wraps responses in { data, message, timestamp }
  return body.data ?? body;
}
