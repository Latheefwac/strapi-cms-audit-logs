import { PERMISSIONS } from '../constants';

/**
 * Guard shared by every route.
 *
 * `admin::isAuthenticatedAdmin` rejects anything without a valid admin session;
 * `admin::hasPermissions` then checks the specific RBAC action against the
 * user's role. Both are Strapi's own policies — the plugin never inspects a
 * token or a user itself.
 */
const protectedBy = (action: string) => ({
  policies: [
    'admin::isAuthenticatedAdmin',
    { name: 'admin::hasPermissions', config: { actions: [action] } },
  ],
});

/**
 * Admin API for the plugin.
 *
 * `type: 'admin'` mounts these under the admin server and prefixes them with the
 * plugin id, so the paths below become `/audit-log/logs`, `/audit-log/logs/:id`
 * and so on. There is no `type: 'content-api'` route file, and that is the
 * point: audit records are never reachable from the public content API, with or
 * without an API token, because no public route exists to reach them.
 */
export default {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/logs',
      handler: 'audit-log.find',
      config: protectedBy(PERMISSIONS.read),
    },
    {
      method: 'GET',
      path: '/filters',
      handler: 'audit-log.filters',
      config: protectedBy(PERMISSIONS.read),
    },
    {
      method: 'GET',
      path: '/config',
      handler: 'audit-log.config',
      config: protectedBy(PERMISSIONS.read),
    },
    {
      // Declared after the two static paths above so `/logs/filters` can never
      // be swallowed by `:id`.
      method: 'GET',
      path: '/logs/:id',
      handler: 'audit-log.findOne',
      config: protectedBy(PERMISSIONS.read),
    },
    {
      method: 'DELETE',
      path: '/logs/:id',
      handler: 'audit-log.delete',
      // A separate permission from `read`: being allowed to investigate an
      // incident must not imply being allowed to erase the evidence.
      config: protectedBy(PERMISSIONS.delete),
    },
  ],
};
