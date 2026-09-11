import type { Core } from '@strapi/strapi';

import {
  ALL_ACTIONS,
  ALL_SECURITY_ACTIONS,
  DEFAULT_IGNORED_CHANGE_FIELDS,
  DEFAULT_IGNORED_FIELDS,
  PLUGIN_ID,
} from '../constants';
import { createPathMatcher, type PathMatcher } from '../utils/sanitize';
import type {
  AuditAction,
  AuditConfig,
  AuditLogLevel,
  AuditSecurityAction,
} from '../types';

export interface ResolvedConfig extends AuditConfig {
  /** True when `changes` is excluded from a path as well as `before`/`after`. */
  isIgnoredForChanges: PathMatcher;
  /** True when a path must never be persisted anywhere. */
  isIgnoredForSnapshot: PathMatcher;
}

const asArray = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value) ? value.map(String) : fallback;

/**
 * Resolves and caches the effective configuration.
 *
 * Cached because it is read on the hot path — once per audited write — and
 * because `createPathMatcher` compiles the ignore patterns. Nothing invalidates
 * it: Strapi's plugin config is fixed at boot, so a cache miss can only happen
 * once per process.
 */
const configService = ({ strapi }: { strapi: Core.Strapi }) => {
  let cached: ResolvedConfig | null = null;

  const resolve = (): ResolvedConfig => {
    if (cached) return cached;

    const raw = (strapi.config.get(`plugin::${PLUGIN_ID}`, {}) ?? {}) as Record<string, unknown>;

    const ignoredFields = asArray(raw.ignoredFields, DEFAULT_IGNORED_FIELDS);
    const additionalIgnoredFields = asArray(raw.additionalIgnoredFields, []);
    const ignoredChangeFields = asArray(raw.ignoredChangeFields, DEFAULT_IGNORED_CHANGE_FIELDS);

    const snapshotPatterns = [...ignoredFields, ...additionalIgnoredFields];

    const contentTypes = raw.contentTypes == null ? '*' : (raw.contentTypes as AuditConfig['contentTypes']);

    const config: ResolvedConfig = {
      actions: (Array.isArray(raw.actions) ? raw.actions : ALL_ACTIONS) as AuditAction[],
      contentTypes: Array.isArray(contentTypes) ? contentTypes.map(String) : '*',
      ignoredContentTypes: asArray(raw.ignoredContentTypes, []),
      ignoredFields,
      additionalIgnoredFields,
      ignoredChangeFields,

      storeBefore: raw.storeBefore !== false,
      storeAfter: raw.storeAfter !== false,
      storeChanges: raw.storeChanges !== false,

      retentionDays: typeof raw.retentionDays === 'number' ? raw.retentionDays : 365,
      retentionCron: typeof raw.retentionCron === 'string' ? raw.retentionCron : '0 3 * * *',

      failOnAuditError: raw.failOnAuditError === true,
      writeMode: raw.writeMode === 'async' ? 'async' : 'sync',

      maxPopulateDepth: typeof raw.maxPopulateDepth === 'number' ? raw.maxPopulateDepth : 2,
      maxSnapshotBytes: typeof raw.maxSnapshotBytes === 'number' ? raw.maxSnapshotBytes : 512 * 1024,
      auditSystemOperations: raw.auditSystemOperations !== false,

      securityEvents: Array.isArray(raw.securityEvents)
        ? (raw.securityEvents.map(String) as AuditSecurityAction[])
        : '*',

      forwardToLogger: raw.forwardToLogger === true,
      correlationId: raw.correlationId !== false,
      forwardLogLevel: (['debug', 'info', 'warn', 'error'] as const).includes(
        raw.forwardLogLevel as AuditLogLevel
      )
        ? (raw.forwardLogLevel as AuditLogLevel)
        : 'info',

      isIgnoredForSnapshot: createPathMatcher(snapshotPatterns),
      isIgnoredForChanges: createPathMatcher([...snapshotPatterns, ...ignoredChangeFields]),
    };

    cached = config;
    return config;
  };

  /**
   * Whether a content type is audited.
   *
   * Exclusions win over inclusions, and the plugin's own collection type is
   * always excluded — auditing the audit log would recurse on every write.
   * Components are not content types and never reach this check; they are
   * audited as part of the document that holds them.
   */
  const isAuditedContentType = (uid: string): boolean => {
    const { contentTypes, ignoredContentTypes } = resolve();

    if (uid === `plugin::${PLUGIN_ID}.audit-log`) return false;
    if (ignoredContentTypes.includes(uid)) return false;
    if (contentTypes === '*') return true;

    return contentTypes.includes(uid);
  };

  const isAuditedAction = (action: AuditAction): boolean => resolve().actions.includes(action);

  /**
   * Whether one security event is recorded.
   *
   * Separate from {@link isAuditedAction} on purpose. `actions` selects content
   * operations and is validated against the five Document Service verbs; a
   * project that narrows it to `['create', 'update']` is saying something about
   * its content, not about whether it wants to know who logged in.
   */
  const isAuditedSecurityAction = (action: AuditSecurityAction): boolean => {
    const { securityEvents } = resolve();
    if (securityEvents === '*') return true;
    return securityEvents.includes(action);
  };

  /** True when at least one security event is enabled — i.e. the listeners are worth registering. */
  const hasSecurityEvents = (): boolean => {
    const { securityEvents } = resolve();
    return securityEvents === '*' || securityEvents.length > 0;
  };

  /** Every security event this project has switched on. */
  const enabledSecurityActions = (): AuditSecurityAction[] => {
    const { securityEvents } = resolve();
    return securityEvents === '*' ? [...ALL_SECURITY_ACTIONS] : securityEvents;
  };

  /** Exposed for the admin UI's read-only settings panel. Never returns the compiled matchers. */
  const getPublicConfig = (): AuditConfig => {
    const { isIgnoredForChanges: _c, isIgnoredForSnapshot: _s, ...rest } = resolve();
    void _c;
    void _s;
    return rest;
  };

  /** Test seam: drops the memoised value so a test can re-read a mutated config. */
  const clearCache = (): void => {
    cached = null;
  };

  return {
    resolve,
    isAuditedContentType,
    isAuditedAction,
    isAuditedSecurityAction,
    hasSecurityEvents,
    enabledSecurityActions,
    getPublicConfig,
    clearCache,
  };
};

export default configService;
