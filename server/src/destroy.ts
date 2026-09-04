import type { Core } from '@strapi/strapi';

import { PLUGIN_ID } from './constants';

/**
 * Shuts the plugin down cleanly.
 *
 * Flushing pending writes is the part that matters. In `writeMode: 'async'` the
 * audit inserts are in flight when the process is asked to stop, and an audit
 * trail that silently drops its last few records on every deploy is worse than
 * useless — it is misleading. Draining here turns "async loses data on restart"
 * into "async loses data only on a hard kill", which is a trade-off a reader of
 * the README can actually reason about.
 *
 * The cron job is removed too, so a `strapi.destroy()` followed by a fresh boot
 * in the same process (which is what the test harness and `strapi console` do)
 * does not end up with two retention jobs scheduled.
 */
const destroy = async ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = strapi.plugin(PLUGIN_ID);

  try {
    // Taken off before the flush: a listener that fires during shutdown would
    // queue a write the flush below has already gone past.
    plugin.service('security').unregister();
  } catch (error) {
    strapi.log.debug(`[audit-log] security listener teardown: ${(error as Error)?.message ?? error}`);
  }

  try {
    plugin.service('retention').unregister();
  } catch (error) {
    strapi.log.debug(`[audit-log] retention teardown: ${(error as Error)?.message ?? error}`);
  }

  try {
    await plugin.service('audit').flush();
  } catch (error) {
    strapi.log.error(`[audit-log] failed to flush pending writes: ${(error as Error)?.message ?? error}`);
  }
};

export default destroy;
