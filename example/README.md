# Example: adding the plugin to a Strapi v5 project

Three steps, none of which touch your content types.

## 1. Install

```bash
npm install strapi-cms-audit-log
# or
yarn add strapi-cms-audit-log
```

## 2. Configure

Copy the `audit-log` block from [`plugins.ts`](./plugins.ts) into your project's
`config/plugins.ts`. The minimum that does anything useful is:

```ts
export default () => ({
  'audit-log': { enabled: true },
});
```

Everything else has a default. If your `config/plugins.ts` already exports an
object, add the key alongside your existing entries.

## 3. Start Strapi

```bash
npm run develop
```

On first boot the plugin:

- creates the `audit_logs` table and its six indexes through Strapi's schema sync;
- registers the `plugin::audit-log.read`, `.delete` and `.settings` permissions;
- adds **Audit Logs** to the admin sidebar;
- installs its Document Service middleware and, unless `retentionDays: 0`, the daily cleanup job.

You should see a line like this in the startup log:

```
[audit-log] tracking create, update, delete, publish, unpublish on all content types; writes are sync.
```

## 4. Grant the permission

New permissions are not granted to anyone automatically, including
Super Admin-adjacent custom roles. In the admin panel:

**Settings → Administration Panel → Roles → _your role_ → Plugins → Audit Logs**

Tick **Read audit logs** to reveal the sidebar entry. Tick **Delete audit logs**
separately, and only for roles that should be able to remove evidence.

Super Admins have every permission implicitly and will see the entry without any
change.

## 5. Verify

Edit any entry in the Content Manager and save it. Open **Audit Logs** — the
change should be at the top of the list, with a field-level diff on the detail
page.

## Labelling background work

Operations that run outside a request — a migration, a seed script, a cron task —
have no user attached and are recorded as `source: "system"`. To label them:

```ts
// src/index.ts, or anywhere with a `strapi` instance
const context = strapi.plugin('audit-log').service('context');

await context.runAs({ source: 'migration', userEmail: 'ops@example.com' }, async () => {
  await importEverything();
});
```

Every audited write inside the callback, including asynchronous ones, carries
that label.

## Triggering retention by hand

```bash
npm run strapi console
```

```js
await strapi.plugin('audit-log').service('retention').cleanup();
```
