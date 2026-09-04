# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-09-03

Adds the half of an audit trail that is not about content — authentication,
authorisation and the admin domain — plus a per-widget before/after view of
dynamic zones and optional structured-log forwarding.

### Added

**Security events**
- Logins, failed logins and logouts, from Strapi's `admin.auth.success`,
  `admin.auth.error` and `admin.logout` events. All available in **Community
  Edition**; no Enterprise licence and no patching of Strapi's own code.
- A failed login records the **attempted email**, read off the live request body
  because Strapi's event carries no identity at all. Only `email` is read; the
  password is never touched.
- Denied requests (`access.denied`) for every 401 and 403, with the method, path,
  status and the reason Strapi gave. Recorded by a Koa middleware registered from
  the plugin's `register` lifecycle, which is the only phase that lands it ahead
  of the router.
- Admin user, role and permission changes (`admin.user.*`, `admin.role.*`,
  `admin.permission.*`) and media library operations (`media.*`,
  `media-folder.*`).
- Admin-domain records keep an **allow-list** of identifying fields, so a
  `user.update` payload cannot carry a password hash, reset token or registration
  token into the audit table.
- New `securityEvents` option — `'*'`, a subset, or `[]` to register no listeners
  and add no middleware at all.
- A listener can never fail the operation that emitted it. `eventHub.emit` awaits
  its subscribers inside that operation, so every handler is wrapped and
  `failOnAuditError` is deliberately not honoured on this side.

**Per-widget before/after**
- The detail page reassembles dynamic zones and renders each changed widget
  **twice** — the whole widget as it was, then the whole widget as it now is —
  with the differing fields highlighted in both copies.
- Zones are detected structurally (an array whose members carry `__component`),
  so this covers `widgets`, `blocks` and any zone added later, on any content
  type, with nothing to register.
- Slots are paired by position rather than component id, because Strapi
  regenerates component row ids on every save; pairing by id would report every
  widget as removed-and-re-added.
- Added, removed and replaced slots are distinguished; unchanged widgets collapse
  behind a toggle.
- Computed in the browser from `before`/`after`, so it needs no new column, costs
  no extra query, and works retroactively on records already in the table.

**Centralized logging / SIEM**
- New `forwardToLogger` and `forwardLogLevel` options mirror each record to
  `strapi.log` as one line of structured JSON, for a collector to pick up off
  container stdout. Snapshots are excluded; only the changed field paths are
  emitted.

**Schema**
- `outcome` (`success` / `failure`) and `metadata` (JSON) columns, plus an
  `audit_logs_outcome_idx` index, so "show me every failure" is one indexed
  query. Both are filterable from the admin list and the API.

### Changed

- The list page's filter dropdowns now offer **everything filterable**, not only
  the values that already appear in the table. Previously a fresh install listed
  two or three content types and one user, so there was no way to ask 'has anyone
  touched Insights?' until somebody already had — which is exactly when the
  question matters. Content types come from the content-type registry (respecting
  `contentTypes`, and excluding the plugin's own type), users from `admin::user`,
  locales from i18n, and actions, sources and outcomes from their full value sets. Values found only in stored rows — a deleted content type, a
  removed administrator — are merged in, since those are what an investigation
  goes looking for and they exist nowhere else. The content type and user filters
  became searchable comboboxes, because both lists are now long.

- `auditSystemOperations` is now actually honoured. It was declared and resolved
  but never consulted. Events emitted outside any request — chiefly Strapi's
  boot-time permission reconciliation — are labelled `source: "system"` rather
  than `admin`, and `auditSystemOperations: false` drops them instead of storing
  them.
- The admin list gains an Outcome column and an Outcome filter; `outcome` is also
  a sortable column and an accepted query parameter.
- `AuditEntryInput.action` widens from `AuditAction` to `AuditAnyAction`.
  `AuditFilterOptions` gains `outcomes`, and `AuditLog` gains `outcome` and
  `metadata`. Consumers reading those types may need to widen their own.

### Fixed

- **Installing from a local path could make the plugin page unreachable.** With
  `"strapi-plugin-audit-log": "file:../strapi-plugin-audit-log"`, yarn 1 copies
  the directory wholesale — `files` is not honoured and `node_modules` is not
  skipped — so the plugin's *dev* dependencies land at
  `node_modules/strapi-plugin-audit-log/node_modules/`, including `@strapi/strapi`,
  `@strapi/admin`, `react` and `react-router-dom`. Node and Vite resolve from the
  importing file upward, so those nested copies win and the plugin's admin code
  binds to a *second* instance of the admin runtime with its own React context.

  The result is silent and very hard to attribute: `addMenuLink` still works
  (it hands a plain object to the app's router, so the sidebar entry appears),
  but `Page.Protect` calls `useAuth('Protect', s => s.permissions)` **without**
  the `shouldThrowOnMissingContext` flag, so the missing context yields
  `undefined` instead of an error, `(userPermissions || [])` makes it `[]`, and a
  Super Admin who holds the permission is shown "You don't have the permissions
  to access that content".

  Nothing in the database, the RBAC registration or the API response is wrong in
  this state, which is what makes it so misleading. See the "Installing from a
  local path" note in the README; consuming projects should strip the nested
  `node_modules` after install.

- The admin permission constants now declare the full permission entity
  (`id`, `actionParameters`, `properties`, `conditions` alongside `action` and
  `subject`), matching what `GET /admin/users/me/permissions` returns and what
  Strapi's own first-party plugins declare. Housekeeping rather than a bug fix —
  `{ action, subject: null }` already satisfied both of the admin's permission
  checks.
- Media library and admin-domain operations are no longer invisible. Both write
  through `strapi.db.query`, below the Document Service, so the tracker could
  never see them; they are covered by the event listeners instead. The
  Limitations section has been corrected accordingly.

## [1.0.0] — 2026-09-02

First release.

### Added

**Automatic tracking**
- A single Document Service middleware (`strapi.documents.use`) covering every
  content type, present and future, with no per-content-type code.
- `create`, `update`, `delete`, `publish` and `unpublish`, across the admin
  panel, the REST and GraphQL content APIs and custom server code.
- A create or update that also publishes records both actions, since Strapi's
  repository publishes internally without re-entering the middleware.
- One record per affected locale, so a bulk publish is attributable per
  translation.

**Diffs**
- Generic, schema-agnostic diff engine producing dotted paths with indexed array
  members (`seo.metaTitle`, `blocks[2].heading`).
- Handles primitives, nested objects, components, repeatable components, dynamic
  zones, relations, media, arrays and localized fields.
- `Date` and its ISO string compare equal, as do `null` and `undefined`, so a
  re-save does not report spurious changes.
- Depth budget and a 500-change cap, both with explicit markers when hit.

**Redaction**
- Case-insensitive, wildcard-capable ignore patterns matched at any depth.
- Built-in defaults covering password, token, secret, apiKey, privateKey,
  credential, accessKey, salt and otp variants.
- `additionalIgnoredFields` to extend the defaults, `ignoredFields` to replace
  them, `ignoredChangeFields` to exclude from the diff only.
- Redacted values are removed rather than masked, and stripped before the diff
  runs.

**Performance**
- Snapshot queries scoped to the attributes a write actually touched.
- Relations and media reduced to identifying fields.
- Dynamic zones populated so that only the component types present in the data
  are queried — five widgets used out of 173 declared costs five queries.
- Optional data-driven second pass for nested dynamic-zone content, gated on
  `maxPopulateDepth`.
- One `findMany` across all affected locales rather than one per locale.
- Six database indexes, declared in the schema and created by Strapi's schema
  sync on every supported database.

**Admin UI**
- `Audit Logs` sidebar entry at `/admin/audit-logs`, filtered by RBAC.
- Server-side pagination, search, sorting and filtering by action, content type,
  user, locale, source, document id and date range, all reflected in the URL.
- Detail page with full metadata, a readable before/after diff and collapsible
  JSON viewers.
- Delete, shown only to roles holding `plugin::audit-log.delete`.

**Security**
- `plugin::audit-log.read`, `.delete` and `.settings` registered with Strapi's
  admin RBAC; read and delete deliberately separate.
- Admin-only routes, each guarded by `admin::isAuthenticatedAdmin` plus an
  explicit `admin::hasPermissions`; no content-api route exists.
- Records are immutable: the collection type is hidden from the Content Manager,
  which is what withholds write permissions, plus a Document Service guard for
  server code.
- Query parameters are whitelisted and object-valued filters rejected, so a
  client cannot author query operators; `sort` accepts only known columns.
- Actor and request metadata come from the server-side request context, never
  from a request body.

**Operations**
- Retention on `strapi.cron`, off the request path; `retentionDays: 0` registers
  no job.
- `writeMode` (`sync` by default) with pending writes drained on shutdown.
- `failOnAuditError` (`false` by default) with the trade-off documented.
- `context.runAs()` for labelling migrations, cron tasks and other work with no
  request behind it.

**Types**
- Strict TypeScript throughout, with `AuditAction`, `AuditLog`, `AuditChange`,
  `AuditContext`, `AuditConfig` and others exported from
  `strapi-plugin-audit-log/strapi-server`.

### Notes

- The audited document's id is stored as `contentDocumentId`, not `documentId`:
  Strapi v5 reserves the latter as an attribute name and throws at boot if a
  schema declares one. Each audit row still carries its own framework
  `documentId`.
- Collection-valued configuration options default to `null` internally, because
  Strapi merges plugin config with lodash's `defaultsDeep`, which merges arrays
  element-wise. The real defaults are applied afterwards, so a user-supplied
  array replaces ours cleanly.
