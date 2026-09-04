import type { Core } from '@strapi/strapi';

import { PLUGIN_ID } from './constants';

/**
 * RBAC actions this plugin contributes.
 *
 * `section: 'plugins'` puts them in the Plugins tab of the role editor, next to
 * the other plugins, and the provider namespaces each `uid` with the plugin name
 * — `read` becomes `plugin::audit-log.read`.
 *
 * Read and delete are separate on purpose: an auditor needs to see the trail, an
 * auditor must not be able to erase it, and collapsing the two into one
 * permission would make that distinction unexpressible.
 */
const ACTIONS = [
  {
    section: 'plugins',
    displayName: 'Read audit logs',
    uid: 'read',
    pluginName: PLUGIN_ID,
  },
  {
    section: 'plugins',
    displayName: 'Delete audit logs',
    uid: 'delete',
    pluginName: PLUGIN_ID,
  },
  {
    section: 'plugins',
    displayName: 'Read audit log settings',
    uid: 'settings',
    pluginName: PLUGIN_ID,
  },
];

/**
 * Runs before content types are loaded and before `bootstrap`.
 *
 * Permissions are registered here rather than in `bootstrap` so the actions
 * exist by the time the admin builds its permission sections — registering them
 * later leaves the role editor with nothing to tick on the first boot after
 * install.
 */
const register = async ({ strapi }: { strapi: Core.Strapi }) => {
  await strapi.service('admin::permission').actionProvider.registerMany(ACTIONS);

  /**
   * The denied-request middleware goes on here and NOT in `bootstrap`.
   *
   * `strapi.server.use()` appends to the Koa stack, and Strapi applies
   * `config/middlewares.ts` and mounts the router *inside* `bootstrap()`, before
   * the bootstrap lifecycles run. Registered from `bootstrap` this middleware
   * would therefore sit behind the router, never see a response, and fail
   * silently. Registered here it is outermost, so `await next()` returns with
   * `ctx.status` already final — including the 403 that `strapi::errors`
   * produced from a thrown `ForbiddenError`.
   *
   * The rest of the plugin's wiring stays in `bootstrap`, where
   * `strapi.documents` and `strapi.eventHub` are ready.
   */
  strapi.plugin(PLUGIN_ID).service('access').register();
};

export default register;
export { ACTIONS };
