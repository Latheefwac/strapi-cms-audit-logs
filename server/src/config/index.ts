import { ALL_ACTIONS, ALL_SECURITY_ACTIONS } from '../constants';
import type { AuditUserConfig } from '../types';

/**
 * Defaults merged with the consumer's `config/plugins.ts` block.
 *
 * ## Why the collection-valued keys default to `null`
 *
 * Strapi merges plugin config with lodash's `defaultsDeep`, which merges arrays
 * *element-wise*. With `ignoredFields: ['password', 'token', 'apiKey', 'secret']`
 * as a literal default, a consumer writing `ignoredFields: ['internalNote']`
 * would silently end up with `['internalNote', 'token', 'apiKey', 'secret']` —
 * their first element replaced, the rest of ours retained. That is a trap, and a
 * dangerous one for a redaction list.
 *
 * So every array/selector option defaults to `null` here, meaning "not set", and
 * the real defaults are applied in `services/config.ts`. `null` is not an array,
 * so `defaultsDeep` replaces it wholesale and the consumer gets exactly the list
 * they wrote. `additionalIgnoredFields` exists for the common case of wanting
 * ours *plus* a few of their own.
 */
export default {
  default: {
    enabled: true,

    actions: null,
    contentTypes: null,
    ignoredContentTypes: null,
    ignoredFields: null,
    additionalIgnoredFields: null,
    ignoredChangeFields: null,

    storeBefore: true,
    storeAfter: true,
    storeChanges: true,

    retentionDays: 365,
    retentionCron: '0 3 * * *',

    failOnAuditError: false,
    writeMode: 'sync',

    maxPopulateDepth: 2,
    maxSnapshotBytes: 512 * 1024,
    auditSystemOperations: true,

    // `null` for the same reason every other collection-valued option is null —
    // see the note above on `defaultsDeep` splicing arrays element-wise.
    securityEvents: null,

    forwardToLogger: false,
    forwardLogLevel: 'info',

    correlationId: true,
  },

  /**
   * Runs once at boot, before anything else touches the config. Throwing here
   * fails startup with a clear message, which is far kinder than a plugin that
   * silently audits nothing because of a typo.
   */
  validator(config: AuditUserConfig & { enabled?: boolean }) {
    const fail = (message: string): never => {
      throw new Error(message);
    };

    if (config.actions != null) {
      if (!Array.isArray(config.actions)) {
        fail(`"actions" must be an array, received ${typeof config.actions}`);
      }
      for (const action of config.actions) {
        if (!ALL_ACTIONS.includes(action)) {
          fail(`"actions" contains an unknown action "${action}". Allowed: ${ALL_ACTIONS.join(', ')}`);
        }
      }
    }

    if (config.contentTypes != null && config.contentTypes !== '*' && !Array.isArray(config.contentTypes)) {
      fail('"contentTypes" must be "*" or an array of content-type uids');
    }

    for (const key of [
      'ignoredContentTypes',
      'ignoredFields',
      'additionalIgnoredFields',
      'ignoredChangeFields',
    ] as const) {
      const value = config[key];
      if (value != null && !Array.isArray(value)) {
        fail(`"${key}" must be an array of strings`);
      }
    }

    for (const key of ['storeBefore', 'storeAfter', 'storeChanges', 'failOnAuditError', 'auditSystemOperations'] as const) {
      const value = config[key];
      if (value != null && typeof value !== 'boolean') {
        fail(`"${key}" must be a boolean`);
      }
    }

    if (config.retentionDays != null) {
      if (typeof config.retentionDays !== 'number' || !Number.isFinite(config.retentionDays) || config.retentionDays < 0) {
        fail('"retentionDays" must be a number >= 0 (0 disables automatic deletion)');
      }
    }

    if (config.writeMode != null && config.writeMode !== 'sync' && config.writeMode !== 'async') {
      fail('"writeMode" must be either "sync" or "async"');
    }

    if (config.securityEvents != null && config.securityEvents !== '*') {
      if (!Array.isArray(config.securityEvents)) {
        fail('"securityEvents" must be "*" or an array of security event names');
      }
      for (const event of config.securityEvents) {
        if (!ALL_SECURITY_ACTIONS.includes(event)) {
          fail(
            `"securityEvents" contains an unknown event "${event}". Allowed: ${ALL_SECURITY_ACTIONS.join(', ')}`
          );
        }
      }
    }

    if (config.forwardToLogger != null && typeof config.forwardToLogger !== 'boolean') {
      fail('"forwardToLogger" must be a boolean');
    }

    if (config.correlationId != null && typeof config.correlationId !== 'boolean') {
      fail('"correlationId" must be a boolean');
    }

    if (
      config.forwardLogLevel != null &&
      !['debug', 'info', 'warn', 'error'].includes(config.forwardLogLevel)
    ) {
      fail('"forwardLogLevel" must be one of: debug, info, warn, error');
    }

    if (config.maxPopulateDepth != null) {
      if (typeof config.maxPopulateDepth !== 'number' || config.maxPopulateDepth < 0 || config.maxPopulateDepth > 5) {
        fail('"maxPopulateDepth" must be a number between 0 and 5');
      }
    }

    if (config.maxSnapshotBytes != null) {
      if (typeof config.maxSnapshotBytes !== 'number' || config.maxSnapshotBytes < 0) {
        fail('"maxSnapshotBytes" must be a number >= 0 (0 disables the cap)');
      }
    }
  },
};
