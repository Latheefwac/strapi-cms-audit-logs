import pluginConfig from '../server/src/config';
import { ALL_ACTIONS, DEFAULT_IGNORED_FIELDS } from '../server/src/constants';
import configService from '../server/src/services/config';

const resolveWith = (raw: Record<string, unknown>) => {
  const strapi = { config: { get: () => raw } } as never;
  return configService({ strapi }).resolve();
};

const serviceWith = (raw: Record<string, unknown>) => {
  const strapi = { config: { get: () => raw } } as never;
  return configService({ strapi });
};

describe('configuration defaults', () => {
  it('audits every action on every content type out of the box', () => {
    const config = resolveWith({});

    expect(config.actions).toEqual(ALL_ACTIONS);
    expect(config.contentTypes).toBe('*');
    expect(config.ignoredContentTypes).toEqual([]);
    expect(config.storeBefore).toBe(true);
    expect(config.storeAfter).toBe(true);
    expect(config.storeChanges).toBe(true);
    expect(config.retentionDays).toBe(365);
    expect(config.failOnAuditError).toBe(false);
    expect(config.writeMode).toBe('sync');
    expect(config.ignoredFields).toEqual(DEFAULT_IGNORED_FIELDS);
  });

  it('declares collection options as null so lodash cannot merge arrays element-wise', () => {
    // Strapi merges plugin config with `defaultsDeep`, which merges arrays by
    // index. A literal array default would silently splice a consumer's
    // `ignoredFields: ['x']` into `['x', ...ours.slice(1)]`.
    for (const key of [
      'actions',
      'contentTypes',
      'ignoredContentTypes',
      'ignoredFields',
      'additionalIgnoredFields',
      'ignoredChangeFields',
    ] as const) {
      expect(pluginConfig.default[key]).toBeNull();
    }
  });

  it('replaces the sensitive-field list wholesale when one is supplied', () => {
    const config = resolveWith({ ignoredFields: ['onlyThis'] });
    expect(config.ignoredFields).toEqual(['onlyThis']);
    expect(config.isIgnoredForSnapshot('password')).toBe(false);
    expect(config.isIgnoredForSnapshot('onlyThis')).toBe(true);
  });

  it('extends rather than replaces via additionalIgnoredFields', () => {
    const config = resolveWith({ additionalIgnoredFields: ['seo.internalNote'] });
    expect(config.isIgnoredForSnapshot('password')).toBe(true);
    expect(config.isIgnoredForSnapshot('seo.internalNote')).toBe(true);
  });

  it('keeps ignoredChangeFields out of the diff but inside the snapshots', () => {
    const config = resolveWith({});
    expect(config.isIgnoredForChanges('updatedAt')).toBe(true);
    expect(config.isIgnoredForSnapshot('updatedAt')).toBe(false);
  });
});

describe('content-type selection', () => {
  it('audits everything under the "*" default', () => {
    const service = serviceWith({});
    expect(service.isAuditedContentType('api::page.page')).toBe(true);
  });

  it('honours an explicit allow-list', () => {
    const service = serviceWith({ contentTypes: ['api::page.page'] });
    expect(service.isAuditedContentType('api::page.page')).toBe(true);
    expect(service.isAuditedContentType('api::author.author')).toBe(false);
  });

  it('lets exclusions win over the allow-list', () => {
    const service = serviceWith({
      contentTypes: ['api::page.page'],
      ignoredContentTypes: ['api::page.page'],
    });
    expect(service.isAuditedContentType('api::page.page')).toBe(false);
  });

  it('never audits its own collection type', () => {
    // Auditing the audit log would recurse on every write.
    const service = serviceWith({ contentTypes: '*' });
    expect(service.isAuditedContentType('plugin::audit-log.audit-log')).toBe(false);
  });
});

describe('configuration validation', () => {
  const validate = (raw: Record<string, unknown>) => () => pluginConfig.validator(raw as never);

  it('accepts the documented example', () => {
    expect(
      validate({
        actions: ['create', 'update', 'delete', 'publish', 'unpublish'],
        contentTypes: '*',
        ignoredContentTypes: [],
        ignoredFields: ['password', 'token', 'apiKey', 'secret'],
        storeBefore: true,
        storeAfter: true,
        storeChanges: true,
        retentionDays: 365,
      })
    ).not.toThrow();
  });

  it('accepts an empty config', () => {
    expect(validate({})).not.toThrow();
  });

  it('rejects an unknown action rather than silently auditing nothing', () => {
    expect(validate({ actions: ['create', 'frobnicate'] })).toThrow(/unknown action "frobnicate"/);
  });

  it('rejects a malformed contentTypes selector', () => {
    expect(validate({ contentTypes: 'api::page.page' })).toThrow(/must be "\*" or an array/);
  });

  it('rejects a non-array ignore list', () => {
    expect(validate({ ignoredFields: 'password' })).toThrow(/must be an array of strings/);
  });

  it('rejects a negative retention window', () => {
    expect(validate({ retentionDays: -1 })).toThrow(/must be a number >= 0/);
  });

  it('rejects an unknown write mode', () => {
    expect(validate({ writeMode: 'eventually' })).toThrow(/either "sync" or "async"/);
  });

  it('rejects an out-of-range populate depth', () => {
    expect(validate({ maxPopulateDepth: 99 })).toThrow(/between 0 and 5/);
  });
});
