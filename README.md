# strapi-plugin-audit-log

Automatic audit logging for **Strapi v5**, in two halves.

**Content**: every create, update, delete, publish and unpublish across every
content type, with field-level diffs and a per-widget before/after view of
dynamic zones.

**Security**: every login, failed login, logout and refused request, and every
change to an admin user, role, permission or media file — all from Strapi's own
events, all in **Community Edition**.

Both land in one table, behind one RBAC-protected admin page, with
sensitive-field redaction, retention and optional structured-log forwarding.

You do not add a single line of code to your content types.

---

## Contents

- [Why](#why)
- [What is recorded](#what-is-recorded)
- [Installation](#installation)
- [Configuration](#configuration)
- [Features](#features)
- [Security events](#security-events)
- [Centralized logging / SIEM](#centralized-logging--siem)
- [Installing from a local path](#installing-from-a-local-path)
- [Permissions](#permissions)
- [Plugin API](#plugin-api)
- [Architecture](#architecture)
- [Performance](#performance)
- [Error handling](#error-handling)
- [Limitations](#limitations)
- [Public types](#public-types)
- [Development](#development)
- [Upgrade guide](#upgrade-guide)
- [License](#license)

---

## Why

The usual way to audit a Strapi project is a `lifecycles.ts` per content type.
That means the same file copied into `page`, `vehicle`, `webinar`, `event` and
everything added afterwards; a content type someone forgets is a content type
with no audit trail, and nothing tells you which one it was.

It also cannot see what actually happened. To `db.lifecycles`, publishing a
document is an ordinary row insert and unpublishing is a delete — the semantics
that make an audit log worth reading are gone by the time the event fires.

This plugin registers a single **Document Service middleware**, Strapi v5's
replacement for that pattern. One registration covers every content type that
exists now, every one added later, and every route that writes content: the
admin panel, the REST and GraphQL content APIs, and your own server code.

The other half of an audit trail is not about content at all. "Who logged in",
"who failed to", "who was refused", "who gave that account Super Admin" and "who
deleted that file" are the questions a security review actually opens with, and
none of them is a document operation — Strapi writes admin users and media
through `strapi.db.query`, below the Document Service, and authentication is not
a write at all. Strapi does emit a named event for each, on the same
`strapi.eventHub` its webhooks run on, so this plugin listens there. Those
emissions are in Community Edition; nothing here needs an Enterprise licence.

---

## What is recorded

| | Action | Where it comes from |
|---|---|---|
| **Content** | `create` `update` `delete` `publish` `unpublish` | Document Service middleware |
| **Authentication** | `login.success` `login.failed` `logout` | `strapi.eventHub` |
| **Authorisation** | `access.denied` (401 and 403) | Koa middleware |
| **Admin domain** | `admin.user.*` `admin.role.*` `admin.permission.*` | `strapi.eventHub` |
| **Media library** | `media.*` `media-folder.*` | `strapi.eventHub` |

Every record carries the date and time, the actor (id, email and name,
snapshotted so the row survives the user being renamed or deleted), the IP
address, the user agent, the request id, the source, and — for content — the
before state, the after state and the field-level diff.

Mapped against the usual checklist:

| Requirement | Covered by |
|---|---|
| Successful and failed login attempts | `login.success`, `login.failed` (with the attempted email) |
| Logout events | `logout` |
| Who created / updated / deleted content | `create`, `update`, `delete` |
| Who published / unpublished content | `publish`, `unpublish` |
| Date and time of the action | `createdAt` |
| User ID / username | `userId`, `userEmail`, `userName` |
| Resource type and record ID | `contentType`, `contentDocumentId`, `contentId` |
| Before/after changes | `before`, `after`, `changes`, plus the [widget view](#per-widget-beforeafter) |
| Unauthorized access / permission failures | `access.denied` |
| Protection against modification or deletion | [Immutability](#immutability) |
| Centralized logging / SIEM | [`forwardToLogger`](#centralized-logging--siem) |

---

## Installation

```bash
npm install strapi-plugin-audit-log
```

```bash
yarn add strapi-plugin-audit-log
```

Then enable it in `config/plugins.ts`:

```ts
export default () => ({
  'audit-log': { enabled: true },
});
```

Restart Strapi. The `audit_logs` table, its indexes, the permissions and the
sidebar entry are all created on boot.

**Requirements**

| | |
|---|---|
| Strapi | `^5.0.0` (developed and tested against 5.52) |
| Node | `>=18 <=22` |
| Database | Any Strapi v5 supports — PostgreSQL, MySQL/MariaDB, SQLite |

There is one manual step after installing: **grant the permission**. See
[Permissions](#permissions).

---

## Configuration

Every option is optional. A complete, annotated example lives in
[`example/plugins.ts`](./example/plugins.ts).

```ts
export default () => ({
  'audit-log': {
    enabled: true,
    config: {
      actions: ['create', 'update', 'delete', 'publish', 'unpublish'],
      securityEvents: '*',
      contentTypes: '*',
      ignoredContentTypes: [],
      additionalIgnoredFields: [],
      storeBefore: true,
      storeAfter: true,
      storeChanges: true,
      retentionDays: 365,
      forwardToLogger: false,
    },
  },
});
```

### Reference

| Option | Type | Default | Meaning |
|---|---|---|---|
| `actions` | `AuditAction[]` | all five | Which **content** operations to record. |
| `securityEvents` | `'*' | AuditSecurityAction[]` | `'*'` | Which **security** events to record. `[]` registers no listeners and no middleware. |
| `contentTypes` | `'*' \| string[]` | `'*'` | Which content types to audit. |
| `ignoredContentTypes` | `string[]` | `[]` | Always wins over `contentTypes`. |
| `ignoredFields` | `string[]` | see below | **Replaces** the built-in redaction list. |
| `additionalIgnoredFields` | `string[]` | `[]` | **Extends** the built-in list. |
| `ignoredChangeFields` | `string[]` | `['updatedAt', 'updatedBy', 'createdBy']` | Excluded from `changes` only. |
| `storeBefore` | `boolean` | `true` | Persist the pre-operation snapshot. |
| `storeAfter` | `boolean` | `true` | Persist the post-operation snapshot. |
| `storeChanges` | `boolean` | `true` | Persist the field-level diff. |
| `maxSnapshotBytes` | `number` | `524288` | Snapshots above this are replaced with a marker. `0` disables. |
| `maxPopulateDepth` | `0–5` | `2` | How far to descend into components. See [Performance](#performance). |
| `retentionDays` | `number` | `365` | Age at which records are deleted. `0` keeps everything. |
| `retentionCron` | `string` | `'0 3 * * *'` | When the cleanup job runs. |
| `failOnAuditError` | `boolean` | `false` | Whether an audit failure fails the content operation. |
| `auditSystemOperations` | `boolean` | `true` | Record operations that happen outside a request. See [System operations](#system-operations). |
| `writeMode` | `'sync' \| 'async'` | `'sync'` | See [Is audit creation synchronous?](#is-audit-creation-synchronous). |
| `forwardToLogger` | `boolean` | `false` | Mirror each record to `strapi.log` as structured JSON. See [SIEM](#centralized-logging--siem). |
| `forwardLogLevel` | `'debug' | 'info' | 'warn' | 'error'` | `'info'` | Level the mirrored line is written at. |

Invalid values are rejected **at boot** with a message naming the option. A typo
in `actions` fails startup rather than silently auditing nothing.

### Sensitive fields

Patterns are matched **case-insensitively** against the leaf field name at any
depth, so `password` covers `user.password` and `blocks[3].auth.password`.
Wildcards are supported:

| Pattern | Matches |
|---|---|
| `password` | any field named exactly `password`, at any depth |
| `*token*` | `token`, `accessToken`, `seo.internalToken`, `refreshTokenHash` |
| `seo.metaTitle` | that exact path, anchored at the document root |
| `settings.*.apiKey` | exactly one segment between them |
| `blocks.**.secret` | zero or more segments between them |

The built-in list is:

```
*password*  *passwd*  *token*  *secret*  *apikey*  *api_key*
*privatekey*  *private_key*  *credential*  *accesskey*  salt  otp  *totp*
```

These are substring patterns rather than an exhaustive list of exact names
because the exact names are unknowable: `internalToken` and `stripeSecretKey`
are what turn up in real projects, and an exact-match list stores both. The
trade is deliberate — `*token*` also redacts a field named `tokenCount`, which
costs one uninteresting value; missing a credential writes it, in clear, into a
table designed to be kept for a year.

Redacted fields are **removed**, not masked. A placeholder still tells a reader
that a secret exists and changed. They are stripped before the diff runs, so they
cannot appear in `before`, `after` or `changes`.

> **Note on `ignoredFields`** — setting it replaces the built-in list entirely.
> Strapi merges plugin config with lodash's `defaultsDeep`, which merges arrays
> element-wise, so a literal array default would splice your `['x']` into
> `['x', ...ourDefaults.slice(1)]`. Every collection-valued option therefore
> defaults to `null` internally and the real defaults are applied afterwards.
> Use `additionalIgnoredFields` to extend rather than replace.

---

## Features

### Automatic tracking

| Action | Recorded when |
|---|---|
| `create` | a document is created |
| `update` | a document is updated |
| `delete` | a document is deleted |
| `publish` | a document is published |
| `unpublish` | a document is unpublished |

Security events are listed under [Security events](#security-events).

A create or update that also publishes (`status: 'published'`) produces **two**
records — the write and the publish. Strapi's repository publishes internally by
calling its own `publish()` rather than the middleware-wrapped facade, so no
`publish` action reaches any middleware; recording it explicitly keeps "when was
this published" answerable regardless of which route created the document.

A bulk publish across six locales produces six records, one per locale, because
six documents changed.

### Diffs

Nested structures are flattened into dotted paths, with array members addressed
by index:

```json
{
  "changes": {
    "title": { "from": "Old Homepage", "to": "New Homepage" },
    "seo.metaTitle": { "from": "Old title", "to": "New title" },
    "blocks[2].heading": { "from": "Features", "to": "What you get" },
    "cover.url": { "from": "/uploads/old.png", "to": "/uploads/new.png" }
  }
}
```

The engine is entirely generic — it knows nothing about content types — and
handles primitives, nested objects, components, repeatable components, dynamic
zones, relations, media, arrays and localized fields alike.

Two details worth knowing:

- A `Date` from the database and its ISO string from a request body compare
  **equal**, so a re-save does not report every datetime as changed.
- `null` and `undefined` compare equal, so an absent key is not a change.

### Per-widget before/after

Flat paths answer "which fields moved". They do not answer the question an editor
actually arrives with, which is *what did that widget look like before, and what
does it look like now* — reading `widgets[3].heading` out of a list means
reconstructing a component from an array index in your head.

So the detail page also reassembles dynamic zones. Every zone in the snapshots is
found **structurally** — an array whose members carry `__component`, which is how
Strapi marks one in a populated result — so this works on `widgets`, on `blocks`,
and on any zone added to any content type later, with nothing to register.

Each changed slot is rendered **twice**: the whole widget as it was, then the
whole widget as it now is, with the fields that differ highlighted in both
copies.

```
Widgets — 1 changed of 5

+-- #3 . Hero . home.hero --------------- CHANGED --+
| * BEFORE                                          |
|     heading      Welcome to YCS                    |
|     subheading   Cloud for hotels                  |
|     cta.label    Book a demo                       |
+----------------------------------------------------+
| * AFTER                                            |
|     heading      Run your hotel better        <--   |
|     subheading   Cloud for hotels                  |
|     cta.label    Get started                  <--   |
+----------------------------------------------------+
```

Slots are paired by **position**, not by component id. Strapi does not preserve
component row ids across an update — the Content Manager sends the whole zone
back and the repository replaces its rows — so pairing by id would report every
widget as removed-and-re-added on every save. Position is also what an editor
sees and reasons about ("the third block"), and it makes a reorder show up as the
change it is.

A slot that gained a widget shows only the *after* card, one that lost a widget
only the *before* card, and a slot whose widget was swapped for a different
component says so outright. Unchanged widgets are collapsed behind a toggle, so a
two-field edit on a 170-widget page opens showing exactly the widget that
changed.

Computed in the browser from `before` and `after`, which are already on the
record — so it needs no new column, costs no extra query, and works
retroactively on every row already in your table.

### Localization

Each record carries the locale it applies to. An update to the `fr` translation
records `locale: "fr"` and diffs against the `fr` draft, never against `en`.

### Draft & publish

`before` for a publish is the version being replaced; `after` is the new
published version. An unpublish records the state that went away. Updates always
work against the draft.

### Admin UI

**Audit Logs** in the sidebar opens `/admin/audit-logs`:

- server-side pagination, search, sorting and filtering — the browser never
  receives more than one page;
- filters for action, content type, user, locale, source, outcome, exact
  document id and a date range, all reflected in the URL so a filtered view is
  shareable. Each dropdown offers **everything filterable**, not just the values
  already in the table — content types from the registry, users from
  `admin::user`, locales from i18n — because a filter is most useful when the
  answer is "nothing yet". Values that exist only in stored rows, such as a
  deleted content type or a removed administrator, are merged in too. Content
  type and user are searchable, since both lists are long;
- a detail page with full metadata, a readable before/after diff, and
  collapsible JSON viewers for the raw snapshots;
- delete, shown only to roles that hold `plugin::audit-log.delete`.

### Retention

A daily cron job (03:00 server time by default) deletes records past
`retentionDays`. It runs off the request path entirely — see
[Performance](#performance). `retentionDays: 0` registers no job at all.

Run it by hand from `strapi console`:

```js
await strapi.plugin('audit-log').service('retention').cleanup();
```

---

## Security events

The half of the trail that is not about content. Every event below is emitted by
**Strapi Community Edition** itself — this plugin subscribes to them, it does not
patch Strapi and it does not need an Enterprise licence.

| Action | Recorded when | Strapi event |
|---|---|---|
| `login.success` | an administrator signs in | `admin.auth.success` |
| `login.failed` | a sign-in is refused | `admin.auth.error` |
| `logout` | an administrator signs out | `admin.logout` |
| `access.denied` | a request is answered 401 or 403 | Koa middleware |
| `admin.user.*` | an admin user is created, changed or removed | `user.*` |
| `admin.role.*` | a role is created, changed or removed | `role.*` |
| `admin.permission.*` | a permission is created, changed or removed | `permission.*` |
| `media.*` | a file is uploaded, replaced or deleted | `media.*` |
| `media-folder.*` | a media folder changes | `media-folder.*` |

Select a subset with `securityEvents: ['login.failed', 'access.denied']`, or turn
the whole half off with `securityEvents: []` — which registers no listeners and
adds no middleware at all.

Security rows carry two columns content rows barely use: `outcome`
(`success` / `failure`, indexed, so "show me every failure" is one query) and
`metadata`, a small JSON bag of the detail specific to each action.

### Failed logins name the account

`admin.auth.error` carries only `{ error, provider }`. Strapi puts no identity on
it, which on its own makes "which account is being brute-forced" unanswerable, so
the plugin reads the attempted email off the live request body — the event is
emitted synchronously inside that request. **Only `email` is read**; the body's
other field is the password, and it is never touched.

```json
{
  "action": "login.failed",
  "outcome": "failure",
  "userEmail": "victim@example.com",
  "ipAddress": "203.0.113.7",
  "metadata": {
    "attemptedEmail": "victim@example.com",
    "reason": "Invalid credentials",
    "provider": "local"
  }
}
```

### Denied requests

A 401 is "you are not authenticated"; a 403 is "you are, and you still may not".
Both are recorded, with the method, the path, the status and the reason Strapi
gave. The login and token-refresh routes are excluded: a wrong password is a 401
that `login.failed` has already recorded *with the account name*, and recording
the status too would double every attempt.

404s are not recorded. Strapi answers an unauthorised content-API read with a 404
rather than a 403 so as not to confirm that a document exists, and logging every
404 to catch those would bury the trail in typos and favicon requests.

The middleware is registered from the plugin's `register` lifecycle, not
`bootstrap`. `strapi.server.use()` appends to the Koa stack, and Strapi applies
`config/middlewares.ts` and mounts the router *inside* `bootstrap()`, before the
bootstrap lifecycles run — so registering there would put this middleware behind
the router, where it would see nothing and fail silently.

### Admin-domain records never carry credentials

A `user.update` payload is the entire admin user row — password hash, reset
token, registration token and all. Only an **allow-list** of identifying fields is
kept (id, email, name, active flag, and the role *names*, which are the part of an
admin-user change anyone reviews). Everything else is dropped before the record is
built, rather than redacted afterwards.

### System operations

Not every event comes from a person. Strapi reconciles its permission table
**during boot**, which emits `permission.create` and `permission.delete` with no
actor and no request in flight. Those records are labelled `source: "system"`
rather than `admin`, because calling them `admin` would put rows in the log that
read as though an administrator had edited permissions — the exact row a security
review is meant to stop on.

Set `auditSystemOperations: false` to drop them entirely. Worth doing on a
project that restarts often: a handful of `admin.permission.*` rows per restart
buries the one time somebody really did change a permission. Request-borne events
are unaffected.

### A listener can never break the operation

`eventHub.emit` awaits its subscribers *inside* the operation that emitted them.
A listener that threw on `admin.auth.success` would turn a correct password into a
failed login; one that threw on `media.create` would fail the upload. Every
handler is wrapped, and `failOnAuditError` is deliberately **not** honoured on this
side — that option exists so a project can refuse to serve content it cannot
audit, which is a very different proposition from locking every administrator out
of the panel because the audit table is unreachable.

---

## Centralized logging / SIEM

```ts
'audit-log': { config: { forwardToLogger: true, forwardLogLevel: 'info' } }
```

Every record is then also written to `strapi.log` as one line of structured JSON:

```json
{"type":"audit-log","action":"login.failed","outcome":"failure","contentType":"admin::auth","userEmail":"victim@example.com","source":"admin","ipAddress":"203.0.113.7","changedPaths":[],"at":"2026-09-03T14:22:16.666Z"}
```

That is the whole integration, and deliberately so. Every deployment target — ECS,
Kubernetes, Heroku, a bare systemd unit — already ships process stdout somewhere,
and every log pipeline worth the name already parses JSON off it. A line costs
nothing, needs no credentials, cannot block a request, and cannot fail in a way
that loses the database row. An in-process HTTP forwarder holding a retry queue
can do all four.

The **snapshots are not included**. They are unbounded — a page with a large
dynamic zone runs to megabytes — and a log pipeline is the wrong place to store
them. Only the changed field *paths* are emitted, which is what an alert rule
needs; the row in `audit_logs` remains the record of truth.

Worth alerting on: repeated `login.failed` from one `ipAddress`, any
`admin.role.update`, any `admin.user.create`, a burst of `access.denied` from one
`userId`, or a `delete` outside working hours.

---

## Installing from a local path

Developing the plugin alongside a Strapi app usually means a path dependency:

```json
{ "dependencies": { "strapi-plugin-audit-log": "file:../strapi-plugin-audit-log" } }
```

That works, with **one thing you must clean up afterwards**.

Yarn 1's `file:` protocol copies the directory wholesale. It does not honour the
`files` field and it does not skip `node_modules`, so the plugin's *development*
dependencies are installed into your app at
`node_modules/strapi-plugin-audit-log/node_modules/` — `@strapi/strapi`,
`@strapi/admin`, `react`, `react-dom`, `react-router-dom`, `react-intl` and
`styled-components` among them.

Every one of those is a **peer** dependency that has to resolve to your app's
copy. Node and Vite resolve from the importing file upward, so a nested copy
wins, and the plugin's admin code ends up bound to a second instance of the admin
runtime with its own React context. Your app populates the context on *its*
instance; the plugin reads the *other* one and finds nothing there.

The failure is silent and points nowhere near the cause:

- the **sidebar entry appears** — `addMenuLink` hands a plain object to the app's
  own router, so that check runs in the app's context and passes;
- **clicking it** renders *"You don't have the permissions to access that
  content"* — `Page.Protect` calls `useAuth('Protect', s => s.permissions)`
  without Strapi's `shouldThrowOnMissingContext` flag, so a missing context
  returns `undefined` rather than throwing, `(userPermissions || [])` turns that
  into `[]`, and the guard concludes the user has nothing.

A Super Admin sees this while the database, the RBAC registration and the
`/admin/users/me/permissions` response are all completely correct — there is
nothing wrong to find in any of them.

**The fix** is to delete the nested tree, which is what a published install from
npm would have given you anyway:

```bash
rm -rf node_modules/strapi-plugin-audit-log/node_modules
```

Make it survive the next install with a `postinstall` script:

```json
{ "scripts": { "postinstall": "rm -rf node_modules/strapi-plugin-audit-log/node_modules" } }
```

Then clear Vite's dependency cache (`rm -rf node_modules/.strapi/vite`), restart
Strapi, and hard-reload the browser.

Two more things about a path install, unrelated to the above:

- Yarn **copies** rather than links, so changes to the plugin need
  `npm run build` in the plugin followed by re-copying `dist/` into
  `node_modules/strapi-plugin-audit-log/dist`. A bare `yarn install` will not
  refresh it — the resolution is unchanged, so yarn skips the copy.
- Strapi loads plugins at boot, so a restart is always required.

---

## Permissions

Three RBAC actions are registered in the **Plugins** section of the role editor:

| Permission | Grants |
|---|---|
| `plugin::audit-log.read` | See the sidebar entry, list and read records |
| `plugin::audit-log.delete` | Delete a record |
| `plugin::audit-log.settings` | Reserved for a future settings page |

Read and delete are separate on purpose: being allowed to investigate an incident
must not imply being allowed to erase the evidence.

**Grant them at Settings → Administration Panel → Roles → _role_ → Plugins →
Audit Logs.** New permissions are not granted automatically; Super Admins have
them implicitly.

Three independent checks enforce `read`:

1. the sidebar link is filtered out of the menu;
2. `Page.Protect` renders a "no access" page for a bookmarked URL;
3. every server route runs `admin::isAuthenticatedAdmin` then
   `admin::hasPermissions`.

Only the third is a security boundary. The first two exist so the panel behaves
sensibly rather than showing a raw 403.

### Immutability

Audit records cannot be edited. This is enforced structurally rather than by a
check that could be forgotten: the collection type is declared
`'content-manager': { visible: false }`, and `@strapi/content-manager` only
registers create/update/delete/publish RBAC actions for content types it
*displays*. There is no permission an administrator could grant that would let a
role write these rows through the content APIs.

A Document Service guard adds a second line for server code — a stray
`strapi.documents('plugin::audit-log.audit-log').update(...)` in a bootstrap
throws rather than succeeding quietly. Deletion is deliberately *not* blocked
there: it is legitimate (retention needs it) and is gated where it belongs, on
the one route that performs it.

There is no create or update route. The plugin's HTTP surface is read plus a
single guarded delete.

---

## Plugin API

All routes are `type: 'admin'`, mounted under the plugin id, and require an
authenticated admin session plus an explicit permission. **None of them is
reachable from the public content API**, with or without an API token, because
no content-api route file exists.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/audit-log/logs` | `read` |
| `GET` | `/audit-log/logs/:id` | `read` |
| `GET` | `/audit-log/filters` | `read` |
| `GET` | `/audit-log/config` | `read` |
| `DELETE` | `/audit-log/logs/:id` | `delete` |

### `GET /audit-log/logs`

| Parameter | Notes |
|---|---|
| `page`, `pageSize` | `pageSize` is capped at 100 |
| `sort` | `field:asc\|desc`; only whitelisted columns, anything else falls back to `createdAt:desc` |
| `action`, `contentType`, `userId`, `locale`, `source`, `outcome` | string or array (array becomes `$in`) |
| `contentDocumentId` | exact match |
| `dateFrom`, `dateTo` | ISO dates, applied independently |
| `_q` | case-insensitive search across the identifying columns |

Unrecognised query keys are discarded. Object-valued parameters — what
`?action[$ne]=create` parses to — are rejected rather than forwarded, so a client
cannot author its own query operators.

```json
{
  "results": [ /* AuditLog[] */ ],
  "pagination": { "page": 1, "pageSize": 20, "pageCount": 12, "total": 231 }
}
```

### Server-side services

```ts
const plugin = strapi.plugin('audit-log');

plugin.service('audit').find(query);
plugin.service('audit').deleteOlderThan(new Date('2026-01-01'));
plugin.service('retention').cleanup();
plugin.service('config').getPublicConfig();

// Label writes that happen outside a request.
plugin.service('context').runAs({ source: 'migration' }, () => importEverything());
```

---

## Architecture

### Data model

`plugin::audit-log.audit-log`, stored in `audit_logs`:

| Column | Notes |
|---|---|
| `id` | |
| `documentId` | the audit record's own Strapi v5 document id |
| `action` | `create` \| `update` \| `delete` \| `publish` \| `unpublish` |
| `contentType` | uid of the audited type, e.g. `api::page.page` |
| `contentTypeDisplayName` | snapshotted, so the log survives a rename |
| `contentDocumentId` | **the audited document's** v5 document id |
| `contentId` | the audited entry's numeric database id |
| `locale` | |
| `userId`, `userEmail`, `userName` | snapshotted, so the record survives the user being renamed or deleted |
| `changes`, `before`, `after` | JSON |
| `outcome` | `success` or `failure`. Always `success` for content — the tracker runs after the write succeeded. |
| `metadata` | JSON. Action-specific detail: why a login was refused, the method and path of a denied request. |
| `ipAddress`, `userAgent`, `requestId` | |
| `source` | `admin` \| `api` \| `system` \| `cron` \| `migration` \| `unknown` |
| `createdAt`, `updatedAt` | |

> **Why `contentDocumentId` and not `documentId`** — Strapi v5 reserves
> `documentId` as an attribute name and throws at boot if a schema declares one
> (`transformContentTypesToModels` raises *"The attribute 'documentId' is
> reserved"*), because it injects its own `documentId` column into every
> collection type. Each audit row therefore has both: `documentId` is the audit
> record's identity, `contentDocumentId` is the id of the document it is about.

The schema declares six indexes, created by Strapi's own schema sync on every
supported database with no hand-written DDL:

```
audit_logs_created_idx      (created_at)
audit_logs_ct_created_idx   (content_type, created_at)   -- the admin list's default query
audit_logs_doc_idx          (content_document_id)
audit_logs_action_idx       (action)
audit_logs_user_idx         (user_id)
audit_logs_locale_idx       (locale)
audit_logs_outcome_idx      (outcome)
```

### Interception

```
strapi.documents('api::page.page').update(...)
        │
        ├─ immutability guard        ← rejects writes to the audit table itself
        │
        ├─ audit tracker
        │    ├─ before next(): one narrow query for the pre-state
        │    │
        │    ├─ next() ──────────────► repository  ← the transaction lives HERE
        │    │                          (wrapInTransaction)
        │    │
        │    └─ after next(): one narrow query for the post-state,
        │                      diff, redact, INSERT
        │
        └─ result returned unchanged
```

Three properties make the Document Service the right layer:

1. **It sees the semantic action.** `publish` and `unpublish` are indistinguishable
   from ordinary inserts and deletes at the database layer.
2. **It runs outside the transaction.** Strapi's middleware manager wraps the
   already-transaction-wrapped repository methods, so an audit failure cannot
   roll back an editor's save and an audit insert never holds a row lock open.
3. **It sees `documentId` and `locale` as parameters** rather than having to
   reconstruct them from a row.

### Context

Actor and request metadata come from `strapi.requestContext` — the Koa context
Strapi keeps in AsyncLocalStorage — and never from a request body. `source` is
derived from the route type and auth strategy, honouring `state.auditSource` when
present so this log agrees with Strapi's own EE audit log about where an
operation came from. `ipAddress` is `ctx.request.ip`, which respects Koa's
`proxy` setting: behind a correctly configured load balancer it is the client
address, and with `proxy` off it ignores `X-Forwarded-For` entirely rather than
trusting a spoofable header.

### Why admin and server types are separate

The canonical types live in `server/src/types` and are re-exported from
`strapi-plugin-audit-log/strapi-server`. The admin panel keeps its own copies of
the few shared unions in `admin/src/types.ts`.

That is a build constraint, not an oversight. `@strapi/sdk-plugin` compiles the
two halves in separate Vite passes whose declaration emit is rooted at
`admin/src` and `server/src` respectively, so a module imported across that
boundary is emitted outside its own root. The admin types are also genuinely
different — they describe JSON on the wire, where dates are strings.

---

## Performance

### The dynamic-zone problem

The motivating case: a `page` content type whose dynamic zone declares **173**
possible widgets, of which a given page uses **five**. Strapi's own
`getDeepPopulate` walks the *schema* and requests every relation, component and
media field the type could ever hold — hundreds of joins to audit a two-field
edit.

This plugin never does that. Instead:

**1. The key set comes from the write, not the schema.** An update's snapshot
covers exactly the attributes present in `params.data`. Editing `title` reads
`title` — no populate at all.

**2. Relations and media are reduced to identifying fields.** A relation
populates `id` and `documentId`; media adds name, url, mime and size. The audit
trail records *which* author was linked, not a copy of the author record.

**3. Dynamic zones are populated with `true`.** This makes Strapi read the join
table first and then issue one query per component type **actually present in the
rows**. Five widgets used out of 173 declared means five queries; the 168 unused
schemas are never touched. This is verified by a test that asserts the populate
spec never names more than the five widgets in use.

**4. Nested components are resolved from their own schemas.** Component
definitions are small and static, so descending them costs no extra round trips —
it only makes the query Strapi already issues return more columns.

**5. Dynamic-zone refinement is data-driven.** With `maxPopulateDepth >= 2` (the
default), a second query resolves the nested components and media *inside* the
widgets — using an `on` map built from the widget types the first pass found. One
extra query for documents that have dynamic zones, none for those that do not.
Set `maxPopulateDepth: 1` to skip it.

### Query budget

Per audited write:

| Operation | Queries |
|---|---|
| `create` | 1 (after) + 1 INSERT |
| `update` | 1 (before) + 1 (after) + 1 INSERT |
| `delete`, `unpublish` | 1 (before) + 1 INSERT |
| `publish` | 1 (before) + 1 (after) + 1 INSERT |
| *(+1 per snapshot with dynamic zones, when `maxPopulateDepth >= 2`)* | |

All snapshot queries are `findMany` across every affected locale at once, so a
publish over six locales is one round trip rather than six. There are no N+1
loops: nothing is fetched per row.

`before` **must** be read before the write. `after` is re-read with the *same*
query shape rather than reusing the operation's own result — the Content Manager
hands back a deeply populated document while our `before` is deliberately
shallow, and diffing one against the other would report every un-populated nested
field as a deletion. One narrow query buys a diff that is actually correct.

To reduce the budget further: `storeBefore: false` drops the before query,
`storeAfter: false` and `storeChanges: false` together drop the after query.

### Is audit creation synchronous?

**Yes, by default, and deliberately.**

The audit row is written *after* the content operation resolves, so it never
extends the operation's transaction. What `writeMode: 'sync'` adds is that the
single-row INSERT is awaited before the HTTP response is produced.

That costs sub-millisecond time on every supported database and buys the
guarantee an audit trail exists for: **once the editor sees "saved", the record
is durably on disk.** A crash, a redeploy or a scaled-down container cannot lose
it. An audit log that silently drops records is worse than no audit log, because
you cannot tell which records are missing.

`writeMode: 'async'` trades that guarantee for the millisecond. Writes are
tracked and drained on `destroy()`, so an orderly shutdown loses nothing — but a
hard kill between the response and the flush will. Choose it only if that is
acceptable for your compliance story.

### Retention

Cleanup runs on `strapi.cron`, off the request path entirely. Doing it inline —
the obvious shortcut — would put an unbounded `DELETE` over the largest table in
the project directly in front of an editor pressing Save, once per write.

### Admin listing

Filtering, sorting and pagination all happen in SQL, `pageSize` is capped at 100,
and the filter dropdowns come from three indexed `DISTINCT` queries rather than
from the rows on screen. The browser never holds more than one page.

---

## Error handling

With the default `failOnAuditError: false`, an audit failure is logged and the
content operation succeeds:

```
[audit-log] audit write failed for update on api::page.page: connection terminated
```

Both the pre-write snapshot and the post-write bookkeeping are individually
guarded, and `next()` is always reached.

**The trade-off.** `false` means editors are never blocked by an unreachable
audit table — but it also means a period of unavailability produces content
changes with no record, and nothing in the audit log itself says so. Your only
signal is the application log.

`failOnAuditError: true` inverts this: an audit failure fails the content
operation, so the log can never have a silent gap. Content editing stops when
audit storage is unavailable. If you are auditing for compliance rather than for
convenience, that is usually the correct setting; monitor the error log either
way.

---

## Limitations

Things this plugin genuinely cannot see. Each is a consequence of the
interception point, not an omission.

**Content writes that bypass the Document Service.** Anything calling
`strapi.db.query(uid).update(...)` or `strapi.db.connection` directly is invisible
to the *content* tracker — the middleware is registered on `strapi.documents`. The
Content Manager, the REST and GraphQL content APIs, and `strapi.documents(...)` in
your own code are all covered. Raw SQL and direct database access are not.

**API tokens and webhooks.** These are `admin::` entities that Strapi emits no
event for, so there is nothing to subscribe to. Admin users, roles, permissions
and media files *are* covered — see [Security events](#security-events).

**Failed operations.** Only completed writes produce a record: the tracker runs
after the Document Service resolves, so a save rejected by validation leaves no
row. Refused *requests* are covered separately by `access.denied`.

**Field-level diffs for admin-domain changes.** Strapi's `user.*` and `role.*`
events carry one side of the change only, so those records show the resulting
state rather than a before/after diff. Inventing a diff from a single payload
would mean guessing. Content records have real diffs.

**Content-Type Builder changes.** Schema edits are file writes, not document
operations.

**Nesting past `maxPopulateDepth`.** Components inside dynamic-zone widgets are
resolved one level by default. Deeper structures appear as ids rather than full
values. Raise `maxPopulateDepth` (max 5) at the cost of query depth.

**Reorders read as content changes.** Arrays are diffed by index, so moving a
dynamic-zone widget reports a change to every element that moved. This is
honest — stored order *is* content — but it is noisier than a move-aware diff.

**Oversized snapshots are dropped.** Above `maxSnapshotBytes` the snapshot is
replaced with a marker. The record, the action and the metadata still exist; only
the payload is gone.

**Diffs are capped at 500 changes**, after which a `__truncated__` marker is
added. The full state remains in `before`/`after`.

---

## Public types

```ts
import type {
  AuditAction,
  AuditActor,
  AuditChange,
  AuditChangeSet,
  AuditConfig,
  AuditContext,
  AuditEntryInput,
  AuditLog,
  AuditLogListResult,
  AuditLogQuery,
  AuditRequestContext,
  AuditSource,
  AuditUserConfig,
  AuditWriteMode,
  ContentTypeSelector,
} from 'strapi-plugin-audit-log/strapi-server';
```

`PLUGIN_ID`, `AUDIT_LOG_UID`, `PERMISSIONS` and `DEFAULT_IGNORED_FIELDS` are
exported as values from the same entry point.

---

## Development

```bash
npm install
npm run build       # vite build via @strapi/sdk-plugin
npm run typecheck   # tsc over server/ and admin/ separately
npm run test        # jest
npm run lint        # eslint
npm run verify      # validate the package for publishing
```

### Testing approach

The suite runs the real services against an in-memory Strapi harness
(`tests/helpers/strapi.ts`) that implements the boundary Strapi owns — the model
registry, `db.query` with working `select`/`populate` narrowing, the Document
Service middleware chain, the request context, cron. That means the tests
exercise the whole path from middleware through snapshot, diff, redaction and
write, rather than asserting against mocks, and they need no database.

Every query is recorded, which is what lets the performance tests assert that a
two-field edit on a 173-widget page does not populate 173 widgets.

### Working against a local Strapi project

```bash
# in the plugin
npm run watch:link

# in your Strapi project
npx yalc add --link strapi-plugin-audit-log && npm install
npm run develop
```

### Publishing

```bash
npm run lint && npm run typecheck && npm run test
npm run build
npm run verify
npm publish
```

`prepublishOnly` runs the build, and `files: ["dist"]` keeps sources, tests and
config out of the published tarball.

---

## Upgrade guide

The plugin follows semantic versioning.

**Patch and minor releases** need no action beyond `npm update`. New
configuration options always ship with a default matching the previous
behaviour. New columns are added to the schema and created by Strapi's schema
sync on the next boot; existing rows keep `null` for them.

**Major releases** will document any breaking change and its migration in
[`CHANGELOG.md`](./CHANGELOG.md). Existing audit records are never rewritten by
an upgrade — they are historical evidence, and a migration that edited them would
defeat the point. A change to how records are *produced* affects new records
only, so a table can legitimately contain records written by several versions.

Before a major upgrade:

1. Read the changelog entry.
2. Back up the `audit_logs` table if you rely on it for compliance.
3. Re-check your `ignoredFields` after any change to the built-in redaction list
   — if you override it, you do not inherit new defaults.

---

## License

MIT © Latheefwac
