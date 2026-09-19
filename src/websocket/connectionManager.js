import logger from '../common/logger.js';

/**
 * Tracks active WebSocket connections per tenant/user.
 * Supports multi-device: one user can have multiple sockets.
 *
 * Structure: Map<tenantId, Map<userId, Set<socketId>>>
 */

/** @type {Map<string, Map<string, Set<string>>>} */
const connections = new Map();

/** @type {Map<string, { tenantId: string, userId: string }>} */
const socketIndex = new Map();

/** @type {Map<string, Map<string, string>>} */
const lastSeenMap = new Map();

export const connectionManager = {
  /**
   * Registers a new socket connection.
   * Returns { wasOffline: boolean }
   */
  add(tenantId, userId, socketId) {
    if (!connections.has(tenantId)) {
      connections.set(tenantId, new Map());
    }
    const tenantMap = connections.get(tenantId);
    const existingSockets = tenantMap.get(userId);
    const wasOffline = !existingSockets || existingSockets.size === 0;

    if (!tenantMap.has(userId)) {
      tenantMap.set(userId, new Set());
    }
    tenantMap.get(userId).add(socketId);
    socketIndex.set(socketId, { tenantId, userId });

    return { wasOffline };
  },

  /**
   * Removes a socket connection.
   * Returns { tenantId, userId, isNowOffline, lastSeen }
   */
  remove(socketId) {
    const meta = socketIndex.get(socketId);
    if (!meta) return null;

    const { tenantId, userId } = meta;
    socketIndex.delete(socketId);

    let isNowOffline = false;
    let lastSeen = null;

    const tenantMap = connections.get(tenantId);
    if (tenantMap) {
      const userSockets = tenantMap.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
          tenantMap.delete(userId);
          isNowOffline = true;
          lastSeen = new Date().toISOString();

          if (!lastSeenMap.has(tenantId)) {
            lastSeenMap.set(tenantId, new Map());
          }
          lastSeenMap.get(tenantId).set(userId, lastSeen);
        }
      }
      if (tenantMap.size === 0) connections.delete(tenantId);
    }

    return { tenantId, userId, isNowOffline, lastSeen };
  },

  /**
   * Gets all socket IDs for a user in a tenant.
   * @returns {Set<string>}
   */
  getUserSockets(tenantId, userId) {
    return connections.get(tenantId)?.get(userId) ?? new Set();
  },

  /**
   * Checks if a user is currently connected (any device).
   */
  isOnline(tenantId, userId) {
    const sockets = connections.get(tenantId)?.get(userId);
    return sockets != null && sockets.size > 0;
  },

  /**
   * Gets all connected user IDs for a tenant.
   */
  getOnlineUsers(tenantId) {
    const tenantMap = connections.get(tenantId);
    if (!tenantMap) return [];
    return [...tenantMap.keys()];
  },

  /**
   * Gets full presence state (online user IDs and last seen map).
   */
  getPresence(tenantId) {
    const onlineUserIds = this.getOnlineUsers(tenantId);
    const lastSeenObj = {};
    const tenantLastSeen = lastSeenMap.get(tenantId);
    if (tenantLastSeen) {
      for (const [uid, ts] of tenantLastSeen.entries()) {
        lastSeenObj[uid] = ts;
      }
    }
    return { onlineUserIds, lastSeen: lastSeenObj };
  },

  /**
   * Sets last seen timestamp manually or from DB.
   */
  setLastSeen(tenantId, userId, timestamp) {
    if (!lastSeenMap.has(tenantId)) {
      lastSeenMap.set(tenantId, new Map());
    }
    lastSeenMap.get(tenantId).set(userId, timestamp);
  },

  /**
   * Gets the metadata for a socket.
   */
  getSocketMeta(socketId) {
    return socketIndex.get(socketId) ?? null;
  },

  /**
   * Returns stats for monitoring.
   */
  getStats() {
    let totalConnections = 0;
    let totalUsers = 0;
    const tenants = connections.size;

    for (const tenantMap of connections.values()) {
      totalUsers += tenantMap.size;
      for (const sockets of tenantMap.values()) {
        totalConnections += sockets.size;
      }
    }

    return { tenants, totalUsers, totalConnections };
  },
};

export default connectionManager;
