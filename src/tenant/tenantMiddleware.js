import tenantContext from './tenantContext.js';
import { getPool } from './tenantPool.js';

/**
 * Express middleware that establishes tenant context for the request.
 *
 * The tenant is resolved from the JWT's tenantId claim (set by authMiddleware).
 * The corresponding pg.Pool is fetched/created and stored in AsyncLocalStorage.
 */
export async function tenantMiddleware(req, res, next) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  try {
    const pool = await getPool(tenantId);

    // Run the rest of the request inside the tenant context
    tenantContext.run({ tenantId, pool }, () => {
      next();
    });
  } catch (err) {
    next(err);
  }
}

export default tenantMiddleware;
