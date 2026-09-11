import type { AuditAction } from '../types';

/** Badge colours per action, using design-system palette tokens. */
export const ACTION_COLORS: Record<string, { background: string; text: string }> = {
  create: { background: 'success100', text: 'success600' },
  update: { background: 'primary100', text: 'primary600' },
  delete: { background: 'danger100', text: 'danger600' },
  publish: { background: 'success100', text: 'success600' },
  unpublish: { background: 'warning100', text: 'warning600' },

  // Security actions. Green for a granted access, red for a refused one, and
  // warning amber for the changes that alter who is able to do either — a role
  // edit is not a failure, but it is the row a reviewer should stop on.
  'login.success': { background: 'success100', text: 'success600' },
  'login.failed': { background: 'danger100', text: 'danger600' },
  logout: { background: 'neutral150', text: 'neutral700' },
  'access.denied': { background: 'danger100', text: 'danger600' },

  'admin.user.create': { background: 'warning100', text: 'warning600' },
  'admin.user.update': { background: 'warning100', text: 'warning600' },
  'admin.user.delete': { background: 'danger100', text: 'danger600' },
  'admin.role.create': { background: 'warning100', text: 'warning600' },
  'admin.role.update': { background: 'warning100', text: 'warning600' },
  'admin.role.delete': { background: 'danger100', text: 'danger600' },
  'admin.permission.create': { background: 'warning100', text: 'warning600' },
  'admin.permission.update': { background: 'warning100', text: 'warning600' },
  'admin.permission.delete': { background: 'danger100', text: 'danger600' },

  'media.create': { background: 'success100', text: 'success600' },
  'media.update': { background: 'primary100', text: 'primary600' },
  'media.delete': { background: 'danger100', text: 'danger600' },
  'media-folder.create': { background: 'success100', text: 'success600' },
  'media-folder.update': { background: 'primary100', text: 'primary600' },
  'media-folder.delete': { background: 'danger100', text: 'danger600' },

  // The log's own housekeeping. Neutral: expected, scheduled, and self-reported.
  'retention.purge': { background: 'neutral150', text: 'neutral700' },
};

export const actionColor = (action: string) =>
  ACTION_COLORS[action] ?? { background: 'neutral150', text: 'neutral700' };

/** `api::page.page` -> `page`. Falls back to the raw uid for anything unexpected. */
export const shortContentTypeName = (uid: string): string => {
  const parts = uid.split('.');
  return parts.length > 1 ? (parts[parts.length - 1] as string) : uid;
};

/**
 * A short, unambiguous rendering of a value inside a diff cell.
 *
 * Long strings and structured values are truncated: the cell is a summary, and
 * the full value is one click away in the JSON viewer. `null` and `undefined`
 * are rendered as words rather than as an empty cell, because "this field was
 * cleared" and "this field was not part of the change" look identical otherwise.
 */
export const formatValue = (value: unknown, maxLength = 220): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'empty';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'string') {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value || '""';
  }

  if (typeof value === 'number') return String(value);

  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return String(value);
  }
};

/** True when a value is worth offering the collapsible JSON viewer for. */
export const isStructured = (value: unknown): boolean =>
  value !== null && typeof value === 'object';

/** `2026-09-02T13:10:00.000Z` -> `02 Sep 2026, 13:10`, in the viewer's locale. */
export const formatDate = (value: string | null | undefined, locale = 'en'): string => {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

/** Best label for the actor behind a record. */
export const formatUser = (log: {
  userName: string | null;
  userEmail: string | null;
  userId: string | null;
  source: string;
}): string => log.userName ?? log.userEmail ?? (log.userId ? `#${log.userId}` : log.source);

export const isAuditAction = (value: string): value is AuditAction =>
  ['create', 'update', 'delete', 'publish', 'unpublish'].includes(value);

/**
 * True for a record that is about security rather than content.
 *
 * Derived from the action name rather than from a list, so an action added on
 * the server needs no matching edit here. Every content action is a bare verb;
 * every security action is either namespaced with a dot or is `logout`.
 */
export const isSecurityAction = (value: string): boolean =>
  !isAuditAction(value) && (value.includes('.') || value === 'logout');
