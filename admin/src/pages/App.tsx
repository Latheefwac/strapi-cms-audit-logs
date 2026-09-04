import { Page } from '@strapi/strapi/admin';
import { Route, Routes } from 'react-router-dom';

import { PERMISSIONS } from '../permissions';

import { AuditLogDetails } from './AuditLogDetails';
import { AuditLogs } from './AuditLogs';

/**
 * Routes behind the `Audit Logs` sidebar entry, mounted at `/admin/audit-logs`.
 *
 * `Page.Protect` re-checks `plugin::audit-log.read` here rather than relying on
 * the hidden sidebar link. Hiding a menu item stops it being *offered*; it does
 * nothing about a bookmarked or shared URL. The server enforces the same
 * permission on every route, so this is the third of three checks and the only
 * one whose job is to show a friendly "no access" page instead of a raw 403.
 */
const App = () => (
  <Page.Protect permissions={PERMISSIONS.read}>
    <Routes>
      <Route index element={<AuditLogs />} />
      <Route path=":id" element={<AuditLogDetails />} />
      <Route path="*" element={<Page.Error />} />
    </Routes>
  </Page.Protect>
);

export { App };
