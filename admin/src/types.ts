/**
 * Wire types for the plugin's admin API.
 *
 * These describe JSON as it arrives over HTTP, which is not quite the server's
 * own model: `Date` columns are ISO strings here, and the compiled ignore-list
 * matchers on `AuditConfig` never cross the wire. The canonical definitions live
 * in `server/src/types` and are re-exported from
 * `strapi-cms-audit-log/strapi-server`; see the note there on why the two
 * halves cannot share one module.
 */

export type AuditAction = 'create' | 'update' | 'delete' | 'publish' | 'unpublish';

/**
 * Operations recorded outside the Document Service: authentication, denied
 * requests, and changes to the admin users, roles, permissions and media that
 * govern everything else.
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

/** The audit log's own maintenance: the retention purge recording itself. */
export type AuditMaintenanceAction = 'retention.purge';

export type AuditAnyAction = AuditAction | AuditSecurityAction | AuditMaintenanceAction;

/** Whether the recorded attempt succeeded. Only security actions are ever `failure`. */
export type AuditOutcome = 'success' | 'failure';

export type AuditSource = 'admin' | 'api' | 'system' | 'cron' | 'migration' | 'unknown';

export interface AuditChange {
  from: unknown;
  to: unknown;
}

export type AuditChangeSet = Record<string, AuditChange>;

export interface AuditLog {
  id: number;
  documentId: string;
  action: AuditAnyAction | string;
  contentType: string;
  contentTypeDisplayName: string | null;
  contentDocumentId: string | null;
  contentId: string | null;
  locale: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  source: AuditSource | string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  changes: AuditChangeSet | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  outcome: AuditOutcome | null;
  /** Action-specific detail: the reason a login failed, the path of a denied request, an upload's filename. */
  metadata: Record<string, unknown> | null;
  /** SHA-256 of this record and its predecessor's hash. Null on rows written before the chain existed. */
  hash: string | null;
  prevHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Verdict of a full walk of the hash chain. Mirrors the server's `IntegrityReport`. */
export interface IntegrityReport {
  ok: boolean;
  checked: number;
  hashed: number;
  legacy: number;
  head: { id: number; hash: string } | null;
  start: { id: number } | null;
  brokenAt?: { id: number; reason: string };
  verifiedAt: string;
}

export interface AuditPagination {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

export interface AuditLogListResponse {
  results: AuditLog[];
  pagination: AuditPagination;
}

export interface AuditFilterOptions {
  contentTypes: Array<{ uid: string; displayName: string }>;
  users: Array<{ userId: string; label: string }>;
  locales: string[];
  actions: string[];
  sources: string[];
  outcomes: string[];
}

/** Query-string state owned by the list page. Mirrors what the server accepts. */
export interface AuditListQuery {
  page?: string | number;
  pageSize?: string | number;
  sort?: string;
  action?: string;
  contentType?: string;
  userId?: string;
  locale?: string;
  source?: string;
  outcome?: string;
  contentDocumentId?: string;
  dateFrom?: string;
  dateTo?: string;
  _q?: string;
}
