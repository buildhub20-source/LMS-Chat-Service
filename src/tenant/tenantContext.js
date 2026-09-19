import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * AsyncLocalStorage-based tenant context, equivalent to the ThreadLocal-based
 * TenantContext in LMS-BackEnd. Provides request-scoped tenant isolation
 * without passing tenant info through every function call.
 */
const storage = new AsyncLocalStorage();

/**
 * @typedef {Object} TenantContextData
 * @property {string} tenantId
 * @property {string} slug
 * @property {import('pg').Pool} pool - Tenant-specific pg pool
 */

export const tenantContext = {
  /**
   * Runs a callback within a tenant context.
   * @param {TenantContextData} context
   * @param {Function} fn
   */
  run(context, fn) {
    return storage.run(context, fn);
  },

  /**
   * Returns the current tenant context, or null if none is set.
   * @returns {TenantContextData|null}
   */
  current() {
    return storage.getStore() ?? null;
  },

  /**
   * Returns the current tenant's pg.Pool. Throws if no context is set.
   * @returns {import('pg').Pool}
   */
  getPool() {
    const ctx = storage.getStore();
    if (!ctx?.pool) {
      throw new Error('No tenant context — cannot access database');
    }
    return ctx.pool;
  },

  /**
   * Returns the current tenant ID. Throws if no context is set.
   * @returns {string}
   */
  getTenantId() {
    const ctx = storage.getStore();
    if (!ctx?.tenantId) {
      throw new Error('No tenant context');
    }
    return ctx.tenantId;
  },
};

export default tenantContext;
