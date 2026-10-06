import type { Core } from '@strapi/strapi';

import {
  ALL_MAINTENANCE_ACTIONS,
  ALL_SECURITY_ACTIONS,
  ALL_SOURCES,
  AUDIT_LOG_UID,
  CHAIN_LOCK_KEY,
  CONTENT_ACTIONS,
  PLUGIN_ID,
  SUBJECTS,
  SUBJECT_DISPLAY_NAMES,
} from '../constants';
import { approximateJsonBytes } from '../utils/json';
import type {
  AuditEntryInput,
  AuditFilterOptions,
  AuditLog,
  AuditLogListResult,
  AuditLogQuery,
} from '../types';
import type { ResolvedConfig } from './config';

/** Columns a client is allowed to sort by. Anything else is rejected, not silently ignored. */
const SORTABLE_FIELDS = new Set([
  'createdAt',
  'action',
  'contentType',
  'userEmail',
  'userName',
  'locale',
  'source',
  'outcome',
  'id',
]);

/** Columns `_q` searches. All are short, indexed or low-cardinality text. */
const SEARCHABLE_FIELDS = [
  'contentDocumentId',
  'contentId',
  'contentType',
  'contentTypeDisplayName',
  'userEmail',
  'userName',
  'requestId',
  'ipAddress',
];

const MAX_PAGE_SIZE = 100;

const toArray = (value: string | string[] | undefined): string[] => {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim()).filter((item) => item.length > 0);
};

const toPositiveInt = (value: unknown, fallback: number, max?: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
};

/**
 * Persistence and retrieval of audit records.
 *
 * Every database call goes through `strapi.db.query`, never the Document
 * Service. That is deliberate on both ends: writes must not re-enter the
 * middleware that produced them, and reads must not be reshaped by document
 * middlewares a consuming application has registered for its own content.
 */
const auditService = ({ strapi }: { strapi: Core.Strapi }) => {
  /**
   * Pending writes for `writeMode: 'async'`.
   *
   * Held so `destroy()` can drain them: fire-and-forget that cannot be flushed
   * is how audit records go missing on a redeploy.
   */
  const pending = new Set<Promise<unknown>>();

  const getConfig = (): ResolvedConfig =>
    strapi.plugin('audit-log').service('config').resolve() as ResolvedConfig;

  /**
   * Drops a snapshot that would bloat the row.
   *
   * A single 40MB dynamic zone is not a useful audit artefact — it is a
   * denial-of-service against the audit table. The record is still written, with
   * a marker in place of the blob, so the *fact* of the change survives even
   * when its detail does not.
   */
  const capSnapshot = (
    value: Record<string, unknown> | null,
    maxBytes: number,
    label: string
  ): Record<string, unknown> | null => {
    if (!value || maxBytes <= 0) return value;

    const bytes = approximateJsonBytes(value);
    if (bytes <= maxBytes) return value;

    strapi.log.warn(
      `[audit-log] ${label} snapshot dropped: ~${bytes} bytes exceeds maxSnapshotBytes (${maxBytes}).`
    );
    return { __omitted__: `Snapshot omitted: ~${bytes} bytes exceeds maxSnapshotBytes (${maxBytes}).` };
  };

  /**
   * In-process serialisation of chain writes.
   *
   * Two records written concurrently would both read the same head, both claim
   * it as their predecessor, and fork the chain — which the verifier would then
   * report as tampering. Within one process a promise queue is enough; across
   * replicas the database lock in `withChainLock` does the same job.
   */
  let chainQueue: Promise<unknown> = Promise.resolve();

  const serialised = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chainQueue.then(task, task);
    // Keep the queue alive past a failure, or one bad write blocks every later one.
    chainQueue = run.catch(() => undefined);
    return run;
  };

  /**
   * Runs `task` holding a database-level lock on the chain.
   *
   * Needed because production runs more than one Strapi replica, and an
   * in-process mutex knows nothing about the others. A transaction-scoped
   * advisory lock is the lightest thing that serialises across processes: it is
   * released at commit, it locks nothing but the chain, and on PostgreSQL it is
   * a single round trip. MySQL has an equivalent. SQLite has one writer by
   * construction and needs nothing.
   *
   * `trx.raw` rather than `strapi.db.connection.raw`: the latter would take a
   * *different* pooled connection, and an advisory lock on the wrong connection
   * serialises nothing at all.
   */
  const withChainLock = <T>(task: () => Promise<T>): Promise<T> =>
    // `transaction` types its result as the callback's own return, which for an
    // async callback is a Promise of a Promise; at runtime it is flattened.
    (strapi.db.transaction(async ({ trx }: { trx: any }) => {
      const client = String((strapi.db as any).dialect?.client ?? '');

      if (client === 'postgres') {
        await trx.raw('select pg_advisory_xact_lock(?)', [CHAIN_LOCK_KEY]);
      } else if (client === 'mysql') {
        // GET_LOCK is session-scoped, not transaction-scoped, so release it
        // explicitly; a 10s wait is far past anything a single insert needs.
        await trx.raw('select get_lock(?, 10)', [`audit-log-chain-${CHAIN_LOCK_KEY}`]);
        try {
          return await task();
        } finally {
          await trx.raw('select release_lock(?)', [`audit-log-chain-${CHAIN_LOCK_KEY}`]);
        }
      }

      return task();
    }) as unknown) as Promise<T>;

  const write = async (entry: AuditEntryInput): Promise<void> => {
    const config = getConfig();
    const integrity = strapi.plugin(PLUGIN_ID).service('integrity');

    const data: Record<string, unknown> = {
      action: entry.action,
      contentType: entry.contentType,
      contentTypeDisplayName: entry.contentTypeDisplayName,
      contentDocumentId: entry.contentDocumentId,
      contentId: entry.contentId,
      locale: entry.locale,
      userId: entry.userId,
      userEmail: entry.userEmail,
      userName: entry.userName,
      changes: config.storeChanges ? entry.changes : null,
      before: capSnapshot(config.storeBefore ? entry.before : null, config.maxSnapshotBytes, 'before'),
      after: capSnapshot(config.storeAfter ? entry.after : null, config.maxSnapshotBytes, 'after'),
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      source: entry.source,
      requestId: entry.requestId,
      // A content write only ever reaches the tracker once it has succeeded,
      // so the default is the honest value rather than a placeholder.
      outcome: entry.outcome ?? 'success',
      metadata: entry.metadata ?? null,
      // Set here rather than left to the database's timestamp hook, because it
      // is part of the hash: a record whose time can be changed without
      // detection is a record whose place in the story can be changed.
      createdAt: new Date(),
    };

    const created = await serialised(() =>
      withChainLock(async () => {
        const [head] = (await strapi.db.query(AUDIT_LOG_UID).findMany({
          select: ['id', 'hash'],
          orderBy: { id: 'desc' },
          limit: 1,
        })) as Array<{ id: number; hash: string | null }>;

        // A head with no hash is a pre-1.2.0 row: the chain starts here rather
        // than pretending to link to something that was never hashed.
        data.prevHash = head?.hash ?? null;
        data.hash = integrity.computeHash(data);

        return (await strapi.db.query(AUDIT_LOG_UID).create({ data })) as AuditLog;
      })
    );

    if (config.forwardToLogger) forwardToLogger(entry, config, created);
  };

  /**
   * Mirrors one record to `strapi.log` as a single line of structured JSON.
   *
   * This is the whole of the plugin's "centralized logging / SIEM" story, and
   * deliberately so. Every deployment target — ECS, Kubernetes, Heroku, a bare
   * systemd unit — already ships process stdout somewhere, and every log
   * pipeline worth the name already parses JSON off it. Emitting a line costs
   * nothing, needs no credentials, cannot block a request and cannot fail in a
   * way that loses the database row, which is more than can be said for an
   * in-process HTTP forwarder holding a retry queue.
   *
   * The snapshots are deliberately *not* included. They are unbounded — a page
   * with a large dynamic zone runs to megabytes — and a log pipeline is the
   * wrong place to store them; the row in `audit_logs` is the record of truth
   * and `auditLogId` points straight at it.
   */
  const forwardToLogger = (
    entry: AuditEntryInput,
    config: ResolvedConfig,
    created?: Pick<AuditLog, 'id' | 'hash' | 'prevHash'> | null
  ): void => {
    try {
      const line = JSON.stringify({
        type: 'audit-log',
        // The row's identity and its place in the chain, so the external copy
        // can be reconciled against the database — and can prove a row that
        // has since vanished from it was there.
        id: created?.id ?? null,
        hash: created?.hash ?? null,
        prevHash: created?.prevHash ?? null,
        action: entry.action,
        outcome: entry.outcome ?? 'success',
        contentType: entry.contentType,
        contentDocumentId: entry.contentDocumentId,
        contentId: entry.contentId,
        locale: entry.locale,
        userId: entry.userId,
        userEmail: entry.userEmail,
        userName: entry.userName,
        source: entry.source,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        requestId: entry.requestId,
        // Paths only. The values are in the database row; what a SIEM rule needs
        // is "which fields moved", and that is what alerts can be written against.
        changedPaths: entry.changes ? Object.keys(entry.changes) : [],
        metadata: entry.metadata ?? null,
        at: new Date().toISOString(),
      });

      // `forwardLogLevel` is validated at boot against exactly these four names,
      // so the lookup is safe; the cast is only to stop `Logger` being indexed
      // by a union it does not declare an index signature for.
      (strapi.log as unknown as Record<string, (message: string) => void>)[config.forwardLogLevel]!(
        line
      );
    } catch (error) {
      // Forwarding is a mirror of a row that is already committed. It must never
      // be the reason an audited operation reports a failure.
      strapi.log.debug(`[audit-log] logger forwarding skipped: ${(error as Error)?.message ?? error}`);
    }
  };

  /**
   * Persists one audit record.
   *
   * ## Synchronous by default, and why
   *
   * The row is written *after* the content operation resolves, so it never
   * extends the operation's database transaction — Document Service middleware
   * runs outside `wrapInTransaction`, which is precisely why this plugin hooks
   * there rather than into `db.lifecycles`. What `sync` mode adds is that the
   * insert is awaited before the HTTP response is produced. That costs one
   * single-row INSERT (sub-millisecond on every supported database) and buys the
   * guarantee an audit trail exists for: once the editor sees "saved", the
   * record is durably on disk. A crash, a redeploy or a scaled-down container
   * cannot lose it.
   *
   * `writeMode: 'async'` trades that guarantee for the millisecond. The write is
   * still tracked and drained on shutdown, so an orderly stop loses nothing, but
   * a hard kill between the response and the flush will. Choose it only if that
   * is acceptable for your compliance story.
   */
  const record = async (entry: AuditEntryInput): Promise<void> => {
    const config = getConfig();

    if (config.writeMode === 'async') {
      const task = write(entry)
        .catch((error: unknown) => {
          strapi.log.error(
            `[audit-log] failed to persist ${entry.action} on ${entry.contentType}: ${
              (error as Error)?.message ?? error
            }`
          );
        })
        .finally(() => {
          pending.delete(task);
        });

      pending.add(task);
      return;
    }

    await write(entry);
  };

  /** Awaits every in-flight async write. Called from the plugin's `destroy`. */
  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    await Promise.allSettled([...pending]);
  };

  const buildWhere = (query: AuditLogQuery): Record<string, unknown> => {
    const where: Record<string, unknown> = {};

    const inFilter = (values: string[]): unknown | undefined => {
      if (values.length === 0) return undefined;
      return values.length === 1 ? values[0] : { $in: values };
    };

    const action = inFilter(toArray(query.action));
    if (action !== undefined) where.action = action;

    const contentType = inFilter(toArray(query.contentType));
    if (contentType !== undefined) where.contentType = contentType;

    const userId = inFilter(toArray(query.userId));
    if (userId !== undefined) where.userId = userId;

    const locale = inFilter(toArray(query.locale));
    if (locale !== undefined) where.locale = locale;

    const source = inFilter(toArray(query.source));
    if (source !== undefined) where.source = source;

    const outcome = inFilter(toArray(query.outcome));
    if (outcome !== undefined) where.outcome = outcome;

    if (query.contentDocumentId) {
      where.contentDocumentId = String(query.contentDocumentId).trim();
    }

    // Both bounds are optional and independently applied, so "everything since
    // Monday" and "everything before the incident" are both single-field queries.
    const createdAt: Record<string, string> = {};
    const from = query.dateFrom ? new Date(query.dateFrom) : null;
    const to = query.dateTo ? new Date(query.dateTo) : null;

    if (from && !Number.isNaN(from.getTime())) createdAt.$gte = from.toISOString();
    if (to && !Number.isNaN(to.getTime())) createdAt.$lte = to.toISOString();
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    const search = query._q ? String(query._q).trim() : '';
    if (search.length > 0) {
      where.$or = SEARCHABLE_FIELDS.map((field) => ({ [field]: { $containsi: search } }));
    }

    return where;
  };

  const parseSort = (sort: string | undefined): Record<string, 'asc' | 'desc'> => {
    const fallback = { createdAt: 'desc' as const };
    if (!sort) return fallback;

    const [field, rawDirection] = String(sort).split(':');
    if (!field || !SORTABLE_FIELDS.has(field)) return fallback;

    return { [field]: rawDirection?.toLowerCase() === 'asc' ? 'asc' : 'desc' };
  };

  /**
   * Paginated, filtered list for the admin panel.
   *
   * Filtering, sorting and pagination all happen in SQL. The admin never
   * receives more than one page, which matters: an audit table is the one table
   * in a Strapi project guaranteed to grow without bound.
   */
  const find = async (query: AuditLogQuery = {}): Promise<AuditLogListResult> => {
    const page = toPositiveInt(query.page, 1);
    const pageSize = toPositiveInt(query.pageSize, 20, MAX_PAGE_SIZE);

    const { results, pagination } = (await strapi.db.query(AUDIT_LOG_UID).findPage({
      where: buildWhere(query),
      orderBy: parseSort(query.sort),
      page,
      pageSize,
    })) as { results: AuditLog[]; pagination: AuditLogListResult['pagination'] };

    return { results, pagination };
  };

  const findOne = async (id: number): Promise<AuditLog | null> =>
    (await strapi.db.query(AUDIT_LOG_UID).findOne({ where: { id } })) as AuditLog | null;

  const deleteOlderThan = async (date: Date): Promise<number> => {
    const { count } = (await strapi.db.query(AUDIT_LOG_UID).deleteMany({
      where: { createdAt: { $lt: date.toISOString() } },
    })) as { count: number };

    return count;
  };

  /**
   * Content types and users that *could* appear in the log, from the live
   * registries rather than from the rows already written.
   *
   * Without this the dropdowns only offer what has already happened, which reads
   * as a bug the first time someone opens the page: a fresh install lists two or
   * three content types and one user, and there is no way to ask "has anyone
   * touched Insights?" until somebody already has. Filtering is most useful
   * precisely when the answer is "nothing yet".
   *
   * Only types this plugin would actually audit are listed — asking the config
   * rather than assuming — so narrowing `contentTypes` narrows the dropdown to
   * match, and the plugin's own collection type never appears.
   */
  const registryOptions = (): Pick<AuditFilterOptions, 'contentTypes'> => {
    const configService = strapi.plugin(PLUGIN_ID).service('config');
    const contentTypes: AuditFilterOptions['contentTypes'] = [];

    try {
      const registry = (strapi.contentTypes ?? {}) as unknown as Record<string, Record<string, any>>;

      for (const [uid, schema] of Object.entries(registry)) {
        // `admin::` and `strapi::` are Strapi's own bookkeeping — tokens, core
        // store, workflow internals. They are not document-service types, so
        // they can never produce a content record, and listing eighty of them
        // would bury the fifty that matter. The handful of `admin::` subjects
        // the security listeners *do* write are added separately below.
        if (!uid.startsWith('api::') && !uid.startsWith('plugin::')) continue;
        if (!configService.isAuditedContentType(uid)) continue;

        contentTypes.push({
          uid,
          displayName: schema?.info?.displayName ?? schema?.info?.singularName ?? uid,
        });
      }
    } catch (error) {
      strapi.log.debug(
        `[audit-log] could not read the content-type registry for filters: ${(error as Error)?.message ?? error}`
      );
    }

    // The subsystems the security listeners write against. They are not content
    // types, so nothing above would ever surface them.
    if (configService.hasSecurityEvents()) {
      for (const uid of Object.values(SUBJECTS)) {
        contentTypes.push({ uid, displayName: SUBJECT_DISPLAY_NAMES[uid] ?? uid });
      }
    }

    return { contentTypes };
  };

  /**
   * Every configured locale, so a translation can be filtered for before anyone
   * has edited it. Empty on a project without i18n, which is correct — the
   * column is null throughout and the dropdown has nothing to offer.
   */
  const configuredLocales = async (): Promise<string[]> => {
    try {
      if (!strapi.plugin('i18n')) return [];

      const locales = (await strapi.db.query('plugin::i18n.locale').findMany({
        select: ['code'],
      })) as Array<{ code?: string }>;

      return locales.map((locale) => locale.code).filter((code): code is string => Boolean(code));
    } catch (error) {
      strapi.log.debug(
        `[audit-log] could not read locales for filters: ${(error as Error)?.message ?? error}`
      );
      return [];
    }
  };

  /** Every admin user, so the filter can name someone who has not acted yet. */
  const adminUsers = async (): Promise<AuditFilterOptions['users']> => {
    try {
      const users = (await strapi.db.query('admin::user').findMany({
        select: ['id', 'email', 'firstname', 'lastname', 'username'],
      })) as Array<Record<string, unknown>>;

      return users.map((user) => {
        const firstname = user.firstname ? String(user.firstname).trim() : '';
        const lastname = user.lastname ? String(user.lastname).trim() : '';
        const name = [firstname, lastname].filter(Boolean).join(' ');

        return {
          userId: String(user.id),
          // Email first: it is the identifier an auditor is given in a ticket,
          // and it is unique where a display name is not.
          label: String(user.email ?? user.username ?? name ?? user.id),
        };
      });
    } catch (error) {
      strapi.log.debug(
        `[audit-log] could not read admin users for filters: ${(error as Error)?.message ?? error}`
      );
      return [];
    }
  };

  /**
   * Values for the list page's filter dropdowns.
   *
   * The union of two sources, and both are needed:
   *
   *  - the **registries**, so every content type and every administrator is
   *    offered whether or not they already have a row;
   *  - the **stored rows**, so a content type that has since been deleted or
   *    renamed, or a user who has since been removed, still appears — those are
   *    exactly the entries an investigation goes looking for, and they exist
   *    nowhere else.
   *
   * The stored side is read with grouped `DISTINCT`s over indexed columns rather
   * than a row scan; deriving any of this client-side would mean shipping the
   * whole table to the browser, which is what pagination exists to prevent.
   */
  const getFilterOptions = async (): Promise<AuditFilterOptions> => {
    const registry = registryOptions();

    const fallback: AuditFilterOptions = {
      contentTypes: registry.contentTypes,
      users: await adminUsers(),
      locales: await configuredLocales(),
      actions: [...CONTENT_ACTIONS, ...ALL_SECURITY_ACTIONS, ...ALL_MAINTENANCE_ACTIONS],
      sources: [...ALL_SOURCES],
      outcomes: ['success', 'failure'],
    };

    let stored: AuditFilterOptions | null = null;

    try {
      stored = await readStoredOptions();
    } catch (error) {
      // Filter dropdowns are a convenience, not the feature. Degrading to the
      // registry-derived lists keeps the page fully usable; a 500 would take it
      // down entirely.
      strapi.log.error(
        `[audit-log] could not read stored filter options: ${(error as Error)?.message ?? error}`
      );
    }

    if (!stored) return sortOptions(fallback);

    return sortOptions({
      contentTypes: dedupeBy([...fallback.contentTypes, ...stored.contentTypes], (item) => item.uid),
      users: dedupeBy([...fallback.users, ...stored.users], (item) => item.userId),
      locales: [...new Set([...fallback.locales, ...stored.locales])],
      actions: [...new Set([...fallback.actions, ...stored.actions])],
      sources: [...new Set([...fallback.sources, ...stored.sources])],
      outcomes: [...new Set([...fallback.outcomes, ...stored.outcomes])],
    });
  };

  /** First occurrence wins, so the registry's live display name beats a snapshotted one. */
  const dedupeBy = <T>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Map<string, T>();
    for (const item of items) {
      const id = key(item);
      if (!seen.has(id)) seen.set(id, item);
    }
    return [...seen.values()];
  };

  /** Alphabetical by what the reader actually sees, not by uid. */
  const sortOptions = (options: AuditFilterOptions): AuditFilterOptions => ({
    ...options,
    contentTypes: [...options.contentTypes].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    ),
    users: [...options.users].sort((a, b) => a.label.localeCompare(b.label)),
    locales: [...options.locales].sort(),
    actions: [...options.actions].sort(),
    sources: [...options.sources].sort(),
    outcomes: [...options.outcomes].sort(),
  });

  /** The distinct values actually present in the table. */
  const readStoredOptions = (): Promise<AuditFilterOptions> =>
    // Never raw `strapi.db.connection`: from inside an open transaction it takes
    // a second pooled connection, and `Promise.all` below would take six. On the
    // transaction's one connection the six queries simply run in turn.
    (strapi.db.transaction(({ trx }: { trx: any }) => readStoredOptionsWith(trx)) as unknown) as
      Promise<AuditFilterOptions>;

  const readStoredOptionsWith = async (knex: any): Promise<AuditFilterOptions> => {
    const metadata = strapi.db.metadata.get(AUDIT_LOG_UID);
    const table = metadata.tableName;

    /**
     * Attribute name to physical column name.
     *
     * Read from the metadata rather than snake-cased by hand: Strapi shortens
     * identifiers that would exceed a dialect's length limit, so a hard-coded
     * `content_type_display_name` is a bug waiting for a longer table prefix.
     */
    const column = (attribute: string): string => {
      const meta = (metadata.attributes as Record<string, { columnName?: string }>)[attribute];
      return meta?.columnName ?? attribute;
    };

    const cols = {
      contentType: column('contentType'),
      contentTypeDisplayName: column('contentTypeDisplayName'),
      userId: column('userId'),
      userEmail: column('userEmail'),
      userName: column('userName'),
      locale: column('locale'),
      action: column('action'),
      source: column('source'),
      outcome: column('outcome'),
    };

    const [contentTypeRows, userRows, localeRows, actionRows, sourceRows, outcomeRows] =
      await Promise.all([
      knex(table).distinct(cols.contentType, cols.contentTypeDisplayName).orderBy(cols.contentType, 'asc'),
      knex(table)
        .distinct(cols.userId, cols.userEmail, cols.userName)
        .whereNotNull(cols.userId)
        .orderBy(cols.userId, 'asc'),
      knex(table).distinct(cols.locale).whereNotNull(cols.locale).orderBy(cols.locale, 'asc'),
      knex(table).distinct(cols.action).orderBy(cols.action, 'asc'),
      knex(table).distinct(cols.source).whereNotNull(cols.source).orderBy(cols.source, 'asc'),
      knex(table).distinct(cols.outcome).whereNotNull(cols.outcome).orderBy(cols.outcome, 'asc'),
    ]);

    const rows = <T = string>(input: unknown): Array<Record<string, T>> =>
      (Array.isArray(input) ? input : []) as Array<Record<string, T>>;

    return {
      contentTypes: rows(contentTypeRows).map((row) => ({
        uid: row[cols.contentType],
        displayName: row[cols.contentTypeDisplayName] || row[cols.contentType],
      })),
      users: rows(userRows).map((row) => ({
        userId: row[cols.userId],
        label: row[cols.userEmail] || row[cols.userName] || row[cols.userId],
      })),
      locales: rows(localeRows).map((row) => row[cols.locale]),
      actions: rows(actionRows).map((row) => row[cols.action]),
      sources: rows(sourceRows).map((row) => row[cols.source]),
      outcomes: rows(outcomeRows).map((row) => row[cols.outcome]),
    };
  };

  return {
    record,
    write,
    flush,
    find,
    findOne,
    deleteOlderThan,
    getFilterOptions,
    buildWhere,
    parseSort,
  };
};

export default auditService;
