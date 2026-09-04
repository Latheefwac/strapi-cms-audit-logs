import type { Core } from '@strapi/strapi';

import { SKIPPED_ATTRIBUTES } from '../constants';
import { sanitizeValue } from '../utils/sanitize';
import type { AuditAction, AuditEntryInput } from '../types';
import type { ResolvedConfig } from './config';
import type { SnapshotQuery } from './snapshot';

type Row = Record<string, any>;

/** The Document Service actions this plugin reacts to, mapped to audit actions. */
const TRACKED_ACTIONS: Record<string, AuditAction> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  publish: 'publish',
  unpublish: 'unpublish',
};

export interface DocumentMiddlewareContext {
  uid: string;
  action: string;
  contentType?: Record<string, any>;
  params: Record<string, any>;
}

const asId = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Locales an operation touches.
 *
 * `publish`/`unpublish`/`delete` accept `'*'` or an array, so a single call can
 * span every translation of a document. Returning `null` means "whatever the
 * default resolves to" and leaves the locale out of the lookup, which matches
 * what the Document Service itself does.
 */
const paramLocales = (params: Record<string, any>): string[] | null => {
  const { locale } = params;
  if (locale === undefined || locale === null || locale === '*') return null;
  if (Array.isArray(locale)) return locale.map(String);
  return [String(locale)];
};

/**
 * Global interception of content writes.
 *
 * Registered once with `strapi.documents.use()`, which is the Strapi v5
 * replacement for per-content-type lifecycles and the reason a consuming
 * application never writes a line of audit code. Three properties make this the
 * right layer, and `db.lifecycles` the wrong one:
 *
 *  1. It sees the *semantic* action. `publish` and `unpublish` are ordinary row
 *     inserts and deletes to the database layer; only the Document Service knows
 *     they were a publish.
 *  2. It runs *outside* the write's transaction (`middlewares.wrapObject` wraps
 *     the already-transaction-wrapped repository methods), so an audit failure
 *     can never roll back an editor's save, and an audit insert never holds a
 *     row lock open.
 *  3. It sees `documentId` and `locale` as first-class parameters rather than
 *     having to reconstruct them from a row.
 *
 * Every operation the Content Manager, the REST/GraphQL content API and custom
 * server code perform goes through this facade, so all three are covered by the
 * one registration.
 */
const trackerService = ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = () => strapi.plugin('audit-log');
  const getConfig = (): ResolvedConfig => plugin().service('config').resolve();

  const displayNameOf = (uid: string): string | null => {
    try {
      const schema = strapi.getModel(uid as never) as Record<string, any> | undefined;
      return schema?.info?.displayName ?? schema?.info?.singularName ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Attributes an update touched.
   *
   * Restricting the snapshot to these is what keeps auditing a two-field edit on
   * a 173-widget page cheap. `null` means "no data payload" — a publish or a
   * delete — and asks the snapshot builder for the whole (still shallow)
   * document.
   */
  const changedKeys = (uid: string, params: Record<string, any>): string[] | null => {
    const data = params?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    let attributes: Record<string, unknown> = {};
    try {
      attributes = ((strapi.getModel(uid as never) as Record<string, any>)?.attributes ?? {}) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }

    const keys = Object.keys(data).filter(
      (key) => key in attributes && !SKIPPED_ATTRIBUTES.has(key)
    );

    return keys.length > 0 ? keys : [];
  };

  /**
   * Reads one snapshot per affected locale, keyed by locale.
   *
   * `__default__` covers content types without i18n, which have no locale column
   * at all and so always produce exactly one row.
   */
  const snapshotByLocale = async (
    uid: string,
    documentId: string,
    locales: string[] | null,
    status: 'draft' | 'published' | 'any',
    query: SnapshotQuery,
    depth: number
  ): Promise<Map<string, Row>> => {
    const snapshot = plugin().service('snapshot');
    const rows: Row[] = await snapshot.fetchRows(uid, { documentId, locales, status }, query, depth);

    const byLocale = new Map<string, Row>();
    for (const row of rows) byLocale.set(row.locale ?? '__default__', row);
    return byLocale;
  };

  const localeKey = (row: Row | null | undefined): string => row?.locale ?? '__default__';

  /**
   * Normalises what each Document Service action returns into a flat row list.
   *
   * `create`/`update` resolve to a single entry (or `null` when an update
   * matched nothing); `delete`/`publish`/`unpublish` resolve to
   * `{ documentId, entries }`, one entry per locale.
   */
  const resultRows = (result: unknown): Row[] => {
    if (!result) return [];
    const asRecord = result as Row;
    if (Array.isArray(asRecord.entries)) return asRecord.entries as Row[];
    return [asRecord];
  };

  /**
   * Collapses the result to one row per locale.
   *
   * Deleting a document with draft & publish enabled removes *two* rows per
   * locale — the draft and the published version — and the Document Service
   * returns both. Two audit records for one editor action would double-count
   * every deletion, so the draft wins: it is the version an editor was working
   * on and the one whose content the audit trail should preserve.
   */
  const dedupeByLocale = (rows: Row[]): Row[] => {
    const byLocale = new Map<string, Row>();

    for (const row of rows) {
      const key = localeKey(row);
      const existing = byLocale.get(key);
      if (!existing || (existing.publishedAt != null && row.publishedAt == null)) {
        byLocale.set(key, row);
      }
    }

    return [...byLocale.values()];
  };

  const buildEntries = async (
    ctx: DocumentMiddlewareContext,
    action: AuditAction,
    result: unknown,
    before: Map<string, Row>,
    query: SnapshotQuery,
    keys: string[] | null
  ): Promise<AuditEntryInput[]> => {
    const config = getConfig();
    const snapshot = plugin().service('snapshot');
    const diff = plugin().service('diff');
    const auditContext = plugin().service('context').resolve();

    const { uid } = ctx;
    const rows = dedupeByLocale(resultRows(result));

    // `create` learns the documentId only from its result; everything else was
    // given one as a parameter.
    const documentId =
      asId(ctx.params?.documentId) ?? asId((result as Row)?.documentId) ?? asId(rows[0]?.documentId);

    /**
     * The state to compare against.
     *
     * Re-read with the *same* query shape as `before` rather than reusing the
     * operation's own result. The Content Manager hands back a deeply populated
     * document while our `before` is deliberately shallow, so diffing one
     * against the other would report every un-populated nested field as a
     * deletion. One extra narrow query buys a diff that is actually correct.
     */
    let after = new Map<string, Row>();

    const needsAfter =
      (config.storeAfter || config.storeChanges) && action !== 'delete' && action !== 'unpublish';

    if (needsAfter && documentId) {
      const locales = rows.length > 0 ? rows.map((row) => row.locale).filter(Boolean) : paramLocales(ctx.params);
      after = await snapshotByLocale(
        uid,
        documentId,
        locales as string[] | null,
        action === 'publish' ? 'published' : 'draft',
        query,
        config.maxPopulateDepth
      );
    }

    const displayName = displayNameOf(uid);

    // One audit record per affected entry. A bulk publish across six locales is
    // six records, because six documents changed — collapsing them would make
    // "who published the German page" unanswerable.
    const targets: Array<{ locale: string | null; row: Row | null }> =
      rows.length > 0
        ? rows.map((row) => ({ locale: row.locale ?? null, row }))
        : [...(before.size > 0 ? before.values() : [])].map((row) => ({ locale: row.locale ?? null, row }));

    if (targets.length === 0) return [];

    return targets.map(({ locale, row }) => {
      const key = localeKey(row);

      const beforeRow = before.get(key) ?? null;
      const afterRow = after.get(key) ?? (action === 'delete' || action === 'unpublish' ? null : row);

      const beforeSnapshot = sanitizeValue(snapshot.toSnapshot(beforeRow), config.isIgnoredForSnapshot);
      const afterSnapshot = sanitizeValue(snapshot.toSnapshot(afterRow), config.isIgnoredForSnapshot);

      const changes = config.storeChanges
        ? diff.buildDiff(beforeSnapshot, afterSnapshot, {
            isIgnored: config.isIgnoredForChanges,
            keys: action === 'update' ? keys : null,
            maxDepth: Math.max(2, config.maxPopulateDepth + 3),
          })
        : null;

      return {
        action,
        contentType: uid,
        contentTypeDisplayName: displayName,
        contentDocumentId: documentId,
        contentId: asId(row?.id ?? beforeRow?.id),
        locale: locale ?? beforeRow?.locale ?? null,
        changes,
        before: config.storeBefore ? beforeSnapshot : null,
        after: config.storeAfter ? afterSnapshot : null,
        ...auditContext,
      } satisfies AuditEntryInput;
    });
  };

  /**
   * The middleware itself.
   *
   * Structured so the original operation is never at the mercy of the audit
   * subsystem: the pre-write snapshot is wrapped in its own guard, `next()` is
   * always reached, and the post-write bookkeeping is guarded again. With
   * `failOnAuditError: false` (the default) an audit failure produces a log line
   * and nothing else — an editor is never blocked from saving because the audit
   * table is unreachable.
   */
  const createMiddleware = () => {
    return async (ctx: DocumentMiddlewareContext, next: () => Promise<unknown>): Promise<unknown> => {
      // Cheapest check first: this middleware sits in front of every document
      // read as well as every write, and `findMany` must reach `next()` having
      // done nothing but one map lookup.
      const action = TRACKED_ACTIONS[ctx.action];
      if (!action) return next();

      const configService = plugin().service('config');
      if (!configService.isAuditedContentType(ctx.uid) || !configService.isAuditedAction(action)) {
        return next();
      }

      const config = getConfig();

      let before = new Map<string, Row>();
      let query: SnapshotQuery = { select: [], populate: undefined, dynamicZones: [] };
      let keys: string[] | null = null;

      const onError = (stage: string, error: unknown): void => {
        const message = (error as Error)?.message ?? String(error);
        strapi.log.error(`[audit-log] ${stage} failed for ${action} on ${ctx.uid}: ${message}`);
        if (config.failOnAuditError) throw error;
      };

      try {
        keys = action === 'update' ? changedKeys(ctx.uid, ctx.params) : null;

        query = plugin()
          .service('snapshot')
          .buildSnapshotQuery(ctx.uid, keys, {
            depth: config.maxPopulateDepth,
            isIgnored: config.isIgnoredForSnapshot,
          });

        const documentId = asId(ctx.params?.documentId);
        const needsBefore = (config.storeBefore || config.storeChanges) && action !== 'create';

        if (needsBefore && documentId) {
          before = await snapshotByLocale(
            ctx.uid,
            documentId,
            paramLocales(ctx.params),
            // A publish diffs the version being replaced; everything else works
            // against the draft the editor was editing.
            action === 'publish' || action === 'unpublish' ? 'published' : 'draft',
            query,
            config.maxPopulateDepth
          );
        }
      } catch (error) {
        onError('pre-write snapshot', error);
      }

      const result = await next();

      try {
        // A create that was asked for `status: 'published'` publishes inside the
        // repository, by calling the local `publish()` rather than the
        // middleware-wrapped facade — so no `publish` action ever reaches this
        // middleware for it. Recording both keeps "when was this published"
        // answerable regardless of which API route created the document.
        const alsoPublished =
          (action === 'create' || action === 'update') &&
          ctx.params?.status === 'published' &&
          plugin().service('config').isAuditedAction('publish');

        const entries = await buildEntries(ctx, action, result, before, query, keys);
        for (const entry of entries) {
          await plugin().service('audit').record(entry);
        }

        if (alsoPublished) {
          for (const entry of entries) {
            await plugin().service('audit').record({ ...entry, action: 'publish' });
          }
        }
      } catch (error) {
        onError('audit write', error);
      }

      return result;
    };
  };

  /** Adds the tracker to the Document Service chain, for the lifetime of the process. */
  const register = (): void => {
    strapi.documents.use(createMiddleware() as never);
  };

  return { createMiddleware, register, changedKeys, resultRows };
};

export default trackerService;
