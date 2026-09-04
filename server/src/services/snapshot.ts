import type { Core } from '@strapi/strapi';

import { SKIPPED_ATTRIBUTES } from '../constants';

type AnyAttribute = Record<string, any>;
type Row = Record<string, any>;

export interface SnapshotQuery {
  select: string[];
  populate?: Record<string, unknown>;
  /** Dynamic-zone attributes present in the query, for the optional refinement pass. */
  dynamicZones: string[];
}

export interface SnapshotLookup {
  documentId: string;
  locales?: string[] | null;
  status?: 'draft' | 'published' | 'any';
}

/** Identifying fields pulled for a related document. Never the whole related record. */
const RELATION_FIELDS = ['id', 'documentId'];

/** Enough to recognise a media change without pulling formats/provider metadata. */
const MEDIA_FIELDS = ['id', 'documentId', 'name', 'url', 'mime', 'size', 'alternativeText'];

/** Always fetched: they identify the row and fill the audit record's own columns. */
const META_FIELDS = ['id', 'documentId', 'locale', 'publishedAt'];

const isRelational = (attribute: AnyAttribute): boolean =>
  attribute?.type === 'relation' ||
  attribute?.type === 'component' ||
  attribute?.type === 'dynamiczone' ||
  attribute?.type === 'media';

/**
 * Builds the narrowest query that can answer "what did these fields look like?".
 *
 * This is the heart of the plugin's performance story. Strapi's own
 * `getDeepPopulate` walks the *schema* and asks for every relation, component
 * and media field a type could ever hold; on a page content type with 173
 * registered dynamic-zone widgets that is hundreds of joins to audit a
 * two-field edit. Here:
 *
 *  - the key set is the attributes the write actually touched, not the schema;
 *  - relations and media are reduced to identifying fields, so a relation to a
 *    50-field document costs a handful of columns rather than all of them;
 *  - dynamic zones are populated with `true`, which makes Strapi read the join
 *    table first and then issue one query per component type *actually present*
 *    in the rows. Five widgets used out of 173 registered means five queries,
 *    and the 168 unused schemas are never touched.
 */
const snapshotService = ({ strapi }: { strapi: Core.Strapi }) => {
  const getSchema = (uid: string): AnyAttribute | null => {
    try {
      return (strapi.getModel(uid as never) as AnyAttribute) ?? null;
    } catch {
      return null;
    }
  };

  const hasDraftAndPublish = (uid: string): boolean =>
    getSchema(uid)?.options?.draftAndPublish === true;

  const isLocalized = (uid: string): boolean =>
    getSchema(uid)?.pluginOptions?.i18n?.localized === true;

  /**
   * Populate spec for a component, derived from its own (static, small) schema.
   *
   * Safe to walk exhaustively: a component definition has a handful of fields,
   * and descending it costs no extra round trips — it only makes the single
   * query Strapi already issues for that component return more columns.
   */
  const buildComponentPopulate = (
    componentUid: string,
    depth: number
  ): Record<string, unknown> | true => {
    if (depth <= 0) return true;

    const schema = getSchema(componentUid);
    const attributes = (schema?.attributes ?? {}) as Record<string, AnyAttribute>;
    const populate: Record<string, unknown> = {};

    for (const [name, attribute] of Object.entries(attributes)) {
      if (!isRelational(attribute)) continue;

      switch (attribute.type) {
        case 'media':
          populate[name] = { select: MEDIA_FIELDS };
          break;
        case 'relation':
          populate[name] = { select: RELATION_FIELDS };
          break;
        case 'component':
          populate[name] = buildComponentPopulate(attribute.component, depth - 1);
          break;
        case 'dynamiczone':
          // Same reasoning as at the document level: never enumerate the
          // declared component list, let the data decide.
          populate[name] = true;
          break;
        default:
          break;
      }
    }

    return Object.keys(populate).length > 0 ? { populate } : true;
  };

  const buildSnapshotQuery = (
    uid: string,
    keys: string[] | null,
    options: { depth: number; isIgnored?: (path: string) => boolean }
  ): SnapshotQuery => {
    const { depth, isIgnored = () => false } = options;

    const schema = getSchema(uid);
    const attributes = (schema?.attributes ?? {}) as Record<string, AnyAttribute>;

    const select = new Set<string>();
    const populate: Record<string, unknown> = {};
    const dynamicZones: string[] = [];

    for (const field of META_FIELDS) {
      if (field === 'publishedAt' && !hasDraftAndPublish(uid)) continue;
      if (field === 'locale' && !isLocalized(uid)) continue;
      select.add(field);
    }

    const candidates = keys ?? Object.keys(attributes);

    for (const name of candidates) {
      const attribute = attributes[name];
      // A key that is not an attribute is either a typo in a payload or a
      // Strapi-internal param. Either way there is nothing to snapshot.
      if (!attribute) continue;
      if (SKIPPED_ATTRIBUTES.has(name)) continue;
      // Redacted fields must never even be read out of the database.
      if (isIgnored(name)) continue;

      if (!isRelational(attribute)) {
        select.add(name);
        continue;
      }

      switch (attribute.type) {
        case 'media':
          populate[name] = { select: MEDIA_FIELDS };
          break;
        case 'relation':
          populate[name] = { select: RELATION_FIELDS };
          break;
        case 'component':
          populate[name] = buildComponentPopulate(attribute.component, depth);
          break;
        case 'dynamiczone':
          populate[name] = true;
          dynamicZones.push(name);
          break;
        default:
          break;
      }
    }

    return {
      select: [...select],
      populate: Object.keys(populate).length > 0 ? populate : undefined,
      dynamicZones,
    };
  };

  const buildWhere = (uid: string, lookup: SnapshotLookup): Record<string, unknown> => {
    const where: Record<string, unknown> = { documentId: lookup.documentId };

    if (hasDraftAndPublish(uid) && lookup.status && lookup.status !== 'any') {
      where.publishedAt = lookup.status === 'draft' ? null : { $ne: null };
    }

    const locales = (lookup.locales ?? []).filter(
      (locale): locale is string => Boolean(locale) && locale !== '*'
    );
    if (isLocalized(uid) && locales.length > 0) {
      where.locale = locales.length === 1 ? locales[0] : { $in: locales };
    }

    return where;
  };

  /**
   * Second pass over dynamic zones, run only when `maxPopulateDepth >= 2`.
   *
   * The first pass told us which component types the document *actually* uses.
   * Armed with that — five widgets, not the 173 the schema allows — we can ask
   * for their nested components and media in one further query, using the morph
   * `on` map to restrict the populate to exactly those types.
   *
   * Costs one extra query per snapshot for documents that have dynamic zones,
   * and none at all for those that do not. Set `maxPopulateDepth: 1` to trade
   * that query for shallower dynamic-zone diffs.
   */
  const refineDynamicZones = async (
    uid: string,
    rows: Row[],
    query: SnapshotQuery,
    depth: number
  ): Promise<Row[]> => {
    if (query.dynamicZones.length === 0 || depth < 2 || rows.length === 0) return rows;

    const populate: Record<string, unknown> = {};

    for (const zone of query.dynamicZones) {
      const usedComponents = new Set<string>();

      for (const row of rows) {
        const items = Array.isArray(row[zone]) ? (row[zone] as Row[]) : [];
        for (const item of items) {
          const componentUid = item?.__component ?? item?.__type;
          if (typeof componentUid === 'string') usedComponents.add(componentUid);
        }
      }

      if (usedComponents.size === 0) continue;

      const on: Record<string, unknown> = {};
      for (const componentUid of usedComponents) {
        const spec = buildComponentPopulate(componentUid, depth - 1);
        on[componentUid] = spec === true ? {} : spec;
      }
      populate[zone] = { on };
    }

    if (Object.keys(populate).length === 0) return rows;

    const ids = rows.map((row) => row.id).filter((id) => id != null);
    if (ids.length === 0) return rows;

    const refined = (await strapi.db.query(uid).findMany({
      where: { id: { $in: ids } },
      select: ['id'],
      populate,
    })) as Row[];

    const byId = new Map(refined.map((row) => [row.id, row]));

    return rows.map((row) => {
      const extra = byId.get(row.id);
      if (!extra) return row;
      const merged: Row = { ...row };
      for (const zone of Object.keys(populate)) merged[zone] = extra[zone];
      return merged;
    });
  };

  /**
   * Reads the current state of a document, one row per affected locale.
   *
   * A single `findMany` rather than a query per locale: a bulk publish across
   * six locales is one round trip, not six.
   */
  const fetchRows = async (
    uid: string,
    lookup: SnapshotLookup,
    query: SnapshotQuery,
    depth: number
  ): Promise<Row[]> => {
    const rows = (await strapi.db.query(uid).findMany({
      where: buildWhere(uid, lookup),
      select: query.select,
      ...(query.populate ? { populate: query.populate } : {}),
    })) as Row[];

    return refineDynamicZones(uid, rows, query, depth);
  };

  /** Strips the identity columns, which live in dedicated audit-log fields instead. */
  const toSnapshot = (row: Row | null | undefined): Record<string, unknown> | null => {
    if (!row) return null;

    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (SKIPPED_ATTRIBUTES.has(key)) continue;
      snapshot[key] = value;
    }
    return snapshot;
  };

  return {
    buildSnapshotQuery,
    buildComponentPopulate,
    buildWhere,
    fetchRows,
    refineDynamicZones,
    toSnapshot,
    hasDraftAndPublish,
    isLocalized,
  };
};

export default snapshotService;
