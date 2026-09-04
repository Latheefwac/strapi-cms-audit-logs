import type { Core } from '@strapi/strapi';

import { SECURITY_EVENT_MAP, SUBJECT_DISPLAY_NAMES } from '../constants';
import type {
  AuditEntryInput,
  AuditMetadata,
  AuditOutcome,
  AuditSecurityAction,
} from '../types';

type Payload = Record<string, any>;

/** Actions whose record is a *failure*: the attempt was made and refused. */
const FAILURE_ACTIONS = new Set<AuditSecurityAction>(['login.failed', 'access.denied']);

/**
 * Fields kept from an event payload's entity.
 *
 * An allow-list, not a deny-list, and that direction is the whole point: a
 * `user.update` payload is the entire admin user record, so anything other than
 * an allow-list puts a password hash, a reset token and a registration token
 * into the audit table — the three fields the redaction list exists to keep out.
 */
const IDENTIFYING_FIELDS = [
  'id',
  'documentId',
  'name',
  'email',
  'username',
  'firstname',
  'lastname',
  'code',
  'action',
  'subject',
  'isActive',
  'blocked',
  'mime',
  'url',
  'ext',
  'size',
  'path',
];

const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
};

/** Best human label for an admin user, matching what `context.ts` derives for content writes. */
const nameOf = (user: Payload | null | undefined): string | null => {
  if (!user) return null;
  const firstname = asString(user.firstname);
  const lastname = asString(user.lastname);
  if (firstname && lastname) return `${firstname} ${lastname}`;
  return asString(user.username) ?? firstname ?? lastname ?? asString(user.email);
};

/**
 * The half of the audit trail Strapi does not route through the Document
 * Service: who signed in, who failed to, who signed out, and every change to the
 * admin users, roles, permissions and media that govern the rest of it.
 *
 * ## Why `eventHub` and not more Document Service middleware
 *
 * None of these operations is a document operation. `@strapi/admin` writes admin
 * users with `strapi.db.query('admin::user')` and `@strapi/upload` writes files
 * with `strapi.db.query(FILE_MODEL_UID)` — both sit *below* the Document
 * Service, so the tracker in `tracker.ts` never sees them and no amount of
 * middleware would make it. Authentication is not a write at all.
 *
 * What Strapi does do is emit a named event for each one, on the same
 * `strapi.eventHub` its own webhook system runs on. Those emissions are all in
 * **Community Edition** — `server/src/controllers/authentication.ts` and
 * `server/src/services/{user,role,permission}.ts` in `@strapi/admin`,
 * `server/src/services/{upload,folder}.ts` in `@strapi/upload` — so nothing here
 * needs an Enterprise licence, and nothing here patches Strapi's own code.
 *
 * ## Why a listener may never throw
 *
 * `eventHub.emit` awaits its subscribers in sequence *inside the operation that
 * emitted*. A listener that threw on `admin.auth.success` would turn a correct
 * password into a failed login. Every handler is therefore wrapped: an audit
 * failure is logged and swallowed, and `failOnAuditError` is deliberately not
 * honoured here. That option exists so a project can refuse to serve content it
 * cannot audit, which is a very different proposition from locking every
 * administrator out of the panel because the audit table is unreachable.
 */
const securityService = ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = () => strapi.plugin('audit-log');

  /** Handles returned by `eventHub.on`, kept so `destroy` can take them off again. */
  let unsubscribers: Array<() => void> = [];

  /**
   * The live Koa context, when the event was emitted inside a request.
   *
   * Everything an audit record needs about "from where" is here — the address,
   * the user agent, the correlation id. It is read rather than passed because
   * Strapi's own event payloads carry none of it.
   */
  const requestContext = (): Payload | undefined => {
    try {
      return strapi.requestContext?.get?.() as Payload | undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Who the actor was.
   *
   * The signed-in admin (`ctx.state.user`) is the right answer for every event
   * except the authentication ones, where there is no session yet and the
   * subject of the event *is* the actor — so `admin.auth.success` and
   * `admin.logout` pass their own user in, and it wins.
   */
  const actor = (explicit?: Payload | null) => {
    const ctx = requestContext();
    const user = explicit ?? (ctx?.state?.user as Payload | undefined) ?? null;

    return {
      userId: asString(user?.id),
      userEmail: asString(user?.email),
      userName: nameOf(user),
    };
  };

  /**
   * Where the request came from.
   *
   * Mirrors `context.ts` so a login record and a content record report the same
   * address for the same request: `ctx.request.ip` honours Koa's `proxy`
   * setting, and `X-Forwarded-For` is ignored unless the server is configured to
   * trust it. A spoofable address in an audit log is worse than no address.
   */
  const requestMeta = () => {
    const ctx = requestContext();
    const headers = (ctx?.request?.headers ?? {}) as Record<string, unknown>;

    return {
      ipAddress: asString(ctx?.request?.ip ?? ctx?.ip),
      userAgent: asString(headers['user-agent']),
      requestId: asString(ctx?.state?.requestId ?? headers['x-request-id']),
    };
  };

  /**
   * Where the event came from.
   *
   * `admin` when a request is in flight — every event mapped here is emitted
   * from the admin API, so the route type is not worth consulting; deriving it
   * that way would yield `unknown` for the authentication routes, which run with
   * `auth: false` and match none of the shapes `context.ts` recognises.
   *
   * `system` when there is no request at all. That case is real and easy to miss:
   * Strapi reconciles its permission table **during boot**, which emits
   * `permission.create` and `permission.delete` with no actor and no request.
   * Labelling those `admin` would put rows in the log that read as though an
   * administrator had edited permissions, which is precisely the row a security
   * review is meant to stop on.
   */
  const sourceOf = (): 'admin' | 'system' => (requestContext() ? 'admin' : 'system');

  /** Writes one security record. */
  const record = async (
    action: AuditSecurityAction,
    subject: string,
    fields: {
      contentDocumentId?: string | null;
      contentId?: string | null;
      user?: Payload | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      metadata?: AuditMetadata | null;
      outcome?: AuditOutcome;
    } = {}
  ): Promise<void> => {
    const config = plugin().service('config');
    if (!config.isAuditedSecurityAction(action)) return;

    const source = sourceOf();

    // `auditSystemOperations: false` drops everything that happened outside a
    // request. Chiefly that is Strapi's boot-time permission reconciliation,
    // which otherwise adds a handful of `admin.permission.*` rows on every
    // single restart — noise that buries the one time a human really did change
    // a permission.
    if (source === 'system' && !config.resolve().auditSystemOperations) return;

    const entry: AuditEntryInput = {
      action,
      contentType: subject,
      contentTypeDisplayName: SUBJECT_DISPLAY_NAMES[subject] ?? subject,
      contentDocumentId: fields.contentDocumentId ?? null,
      contentId: fields.contentId ?? null,
      locale: null,
      changes: null,
      before: fields.before ?? null,
      after: fields.after ?? null,
      outcome: fields.outcome ?? (FAILURE_ACTIONS.has(action) ? 'failure' : 'success'),
      metadata: fields.metadata ?? null,
      source,
      ...actor(fields.user),
      ...requestMeta(),
    };

    await plugin().service('audit').record(entry);
  };

  /** The identifying fields of an entity carried on an event payload. See {@link IDENTIFYING_FIELDS}. */
  const identify = (entity: Payload | null | undefined): Record<string, unknown> | null => {
    if (!entity || typeof entity !== 'object') return null;

    const summary: Record<string, unknown> = {};
    for (const key of IDENTIFYING_FIELDS) {
      if (entity[key] !== undefined && entity[key] !== null) summary[key] = entity[key];
    }

    // Role membership is the part of an admin-user change anyone actually
    // reviews — "was this account given Super Admin" is the question — so the
    // names are flattened in rather than left behind with the rest of the object.
    if (Array.isArray(entity.roles)) {
      summary.roles = entity.roles
        .map((role: Payload) => asString(role?.name) ?? asString(role?.code) ?? asString(role?.id))
        .filter(Boolean);
    }

    return Object.keys(summary).length > 0 ? summary : null;
  };

  /** The entity an event payload is about, whatever key Strapi chose to put it under. */
  const subjectOf = (payload: Payload): Payload | null =>
    (payload?.user ??
      payload?.role ??
      payload?.permission ??
      payload?.media ??
      payload?.folder ??
      null) as Payload | null;

  /**
   * The email a failed login was attempted with.
   *
   * `admin.auth.error` carries only `{ error, provider }` — Strapi puts no
   * identity on the event, which on its own makes "which account is being brute
   * forced" unanswerable. The identity is on the request body, and the event is
   * emitted synchronously inside that request, so the live Koa context still has
   * it.
   *
   * Only `email` is read. The body's other field is the password.
   */
  const attemptedEmail = (): string | null => {
    const body = requestContext()?.request?.body as Payload | undefined;
    return asString(body?.email);
  };

  /** Events whose record needs more than the generic entity treatment. */
  const handlers: Record<string, (payload: Payload) => Promise<void>> = {
    'admin.auth.success': async (payload) => {
      const user = payload?.user as Payload | undefined;
      await record('login.success', SECURITY_EVENT_MAP['admin.auth.success']!.subject, {
        user,
        contentId: asString(user?.id),
        metadata: { provider: asString(payload?.provider) ?? 'local' },
      });
    },

    'admin.auth.error': async (payload) => {
      const email = attemptedEmail();

      await record('login.failed', SECURITY_EVENT_MAP['admin.auth.error']!.subject, {
        // No session exists, so `actor()` would find nobody. The attempted
        // identity is the whole value of the record: it is what turns twenty
        // rows into "twenty attempts against one account".
        user: email ? { email } : null,
        metadata: {
          provider: asString(payload?.provider) ?? 'local',
          reason: asString((payload?.error as Error)?.message) ?? 'Authentication failed',
          attemptedEmail: email,
        },
      });
    },

    'admin.logout': async (payload) => {
      const user = payload?.user as Payload | undefined;
      await record('logout', SECURITY_EVENT_MAP['admin.logout']!.subject, {
        user,
        contentId: asString(user?.id),
      });
    },
  };

  /**
   * Handler for every event that is simply "this entity was created, changed or
   * removed": admin users, roles, permissions, media files and folders.
   *
   * A create records the new state as `after`, a delete the old state as
   * `before`, and an update the new state. Strapi's payload carries only one
   * side, so producing a before/after diff here would mean inventing one — the
   * content half of the plugin is where real diffs come from. What this half
   * answers is "who touched the account, and when", which is the question a
   * security review actually puts to it.
   */
  const entityHandler =
    (action: AuditSecurityAction, subject: string) =>
    async (payload: Payload): Promise<void> => {
      const entity = subjectOf(payload);
      const summary = identify(entity);
      const isDelete = action.endsWith('.delete');

      await record(action, subject, {
        contentId: asString(entity?.id),
        contentDocumentId: asString(entity?.documentId),
        before: isDelete ? summary : null,
        after: isDelete ? null : summary,
      });
    };

  /**
   * Subscribes to every enabled event.
   *
   * Idempotent: calling it twice — which `strapi console` and the test harness
   * both do — drops the previous set first rather than doubling every record.
   */
  const register = (): void => {
    const config = plugin().service('config');

    if (!config.hasSecurityEvents()) {
      strapi.log.debug('[audit-log] securityEvents is empty — no security listeners registered.');
      return;
    }

    unregister();

    const enabled = new Set(config.enabledSecurityActions());

    for (const [event, { action, subject }] of Object.entries(SECURITY_EVENT_MAP)) {
      if (!enabled.has(action)) continue;

      const handler = handlers[event] ?? entityHandler(action, subject);

      const listener = async (payload: Payload = {}): Promise<void> => {
        try {
          await handler(payload);
        } catch (error) {
          // `eventHub.emit` awaits its listeners inside the operation that
          // emitted. Rethrowing would make an audit outage look like a wrong
          // password, or block an upload. Log it and let the operation finish.
          strapi.log.error(
            `[audit-log] failed to record "${event}": ${(error as Error)?.message ?? error}`
          );
        }
      };

      unsubscribers.push(strapi.eventHub.on(event, listener as never));
    }

    strapi.log.info(
      `[audit-log] security events: listening on ${unsubscribers.length} of ` +
        `${Object.keys(SECURITY_EVENT_MAP).length} Strapi events.`
    );
  };

  const unregister = (): void => {
    for (const off of unsubscribers) {
      try {
        off();
      } catch {
        // `off` only splices an array; a throw means the hub was already torn
        // down, which is the state we were asking for anyway.
      }
    }
    unsubscribers = [];
  };

  return { register, unregister, record, identify, subjectOf, sourceOf, entityHandler, handlers };
};

export default securityService;
