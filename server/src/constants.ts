import type { AuditAction, AuditSecurityAction } from './types';

/** Plugin id. Must match `strapi.name` in package.json — it namespaces routes, permissions and config. */
export const PLUGIN_ID = 'audit-log';

/** UID of the plugin's own collection type. */
export const AUDIT_LOG_UID = 'plugin::audit-log.audit-log';

export const ALL_ACTIONS: AuditAction[] = ['create', 'update', 'delete', 'publish', 'unpublish'];

/** RBAC action uids, as they appear once namespaced by the admin permission provider. */
export const PERMISSIONS = {
  read: `plugin::${PLUGIN_ID}.read`,
  delete: `plugin::${PLUGIN_ID}.delete`,
  settings: `plugin::${PLUGIN_ID}.settings`,
} as const;

/**
 * Fields never written to `before`, `after` or `changes`.
 *
 * Matched by leaf name at any depth and case-insensitively, so `*token*` covers
 * `token`, `accessToken`, `seo.internalToken` and `blocks[0].refreshTokenHash`
 * alike. Substring patterns rather than an exhaustive list of exact names
 * because the list can only ever be a guess at what a project calls its secrets:
 * `internalToken` and `stripeSecretKey` are the names that actually turn up, and
 * an exact-match list silently stores both.
 *
 * The trade is deliberate. `*token*` also redacts a field named `tokenCount`,
 * which costs one uninteresting value in an audit record. Missing a credential
 * writes it, in clear, into a table designed to be kept for a year.
 *
 * Replaced wholesale (not merged) when a consumer sets `ignoredFields`; use
 * `additionalIgnoredFields` to extend rather than replace.
 */
export const DEFAULT_IGNORED_FIELDS: string[] = [
  '*password*',
  '*passwd*',
  '*token*',
  '*secret*',
  '*apikey*',
  '*api_key*',
  '*privatekey*',
  '*private_key*',
  '*credential*',
  '*accesskey*',
  'salt',
  'otp',
  '*totp*',
];

/**
 * Fields excluded from `changes` only.
 *
 * They still appear in `before`/`after` — they are real state — but they change
 * on every single write, so surfacing them as "changes" buries the edit the
 * editor actually made.
 */
export const DEFAULT_IGNORED_CHANGE_FIELDS: string[] = ['updatedAt', 'updatedBy', 'createdBy'];

/**
 * Attributes that carry no auditable content and are stripped from a snapshot.
 *
 * `id`, `documentId` and `locale` are recorded as dedicated columns instead, so
 * repeating them inside the JSON blobs is pure noise. `publishedAt` is fetched —
 * the tracker needs it to tell a draft row from a published one — but not
 * stored: the record's own `action` already says whether this was a publish or
 * an unpublish, and leaving it in makes every single-field update snapshot
 * contain a field the editor never touched.
 */
export const SKIPPED_ATTRIBUTES = new Set([
  'id',
  'documentId',
  'locale',
  'publishedAt',
  'createdBy',
  'updatedBy',
]);

/** Headers checked, in order, for a correlation id. */
export const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id', 'x-amzn-trace-id'];

/** Name under which the retention job is registered with `strapi.cron`. */
export const RETENTION_JOB_NAME = 'auditLogRetention';

/**
 * Alias that says what {@link ALL_ACTIONS} actually is, now that the plugin also
 * records events which are not content operations.
 *
 * `ALL_ACTIONS` keeps its name and its five members because `config.actions`
 * validates against it. Widening that option to accept security actions would
 * let a project write `actions: ['login.success']` and then wonder why none of
 * its content was audited. Security events get their own switch —
 * `securityEvents` — for the same reason: the two families are produced by
 * different machinery, fail independently, and are turned on and off
 * independently.
 */
export const CONTENT_ACTIONS = ALL_ACTIONS;

/**
 * Everything the plugin records that is *not* a content write.
 *
 * These arrive from `strapi.eventHub` and from a Koa middleware rather than from
 * the Document Service, which is why they are listed apart. Every one of them is
 * available in Strapi **Community Edition** — none needs an Enterprise licence.
 */
export const ALL_SECURITY_ACTIONS: AuditSecurityAction[] = [
  'login.success',
  'login.failed',
  'logout',
  'access.denied',
  'admin.user.create',
  'admin.user.update',
  'admin.user.delete',
  'admin.role.create',
  'admin.role.update',
  'admin.role.delete',
  'admin.permission.create',
  'admin.permission.update',
  'admin.permission.delete',
  'media.create',
  'media.update',
  'media.delete',
  'media-folder.create',
  'media-folder.update',
  'media-folder.delete',
];

/**
 * Pseudo content-type uids for events that are not about a content type.
 *
 * `contentType` is `required` on the schema and is what every existing filter,
 * index and search path is built on, so a security row carries the uid of the
 * subsystem it concerns rather than a null. `admin::user`, `admin::role` and
 * `admin::permission` are Strapi's own real uids; `admin::auth` and
 * `admin::access` are ours, naming the two subsystems Strapi does not model as
 * content types.
 */
export const SUBJECTS = {
  auth: 'admin::auth',
  access: 'admin::access',
  user: 'admin::user',
  role: 'admin::role',
  permission: 'admin::permission',
  file: 'plugin::upload.file',
  folder: 'plugin::upload.folder',
} as const;

/** Human labels for {@link SUBJECTS}, snapshotted into `contentTypeDisplayName`. */
export const SUBJECT_DISPLAY_NAMES: Record<string, string> = {
  [SUBJECTS.auth]: 'Authentication',
  [SUBJECTS.access]: 'Access control',
  [SUBJECTS.user]: 'Admin user',
  [SUBJECTS.role]: 'Admin role',
  [SUBJECTS.permission]: 'Permission',
  [SUBJECTS.file]: 'Media file',
  [SUBJECTS.folder]: 'Media folder',
};

/**
 * `eventHub` event name -> the audit action and subject it becomes.
 *
 * Every one of these is emitted by Strapi itself; the plugin adds no
 * instrumentation to Strapi's own code. Sources, for whoever has to re-verify
 * this list against a Strapi upgrade:
 *
 *   admin.auth.*, admin.logout    @strapi/admin   server/src/controllers/authentication.ts
 *   user.*, role.*, permission.*  @strapi/admin   server/src/services/{user,role,permission}.ts
 *   media.*                       @strapi/upload  server/src/services/upload.ts
 *   media-folder.*                @strapi/upload  server/src/services/folder.ts
 *
 * Media and admin-user writes go through `strapi.db.query`, below the Document
 * Service, so the tracker never sees them and there is no double-recording to
 * guard against.
 */
export const SECURITY_EVENT_MAP: Record<string, { action: AuditSecurityAction; subject: string }> = {
  'admin.auth.success': { action: 'login.success', subject: SUBJECTS.auth },
  'admin.auth.error': { action: 'login.failed', subject: SUBJECTS.auth },
  'admin.logout': { action: 'logout', subject: SUBJECTS.auth },

  'user.create': { action: 'admin.user.create', subject: SUBJECTS.user },
  'user.update': { action: 'admin.user.update', subject: SUBJECTS.user },
  'user.delete': { action: 'admin.user.delete', subject: SUBJECTS.user },

  'role.create': { action: 'admin.role.create', subject: SUBJECTS.role },
  'role.update': { action: 'admin.role.update', subject: SUBJECTS.role },
  'role.delete': { action: 'admin.role.delete', subject: SUBJECTS.role },

  'permission.create': { action: 'admin.permission.create', subject: SUBJECTS.permission },
  'permission.update': { action: 'admin.permission.update', subject: SUBJECTS.permission },
  'permission.delete': { action: 'admin.permission.delete', subject: SUBJECTS.permission },

  'media.create': { action: 'media.create', subject: SUBJECTS.file },
  'media.update': { action: 'media.update', subject: SUBJECTS.file },
  'media.delete': { action: 'media.delete', subject: SUBJECTS.file },

  'media-folder.create': { action: 'media-folder.create', subject: SUBJECTS.folder },
  'media-folder.update': { action: 'media-folder.update', subject: SUBJECTS.folder },
  'media-folder.delete': { action: 'media-folder.delete', subject: SUBJECTS.folder },
};

/**
 * Every value the `source` column can hold.
 *
 * Listed rather than derived from the rows already written, so the filter can
 * ask "did anything come in through the content API?" before anything has.
 */
export const ALL_SOURCES = ['admin', 'api', 'system', 'cron', 'migration', 'unknown'] as const;

/**
 * Response statuses the access middleware records as a denial.
 *
 * 401 is "you are not authenticated", 403 is "you are, and you still may not".
 * Both are what a security review means by an unauthorised access attempt, and
 * recording only 403 would miss every expired-session and bad-token probe.
 */
export const DENIED_STATUSES = new Set([401, 403]);

/**
 * Paths the access middleware never records.
 *
 * A failed *login* already produces a `login.failed` record from
 * `admin.auth.error`, complete with the attempted email; letting the middleware
 * add an `access.denied` for the same 401 would double every wrong-password
 * attempt. `/admin/renew-token` 401s routinely whenever a tab is left open past
 * the session window, which is noise rather than signal.
 */
export const ACCESS_IGNORED_PATHS: RegExp[] = [
  /^\/admin\/login(\/|$)/,
  /^\/admin\/renew-token(\/|$)/,
  /^\/admin\/refresh-token(\/|$)/,
  /^\/api\/auth\/local(\/|$)/,
];
