/**
 * Example `config/plugins.ts` for a consuming Strapi v5 project.
 *
 * Copy the `audit-log` block into your own `config/plugins.ts`, alongside
 * whatever else you already configure there. Every key shown has a default —
 * `{ enabled: true }` on its own is a complete, working configuration.
 */

export default () => ({
  'audit-log': {
    enabled: true,
    config: {
      // ----------------------------------------------------------------
      // What to record
      // ----------------------------------------------------------------

      /**
       * Content operations to audit. Omit one to stop recording it entirely.
       *
       * This option covers content only. Logins, denied requests and admin
       * user/role changes are selected by `securityEvents` below — they come
       * from different machinery and are switched on and off independently.
       */
      actions: ['create', 'update', 'delete', 'publish', 'unpublish'],

      /**
       * Content types to audit.
       *
       * `'*'` covers everything, including plugin content types such as
       * `plugin::upload.file`. Pass an array to opt in explicitly:
       *
       *   contentTypes: ['api::page.page', 'api::webinar.webinar'],
       */
      contentTypes: '*',

      /** Always wins over `contentTypes`. Useful for chatty machine-written types. */
      ignoredContentTypes: [
        // 'api::internal-log.internal-log',
      ],

      /**
       * Security events to record, from Strapi's own `eventHub` and from the
       * denied-request middleware. All are available in Community Edition.
       *
       *   login.success  login.failed  logout  access.denied
       *   admin.user.create    admin.user.update    admin.user.delete
       *   admin.role.create    admin.role.update    admin.role.delete
       *   admin.permission.create  .update  .delete
       *   media.create  media.update  media.delete
       *   media-folder.create  media-folder.update  media-folder.delete
       *
       * `'*'` (the default) records all of them. `[]` registers no listeners
       * and adds no middleware at all.
       */
      securityEvents: '*',

      // ----------------------------------------------------------------
      // Redaction
      // ----------------------------------------------------------------

      /**
       * Fields never written to `before`, `after` or `changes`.
       *
       * Setting this REPLACES the built-in list. Patterns are matched
       * case-insensitively against the leaf name at any depth, and `*` is a
       * wildcard: `*token*` covers `token`, `accessToken` and
       * `seo.internalToken` alike. A pattern containing a dot is anchored at the
       * document root instead: `seo.internalNote`.
       *
       * Leave it out to keep the defaults, which already cover password, token,
       * secret, apiKey, privateKey, credential, salt and otp variants.
       */
      // ignoredFields: ['*password*', '*token*', '*secret*'],

      /** Added to the built-in list rather than replacing it. Usually what you want. */
      additionalIgnoredFields: [
        // 'seo.internalNote',
        // 'settings.*.webhookUrl',
      ],

      /**
       * Excluded from `changes` but still present in `before`/`after`.
       * These change on every write and would otherwise bury the real edit.
       */
      ignoredChangeFields: ['updatedAt', 'updatedBy', 'createdBy'],

      // ----------------------------------------------------------------
      // What to store
      // ----------------------------------------------------------------

      storeBefore: true,
      storeAfter: true,
      storeChanges: true,

      /**
       * Per-snapshot ceiling in bytes. A snapshot above it is replaced with a
       * marker; the record itself is still written. `0` disables the cap.
       */
      maxSnapshotBytes: 512 * 1024,

      /**
       * How far to descend into components when snapshotting.
       *
       * `2` (the default) resolves nested components and, for dynamic zones,
       * runs one extra query restricted to the widget types the document
       * actually uses. `1` skips that second query for shallower diffs.
       */
      maxPopulateDepth: 2,

      // ----------------------------------------------------------------
      // Retention
      // ----------------------------------------------------------------

      /** Records older than this are deleted by a daily job. `0` keeps everything. */
      retentionDays: 365,

      /** When the cleanup job runs. Standard cron, server time. */
      retentionCron: '0 3 * * *',

      // ----------------------------------------------------------------
      // Behaviour under failure
      // ----------------------------------------------------------------

      /**
       * Record operations that happen outside any request.
       *
       * Chiefly Strapi's own boot-time permission reconciliation, which emits
       * `permission.create`/`permission.delete` with no actor. They are labelled
       * `source: 'system'` either way; `false` drops them instead of storing
       * them, which is worth doing on a project that restarts often.
       */
      auditSystemOperations: true,

      /**
       * `false` (default): an audit failure is logged and the content operation
       * succeeds. `true`: the content operation fails too. See the README's
       * "Error handling" section before turning this on.
       */
      failOnAuditError: false,

      /**
       * `'sync'` (default) awaits the audit insert before the response, so a
       * saved document always has a record. `'async'` returns marginally sooner
       * and drains on shutdown, but a hard kill loses in-flight records.
       */
      writeMode: 'sync',

      // ----------------------------------------------------------------
      // Centralized logging / SIEM
      // ----------------------------------------------------------------

      /**
       * Mirror every record to `strapi.log` as one line of structured JSON.
       *
       * The database row stays the record of truth; the log line is what a
       * collector (CloudWatch, Datadog, Loki, an ELK pipeline) picks up off
       * container stdout, with no credentials to manage and nothing that can
       * block a request. Snapshots are deliberately excluded — only the changed
       * field *paths* are emitted, which is what an alert rule needs.
       */
      forwardToLogger: false,

      /** Level the mirrored line is written at: debug | info | warn | error. */
      forwardLogLevel: 'info',
    },
  },
});
