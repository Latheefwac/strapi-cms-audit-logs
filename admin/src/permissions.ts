import { PLUGIN_ID } from './pluginId';

/**
 * RBAC actions, mirroring `server/src/register.ts`.
 *
 * Duplicated rather than imported: the admin and server bundles are compiled by
 * separate Vite passes rooted at `admin/src` and `server/src`, so a module
 * shared across that boundary would be emitted outside its own declaration
 * root. Three string constants is the cheaper of the two problems.
 *
 * ## Why the full permission entity, and not just `{ action, subject }`
 *
 * Consistency rather than necessity. The admin only ever compares `action` and
 * `subject`, and `{ action, subject: null }` satisfies both of its checks:
 *
 * ```ts
 * // useMenu -> checkUserHasPermissions: subject is optional
 * perm.action === permission.action && (perm.subject == undefined || perm.subject === permission.subject)
 *
 * // Page.Protect: subject is compared strictly
 * perm.action === permission.action && perm.subject === permission.subject
 * ```
 *
 * Mirroring the entity the server actually returns from
 * `GET /admin/users/me/permissions` — which is also what Strapi's own
 * first-party plugins declare (see `constants.ts` in `@strapi/content-releases`)
 * — just removes a difference that would otherwise have to be reasoned about
 * every time this file is read. `getDefaultPermission()` in
 * `@strapi/admin/server/src/domain/permission` is the source of the defaults:
 * `subject: null`, `actionParameters: {}`, `properties: {}`, `conditions: []`.
 *
 * ⚠️ If the page renders "You don't have the permissions to access that content"
 * for a user who demonstrably holds `plugin::audit-log.read`, this file is not
 * the cause. That symptom comes from the plugin being bound to a *second* copy
 * of the admin runtime, which happens when a local `file:` install leaves a
 * nested `node_modules` in the installed package. See the README's "Installing
 * from a local path".
 */
const entity = (action: string) => ({
  action,
  subject: null,
  id: '',
  actionParameters: {},
  properties: {},
  conditions: [],
});

export const PERMISSIONS = {
  read: [entity(`plugin::${PLUGIN_ID}.read`)],
  settings: [entity(`plugin::${PLUGIN_ID}.settings`)],
};
