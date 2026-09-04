import diffService from '../server/src/services/diff';
import { createPathMatcher } from '../server/src/utils/paths';

const { buildDiff } = diffService({ strapi: {} as never });

describe('diff engine', () => {
  it('reports a primitive change', () => {
    expect(buildDiff({ title: 'Old Homepage' }, { title: 'New Homepage' })).toEqual({
      title: { from: 'Old Homepage', to: 'New Homepage' },
    });
  });

  it('ignores fields that did not change', () => {
    expect(buildDiff({ title: 'Same', slug: 'a' }, { title: 'Same', slug: 'b' })).toEqual({
      slug: { from: 'a', to: 'b' },
    });
  });

  it('flattens nested objects into dotted paths', () => {
    const changes = buildDiff(
      { seo: { metaTitle: 'Old title', metaDescription: 'Old description' } },
      { seo: { metaTitle: 'New title', metaDescription: 'New description' } }
    );

    expect(changes).toEqual({
      'seo.metaTitle': { from: 'Old title', to: 'New title' },
      'seo.metaDescription': { from: 'Old description', to: 'New description' },
    });
  });

  it('addresses array members by index', () => {
    const changes = buildDiff(
      { tags: [{ label: 'a' }, { label: 'b' }] },
      { tags: [{ label: 'a' }, { label: 'c' }] }
    );

    expect(changes).toEqual({ 'tags[1].label': { from: 'b', to: 'c' } });
  });

  it('reports appended and removed array members', () => {
    expect(buildDiff({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      'tags[1]': { from: null, to: 'b' },
    });

    expect(buildDiff({ tags: ['a', 'b'] }, { tags: ['a'] })).toEqual({
      'tags[1]': { from: 'b', to: null },
    });
  });

  it('handles a dynamic zone of mixed component types', () => {
    const before = {
      blocks: [
        { id: 1, __component: 'widgets.hero', heading: 'Welcome' },
        { id: 2, __component: 'widgets.cta', label: 'Buy' },
      ],
    };
    const after = {
      blocks: [
        { id: 1, __component: 'widgets.hero', heading: 'Welcome back' },
        { id: 2, __component: 'widgets.cta', label: 'Buy' },
      ],
    };

    expect(buildDiff(before, after)).toEqual({
      'blocks[0].heading': { from: 'Welcome', to: 'Welcome back' },
    });
  });

  it('treats a replaced dynamic-zone widget as a change of component and content', () => {
    const changes = buildDiff(
      { blocks: [{ id: 1, __component: 'widgets.hero', heading: 'Welcome' }] },
      { blocks: [{ id: 9, __component: 'widgets.cta', label: 'Buy' }] }
    );

    expect(changes).toMatchObject({
      'blocks[0].__component': { from: 'widgets.hero', to: 'widgets.cta' },
      'blocks[0].heading': { from: 'Welcome', to: null },
      'blocks[0].label': { from: null, to: 'Buy' },
    });
  });

  it('detects a media change through the identifying fields', () => {
    const changes = buildDiff(
      { cover: { id: 5, url: '/uploads/old.png' } },
      { cover: { id: 6, url: '/uploads/new.png' } }
    );

    expect(changes).toEqual({
      'cover.id': { from: 5, to: 6 },
      'cover.url': { from: '/uploads/old.png', to: '/uploads/new.png' },
    });
  });

  it('treats a Date and its ISO string as equal', () => {
    // A datetime comes back from the database as a Date but arrives in the
    // request body as a string; comparing them naively marks every write dirty.
    const changes = buildDiff(
      { publishedAt: new Date('2026-09-02T13:10:00.000Z') },
      { publishedAt: '2026-09-02T13:10:00.000Z' }
    );

    expect(changes).toEqual({});
  });

  it('treats null and undefined as the same absence', () => {
    expect(buildDiff({ subtitle: null }, {})).toEqual({});
  });

  it('restricts the diff to the requested keys', () => {
    const changes = buildDiff(
      { title: 'Old', body: 'Old body' },
      { title: 'New', body: 'New body' },
      { keys: ['title'] }
    );

    expect(changes).toEqual({ title: { from: 'Old', to: 'New' } });
  });

  it('excludes ignored paths', () => {
    const changes = buildDiff(
      { title: 'Old', apiKey: 'k1' },
      { title: 'New', apiKey: 'k2' },
      { isIgnored: createPathMatcher(['*apikey*']) }
    );

    expect(changes).toEqual({ title: { from: 'Old', to: 'New' } });
  });

  it('records a whole subtree once the depth budget runs out', () => {
    const before = { a: { b: { c: { d: 'old' } } } };
    const after = { a: { b: { c: { d: 'new' } } } };

    expect(buildDiff(before, after, { maxDepth: 2 })).toEqual({
      'a.b': { from: { c: { d: 'old' } }, to: { c: { d: 'new' } } },
    });
  });

  it('truncates and says so rather than emitting an unbounded diff', () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let index = 0; index < 50; index += 1) {
      before[`field${index}`] = index;
      after[`field${index}`] = index + 1;
    }

    const changes = buildDiff(before, after, { maxChanges: 10 });

    expect(Object.keys(changes)).toHaveLength(11);
    expect(changes.__truncated__!.to).toContain('Diff truncated at 10 changes');
  });

  it('handles a type change from object to primitive', () => {
    expect(buildDiff({ seo: { metaTitle: 'x' } }, { seo: null })).toEqual({
      seo: { from: { metaTitle: 'x' }, to: null },
    });
  });

  it('returns an empty diff for identical snapshots', () => {
    const snapshot = { title: 'Same', blocks: [{ id: 1, heading: 'x' }] };
    expect(buildDiff(snapshot, structuredClone(snapshot))).toEqual({});
  });
});
