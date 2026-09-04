import { DEFAULT_IGNORED_FIELDS } from '../server/src/constants';
import { createPathMatcher, joinPath, toSegments } from '../server/src/utils/paths';
import { sanitizeValue } from '../server/src/utils/sanitize';

describe('path matching', () => {
  it('matches a bare leaf name at any depth', () => {
    const matches = createPathMatcher(['salt']);

    expect(matches('salt')).toBe(true);
    expect(matches('user.salt')).toBe(true);
    expect(matches('blocks[2].auth.salt')).toBe(true);
    expect(matches('saltiness')).toBe(false);
  });

  it('anchors a dotted pattern at the document root', () => {
    const matches = createPathMatcher(['seo.metaTitle']);

    expect(matches('seo.metaTitle')).toBe(true);
    expect(matches('metaTitle')).toBe(false);
    expect(matches('page.seo.metaTitle')).toBe(false);
  });

  it('strips array indices before matching', () => {
    const matches = createPathMatcher(['blocks.secret']);
    expect(matches('blocks[7].secret')).toBe(true);
  });

  it('treats a lone * as exactly one segment', () => {
    const matches = createPathMatcher(['seo.*.token']);

    expect(matches('seo.nested.token')).toBe(true);
    expect(matches('seo.token')).toBe(false);
    expect(matches('seo.a.b.token')).toBe(false);
  });

  it('treats ** as zero or more segments', () => {
    const matches = createPathMatcher(['blocks.**.secret']);

    expect(matches('blocks.secret')).toBe(true);
    expect(matches('blocks[0].inner.secret')).toBe(true);
    expect(matches('blocks[0].a.b.c.secret')).toBe(true);
    expect(matches('other.secret')).toBe(false);
  });

  it('treats * inside a segment as a substring wildcard', () => {
    const matches = createPathMatcher(['*token*']);

    expect(matches('token')).toBe(true);
    expect(matches('accessToken')).toBe(true);
    expect(matches('seo.internalToken')).toBe(true);
    expect(matches('tokenHash')).toBe(true);
    expect(matches('title')).toBe(false);
  });

  it('matches case-insensitively', () => {
    // Attribute names are camelCase; the words worth redacting are not.
    const matches = createPathMatcher(['*SECRET*']);
    expect(matches('stripeSecretKey')).toBe(true);
  });

  it('matches nothing when the list is empty', () => {
    const matches = createPathMatcher([]);
    expect(matches('password')).toBe(false);
  });

  it('builds indexed paths', () => {
    expect(joinPath('', 'title')).toBe('title');
    expect(joinPath('seo', 'metaTitle')).toBe('seo.metaTitle');
    expect(joinPath('blocks', 2)).toBe('blocks[2]');
    expect(toSegments('blocks[2].seo.title')).toEqual(['blocks', 'seo', 'title']);
  });
});

describe('default sensitive fields', () => {
  const matches = createPathMatcher(DEFAULT_IGNORED_FIELDS);

  it.each([
    'password',
    'passwordConfirmation',
    'currentPassword',
    'resetPasswordToken',
    'registrationToken',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'api_key',
    'secret',
    'clientSecret',
    'stripeSecretKey',
    'privateKey',
    'credentials',
    'salt',
    'user.password',
    'seo.internalToken',
    'blocks[3].integration.apiKey',
  ])('redacts %s out of the box', (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each(['title', 'slug', 'metaDescription', 'publishedAt', 'author.name'])(
    'leaves %s alone',
    (path) => {
      expect(matches(path)).toBe(false);
    }
  );
});

describe('sanitizeValue', () => {
  const isIgnored = createPathMatcher(DEFAULT_IGNORED_FIELDS);

  it('drops ignored keys at every depth', () => {
    const input = {
      title: 'Page',
      seo: { metaTitle: 'SEO', internalToken: 'tok_secret' },
      blocks: [
        { heading: 'One', apiKey: 'k_live_123' },
        { heading: 'Two', nested: { password: 'hunter2' } },
      ],
    };

    expect(sanitizeValue(input, isIgnored)).toEqual({
      title: 'Page',
      seo: { metaTitle: 'SEO' },
      blocks: [{ heading: 'One' }, { heading: 'Two', nested: {} }],
    });
  });

  it('drops the value entirely rather than masking it', () => {
    // A placeholder still tells a reader the field exists and changed, which for
    // a credential is more than an audit trail should say.
    const result = sanitizeValue({ password: 'hunter2' }, isIgnored) as Record<string, unknown>;
    expect('password' in result).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = { seo: { internalToken: 'tok_secret' } };
    sanitizeValue(input, isIgnored);
    expect(input.seo.internalToken).toBe('tok_secret');
  });

  it('passes primitives and nulls through untouched', () => {
    expect(sanitizeValue(null, isIgnored)).toBeNull();
    expect(sanitizeValue('text', isIgnored)).toBe('text');
    expect(sanitizeValue(42, isIgnored)).toBe(42);
  });
});
