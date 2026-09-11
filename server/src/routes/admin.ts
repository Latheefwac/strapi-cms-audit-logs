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
 *
 * There is no write route of any kind — no create, no update, and since 1.2.0
 * no delete. An audit log that an administrator can prune is not evidence of
 * what administrators did; ASVS V7.3.1 puts it plainly as "protected from
 * unauthorized modification or deletion", and the surest way to have no
 * unauthorised deletion is to have no deletion. The only thing that removes a
 * row is the retention job, which runs off the request path, cannot be aimed
 * at a specific record, and writes its own record of what it removed.
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
      // Walks the whole hash chain. Read-only, and behind `read` — being able
      // to see the log is the right bar for being able to check it.
      method: 'GET',
      path: '/integrity',
      handler: 'audit-log.integrity',
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
  ],
};
