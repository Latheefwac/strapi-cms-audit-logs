import type { Core } from '@strapi/strapi';

import { AUDIT_LOG_UID } from '../constants';

/** Document Service actions that would alter or remove an existing audit record. */
const FORBIDDEN_ACTIONS = new Set(['update', 'delete', 'publish', 'unpublish', 'discardDraft', 'clone']);

/**
 * Second line of defence for audit-record immutability.
 *
 * The first line is structural: `content-manager: { visible: false }` on the
 * schema means the Content Manager never registers create/update/delete RBAC
 * actions for this content type, so there is no permission an administrator
 * could grant that would let a role write these rows through the normal content
 * APIs. That covers the panel and the content API.
 *
 * It does not cover *server* code. A plugin, a migration or a stray
 * `strapi.documents('plugin::audit-log.audit-log').update(...)` in a bootstrap
 * would otherwise succeed silently. This middleware makes that a loud failure.
 *
 * Deletion is blocked here as well since 1.2.0. The one legitimate deletion —
 * retention — goes through `strapi.db.query`, below the Document Service, as do
 * the plugin's own writes; so this guard never needs an escape hatch that an
 * attacker could reach for, and a stray `strapi.documents(uid).delete()` in
 * server code fails loudly instead of quietly removing evidence.
 */
const immutabilityService = ({ strapi }: { strapi: Core.Strapi }) => {
  const createMiddleware = () => {
    return async (
      ctx: { uid: string; action: string },
      next: () => Promise<unknown>
    ): Promise<unknown> => {
      if (ctx.uid === AUDIT_LOG_UID && FORBIDDEN_ACTIONS.has(ctx.action)) {
        throw new Error(
          `[audit-log] Audit records are immutable: "${ctx.action}" is not permitted on ${AUDIT_LOG_UID}. ` +
            'Audit logs are written by the plugin and removed only by its retention job. ' +
            'There is no route, permission or service that deletes an individual record.'
        );
      }

      return next();
    };
  };

  /**
   * Adds the guard to the Document Service chain.
   *
   * The handle Strapi returns is discarded: the guard is meant to hold for the
   * lifetime of the process, and exposing an `unregister()` would make audit
   * immutability something that could be switched off at runtime.
   */
  const register = (): void => {
    strapi.documents.use(createMiddleware() as never);
  };

  return { createMiddleware, register };
};

export default immutabilityService;
