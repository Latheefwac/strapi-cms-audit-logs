/**
 * The audit-log collection type.
 *
 * Deliberately invisible to both the Content Manager and the Content-Type
 * Builder. That is not cosmetic: the Content Manager only registers
 * create/update/delete/publish RBAC actions for content types it *displays*
 * (`services/permission.ts` in `@strapi/content-manager` filters by
 * `isDisplayed`), so with `visible: false` there is no permission any admin
 * role could be granted that would let it write these rows through the normal
 * content APIs. Immutability is enforced by the absence of a permission rather
 * than by a check that could be forgotten. `services/immutability.ts` adds a
 * second, belt-and-braces guard at the Document Service layer.
 */
const schema = {
  kind: 'collectionType',
  collectionName: 'audit_logs',
  info: {
    singularName: 'audit-log',
    pluralName: 'audit-logs',
    displayName: 'Audit Log',
    description: 'Immutable record of a content operation or a security event.',
  },
  options: {
    draftAndPublish: false,
  },
  pluginOptions: {
    'content-manager': { visible: false },
    'content-type-builder': { visible: false },
  },
  attributes: {
    action: { type: 'string', required: true },

    /** UID of the audited content type, e.g. `api::page.page`. */
    contentType: { type: 'string', required: true },

    /** Display name at write time, so the log stays readable if the type is renamed or removed. */
    contentTypeDisplayName: { type: 'string' },

    /**
     * The audited document's Strapi v5 document id.
     *
     * NOT named `documentId`. Strapi reserves that attribute name on every
     * content type — `transformContentTypesToModels` throws
     * "The attribute "documentId" is reserved" at boot — because it injects its
     * own `documentId` column into every collection type. Each audit row
     * therefore still *has* a framework `documentId` (its own identity); this
     * column is the id of the document the row is *about*.
     */
    contentDocumentId: { type: 'string' },

    /** The audited entry's numeric database id, stored as a string. */
    contentId: { type: 'string' },

    locale: { type: 'string' },

    /** Actor identity, snapshotted so the record survives the user being renamed or deleted. */
    userId: { type: 'string' },
    userEmail: { type: 'string' },
    userName: { type: 'string' },

    /** Field-level diff, keyed by dotted path. */
    changes: { type: 'json' },
    before: { type: 'json' },
    after: { type: 'json' },

    /**
     * Whether the recorded attempt succeeded.
     *
     * Always `success` for a content write — the tracker runs after the
     * operation resolved, so a save that threw produces no row at all. The
     * column earns its place on the security side, where `login.failed` and
     * `access.denied` are exactly the rows a reviewer opens the log to find, and
     * where "show me every failure" has to be an indexed query rather than a
     * scan against a hard-coded list of action names.
     */
    outcome: { type: 'string' },

    /**
     * Action-specific detail: the reason a login was refused, the method and
     * path of a denied request, the filename of an upload.
     *
     * A loose JSON bag rather than a column each, because the useful fields
     * differ per action and none of them is ever filtered or sorted on. Anything
     * that needs to be queryable gets a real column instead.
     */
    metadata: { type: 'json' },

    ipAddress: { type: 'string' },
    userAgent: { type: 'text' },
    source: { type: 'string' },
    requestId: { type: 'string' },

    /**
     * Hash chain, for tamper-evidence (ASVS V7.3.3).
     *
     * `hash` is SHA-256 over this record's content fields plus `prevHash`, and
     * `prevHash` is the `hash` of the row written immediately before. Editing any
     * hashed field, or removing a row from the middle, breaks the link that the
     * next row asserts — and `services/integrity.ts` can say exactly which row.
     *
     * Both are nullable: rows written before 1.2.0 have no hash and are never
     * backfilled. Hashing them now would vouch for content whose integrity in
     * the interval cannot be known, which is the opposite of what a hash is for.
     * 64 lowercase hex characters when present.
     */
    hash: { type: 'string', maxLength: 64 },
    prevHash: { type: 'string', maxLength: 64 },
  },

  /**
   * Secondary indexes, declared here so Strapi's schema sync owns them and they
   * are created on every supported database without hand-written DDL.
   *
   * Columns are DB column names (snake_cased attribute names), and names are
   * kept short enough for PostgreSQL's 63-character identifier limit.
   *
   * `audit_logs_ct_created_idx` is composite and leading-column ordered for the
   * admin list's default query — filter by content type, sort by date — which is
   * the only query that runs on every page load.
   */
  indexes: [
    { name: 'audit_logs_created_idx', columns: ['created_at'] },
    { name: 'audit_logs_ct_created_idx', columns: ['content_type', 'created_at'] },
    { name: 'audit_logs_doc_idx', columns: ['content_document_id'] },
    { name: 'audit_logs_action_idx', columns: ['action'] },
    { name: 'audit_logs_user_idx', columns: ['user_id'] },
    { name: 'audit_logs_locale_idx', columns: ['locale'] },
    { name: 'audit_logs_outcome_idx', columns: ['outcome'] },
  ],
};

export default schema;
