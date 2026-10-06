/**
 * Public type surface of the plugin.
 *
 * Re-exported from `strapi-cms-audit-log/strapi-server`, so a consuming
 * application can type its own code against the same shapes the plugin uses:
 *
 * ```ts
 * import type { AuditLog, AuditConfig } from 'strapi-cms-audit-log/strapi-server';
 * ```
 *
 * The admin panel keeps its own copies of the few shared unions in
 * `admin/src/types.ts`. That is not an oversight: the admin and server bundles
 * are compiled by separate Vite passes whose `.d.ts` emit is rooted at
 * `admin/src` and `server/src` respectively, so a file imported across that
 * boundary would be emitted outside its own root. See README → Architecture.
 */

/** Operations the plugin can record. Extend via `AuditAction` unions downstream. */
export type AuditAction = 'create' | 'update' | 'delete' | 'publish' | 'unpublish';

/**
 * Operations the plugin records that are not content writes.
 *
 * Produced by `strapi.eventHub` listeners and by the access middleware rather
 * than by the Document Service. Namespaced with a dot so a reader can tell at a
 * glance which family a row belongs to, and so a filter on `login.` prefixes
 * groups the authentication trail without a second column.
 */
export type AuditSecurityAction =
  | 'login.success'
  | 'login.failed'
  | 'logout'
  | 'access.denied'
  | 'admin.user.create'
  | 'admin.user.update'
  | 'admin.user.delete'
  | 'admin.role.create'
  | 'admin.role.update'
  | 'admin.role.delete'
  | 'admin.permission.create'
  | 'admin.permission.update'
  | 'admin.permission.delete'
  | 'media.create'
  | 'media.update'
  | 'media.delete'
  | 'media-folder.create'
  | 'media-folder.update'
  | 'media-folder.delete';

/**
 * Operations the plugin performs on *itself*.
 *
 * There is exactly one: the retention job removing expired rows. It is recorded
 * so that the only deletion the log permits leaves a trace of itself — how many
 * rows, older than what, when — which is what turns "we have retention" into
 * something an assessor can check against the row count.
 */
export type AuditMaintenanceAction = 'retention.purge';

/** Every action the plugin can write, across all three families. */
export type AuditAnyAction = AuditAction | AuditSecurityAction | AuditMaintenanceAction;

/**
 * Whether the recorded attempt succeeded.
 *
 * Every content write is a `success` — the middleware runs after the operation
 * resolved, so a failed save produces no record at all. The value earns its
 * column on the security side, where `login.failed` and `access.denied` are the
 * rows a reviewer opens the log to find, and where "show me the failures" must
 * be an indexed query rather than a scan of an action list.
 */
export type AuditOutcome = 'success' | 'failure';

/**
 * Free-form detail that only some actions have.
 *
 * A deliberately loose bag rather than a column each: the useful fields differ
 * per action (`reason` and `provider` for a login, `method`/`path`/`statusCode`
 * for a denial, `fileName` for an upload), and none of them is ever filtered or
 * sorted on. Anything worth querying gets a real column instead.
 */
export interface AuditMetadata {
  [key: string]: unknown;
}

/** How security events are selected. `'*'` means every one of them. */
export type SecurityEventSelector = '*' | AuditSecurityAction[];

/**
 * Where the operation came from.
 *
 * `admin`  — an authenticated Strapi admin panel request
 * `api`    — the REST/GraphQL content API (API token or Users & Permissions user)
 * `cron`   — a scheduled task
 * `migration` — a data migration or import script
 * `system` — server-side code with no request context (bootstrap, listeners)
 * `unknown` — a request context existed but could not be classified
 */
export type AuditSource = 'admin' | 'api' | 'system' | 'cron' | 'migration' | 'unknown';

/** A single field-level change, keyed in {@link AuditChangeSet} by dotted path. */
export interface AuditChange {
  from: unknown;
  to: unknown;
}

/**
 * Field-level diff of an operation.
 *
 * Keys are dotted paths into the document, with array members addressed by
 * index: `title`, `seo.metaTitle`, `blocks[2].heading`.
 */
export type AuditChangeSet = Record<string, AuditChange>;

/** Identity of the actor, snapshotted at write time so it survives user deletion. */
export interface AuditActor {
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
}

/** Request metadata, captured opportunistically — every field may be absent. */
export interface AuditRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Everything the audit service needs to know about who/where, resolved once per operation. */
export interface AuditContext extends AuditActor, AuditRequestContext {
  source: AuditSource;
}

/** A persisted audit record, as returned by the plugin's admin API. */
export interface AuditLog extends AuditContext {
  id: number;
  /** The audit record's own Strapi v5 document id — not the audited document's. */
  documentId: string;
  action: AuditAnyAction | string;
  /** UID of the audited content type, e.g. `api::page.page`. */
  contentType: string;
  /** Human-readable name of the audited content type at the time of the write. */
  contentTypeDisplayName: string | null;
  /**
   * The audited document's Strapi v5 document id.
   *
   * Not called `documentId`: Strapi v5 reserves that attribute name on every
   * content type and throws at boot if a schema declares it.
   */
  contentDocumentId: string | null;
  /** The audited entry's numeric database id, as a string. */
  contentId: string | null;
  locale: string | null;
  changes: AuditChangeSet | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** `failure` for a rejected login or a denied request; `success` for everything else. */
  outcome: AuditOutcome | null;
  /** Action-specific detail — see {@link AuditMetadata}. */
  metadata: AuditMetadata | null;
  /**
   * SHA-256 over this record's hashed fields and `prevHash`, as lowercase hex.
   *
   * `null` on rows written before 1.2.0, which predate the chain. See
   * `services/integrity.ts` for what is hashed and why.
   */
  hash: string | null;
  /** The `hash` of the record written immediately before this one. */
  prevHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Selects which content types are audited. `'*'` means every content type. */
export type ContentTypeSelector = '*' | string[];

/** How the audit row is persisted relative to the content operation. */
export type AuditWriteMode = 'sync' | 'async';

/**
 * Plugin configuration, after defaults have been resolved.
 *
 * See {@link AuditUserConfig} for the shape accepted in `config/plugins.ts`.
 */
export interface AuditConfig {
  actions: AuditAction[];
  contentTypes: ContentTypeSelector;
  ignoredContentTypes: string[];
  ignoredFields: string[];
  additionalIgnoredFields: string[];
  ignoredChangeFields: string[];
  storeBefore: boolean;
  storeAfter: boolean;
  storeChanges: boolean;
  retentionDays: number;
  retentionCron: string;
  failOnAuditError: boolean;
  writeMode: AuditWriteMode;
  maxPopulateDepth: number;
  maxSnapshotBytes: number;
  auditSystemOperations: boolean;
  /** Which security events to record. `'*'` is all of them; `[]` disables the listeners entirely. */
  securityEvents: SecurityEventSelector;
  /** Mirror every record to `strapi.log` as one line of structured JSON, for a SIEM to pick up off stdout. */
  forwardToLogger: boolean;
  /** Level the mirrored line is written at. */
  forwardLogLevel: AuditLogLevel;
  /**
   * Mint a request id for requests that arrive without one, and echo it back as
   * `X-Request-Id`. Every request-borne record then carries a correlation id.
   */
  correlationId: boolean;
}

/** Result of walking the hash chain. */
export interface IntegrityReport {
  /** True when every hashed record links to its predecessor and matches its own digest. */
  ok: boolean;
  /** Rows examined, hashed or not. */
  checked: number;
  /** Rows that carry a hash and were verified. */
  hashed: number;
  /** Rows written before the chain existed. Counted, never linked. */
  legacy: number;
  /** The most recent record, which is where the next write will link from. */
  head: { id: number; hash: string } | null;
  /** The first hashed record — its `prevHash` points at something retention may have removed. */
  start: { id: number } | null;
  /** First record that failed verification, with the reason. Absent when `ok`. */
  brokenAt?: { id: number; reason: string };
  /** When the walk ran, so a report can be dated. */
  verifiedAt: string;
}

/** Levels `strapi.log` exposes that make sense for an audit mirror. */
export type AuditLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Configuration as written by a consumer — every key optional. */
export type AuditUserConfig = Partial<AuditConfig>;

/** Payload handed to the audit service for persistence. */
export interface AuditEntryInput extends AuditContext {
  action: AuditAnyAction;
  contentType: string;
  contentTypeDisplayName: string | null;
  contentDocumentId: string | null;
  contentId: string | null;
  locale: string | null;
  changes: AuditChangeSet | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Defaults to `success` when omitted — see {@link AuditOutcome}. */
  outcome?: AuditOutcome | null;
  metadata?: AuditMetadata | null;
}

/** Filters accepted by the admin list endpoint. */
export interface AuditLogQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  action?: string | string[];
  contentType?: string | string[];
  userId?: string | string[];
  locale?: string | string[];
  source?: string | string[];
  outcome?: string | string[];
  contentDocumentId?: string;
  dateFrom?: string;
  dateTo?: string;
  _q?: string;
}

/** Shape returned by `GET /audit-log/logs`. */
export interface AuditLogListResult {
  results: AuditLog[];
  pagination: {
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
  };
}

/** Distinct values behind the admin list's filter dropdowns. */
export interface AuditFilterOptions {
  contentTypes: Array<{ uid: string; displayName: string }>;
  users: Array<{ userId: string; label: string }>;
  locales: string[];
  actions: string[];
  sources: string[];
  outcomes: string[];
}
