import type { Core } from '@strapi/strapi';

import { PLUGIN_ID } from './constants';

/**
 * Wires the plugin up once Strapi is fully loaded.
 *
 * Order matters here. The immutability guard is registered *before* the tracker
 * so that it sits earlier in the Document Service middleware chain: a forbidden
 * write to the audit table is rejected before the tracker has done any work for
 * it. Both are registered in `bootstrap` rather than `register` because
 * `strapi.documents` is not available until the content types have loaded.
 */
const bootstrap = ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = strapi.plugin(PLUGIN_ID);
  const config = plugin.service('config').resolve();

  plugin.service('immutability').register();
  plugin.service('tracker').register();
  plugin.service('security').register();
  plugin.service('retention').register();

  const scope =
    config.contentTypes === '*'
      ? 'all content types'
      : `${config.contentTypes.length} content type(s)`;

  strapi.log.info(
    `[audit-log] tracking ${config.actions.join(', ')} on ${scope}` +
      (config.ignoredContentTypes.length > 0
        ? ` (${config.ignoredContentTypes.length} ignored)`
        : '') +
      `; writes are ${config.writeMode}.`
  );

  if (config.forwardToLogger) {
    strapi.log.info(
      `[audit-log] mirroring every record to the logger at level "${config.forwardLogLevel}" for downstream collection.`
    );
  }
};

export default bootstrap;
