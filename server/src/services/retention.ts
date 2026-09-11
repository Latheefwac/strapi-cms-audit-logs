import type { Core } from '@strapi/strapi';

import { RETENTION_JOB_NAME, SUBJECTS, SUBJECT_DISPLAY_NAMES } from '../constants';
import type { ResolvedConfig } from './config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Scheduled deletion of expired audit records.
 *
 * Runs on `strapi.cron`, off the request path entirely. Cleaning up inside a
 * content operation — the obvious shortcut — would put an unbounded `DELETE`
 * over the largest table in the project directly in front of an editor pressing
 * Save, and would do it once per write. Here it runs once a day, by default at
 * 03:00 server time, and a slow pass delays nothing but itself.
 *
 * `retentionDays: 0` disables the job entirely: no cron entry is registered, so
 * projects that keep audit history forever pay nothing for the feature.
 */
const retentionService = ({ strapi }: { strapi: Core.Strapi }) => {
  const getConfig = (): ResolvedConfig => strapi.plugin('audit-log').service('config').resolve();

  /** The instant before which records are considered expired. */
  const cutoffDate = (retentionDays: number, now: Date = new Date()): Date =>
    new Date(now.getTime() - retentionDays * MS_PER_DAY);

  /**
   * Deletes everything older than the retention window.
   *
   * Safe to call by hand — from a console session, or a one-off script — and
   * returns the number of rows removed.
   */
  const cleanup = async (): Promise<number> => {
    const { retentionDays } = getConfig();
    if (retentionDays <= 0) return 0;

    const cutoff = cutoffDate(retentionDays);
    const audit = strapi.plugin('audit-log').service('audit');
    const deleted = await audit.deleteOlderThan(cutoff);

    if (deleted > 0) {
      strapi.log.info(
        `[audit-log] retention removed ${deleted} record(s) created before ${cutoff.toISOString()}.`
      );

      /**
       * The purge records itself.
       *
       * This is the only deletion the plugin permits, and a deletion that leaves
       * no trace is indistinguishable from someone removing rows by hand. The
       * record goes through the normal write path, so it is chained like any
       * other and forwarded like any other; the count and the cutoff are what
       * let a reviewer reconcile the table against what retention says it did.
       * Not gated by `securityEvents` — there is no configuration in which a
       * purge should be silent.
       */
      await audit.record({
        action: 'retention.purge',
        contentType: SUBJECTS.auditLog,
        contentTypeDisplayName: SUBJECT_DISPLAY_NAMES[SUBJECTS.auditLog] ?? 'Audit log',
        contentDocumentId: null,
        contentId: null,
        locale: null,
        changes: null,
        before: null,
        after: null,
        outcome: 'success',
        metadata: { deletedCount: deleted, cutoff: cutoff.toISOString(), retentionDays },
        source: 'cron',
        userId: null,
        userEmail: null,
        userName: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
      });
    }

    return deleted;
  };

  const register = (): void => {
    const { retentionDays, retentionCron } = getConfig();

    if (retentionDays <= 0) {
      strapi.log.debug('[audit-log] retentionDays is 0 — automatic cleanup is disabled.');
      return;
    }

    strapi.cron.add({
      [RETENTION_JOB_NAME]: {
        async task() {
          try {
            await cleanup();
          } catch (error) {
            // Thrown out of a cron task this would be an unhandled rejection.
            // Retention failing is an operational problem, not a reason to take
            // the process down.
            strapi.log.error(
              `[audit-log] retention job failed: ${(error as Error)?.message ?? error}`
            );
          }
        },
        options: retentionCron,
      },
    });

    strapi.log.info(
      `[audit-log] retention enabled: records older than ${retentionDays} day(s) are removed on "${retentionCron}".`
    );
  };

  const unregister = (): void => {
    try {
      strapi.cron.remove(RETENTION_JOB_NAME);
    } catch {
      // `remove` throws only on a missing name, which is the state we wanted.
    }
  };

  return { cleanup, cutoffDate, register, unregister };
};

export default retentionService;
