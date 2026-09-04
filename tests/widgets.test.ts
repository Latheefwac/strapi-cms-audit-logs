/**
 * The per-widget before/after view.
 *
 * This is the piece that answers "what did that widget look like before, and
 * what does it look like now" — the question a flat list of `widgets[3].heading`
 * paths cannot answer without the reader reassembling the component in their
 * head. The logic lives in the admin bundle because both snapshots are already
 * on the record, which also means it works on rows written before the feature
 * existed.
 */

import {
  extractWidgetZones,
  widgetLabel,
  widgetRows,
  type WidgetInstance,
} from '../admin/src/utils/widgets';

const hero = (heading: string, extra: Record<string, unknown> = {}): WidgetInstance => ({
  id: 1,
  __component: 'home.hero',
  heading,
  subheading: 'Cloud for hotels',
  ...extra,
});

const kpi = (title = 'Numbers'): WidgetInstance => ({
  id: 2,
  __component: 'home.kpi-grid',
  title,
});

describe('extractWidgetZones', () => {
  it('finds a dynamic zone by shape, not by name', () => {
    // Nothing here knows that this project calls its zone `widgets`. A zone is
    // an array of objects carrying `__component`, which is how Strapi marks one
    // in a populated result — so `blocks`, `sections` and anything added later
    // are covered with no list to maintain.
    const zones = extractWidgetZones(
      { blocks: [hero('Old')], title: 'A page' },
      { blocks: [hero('New')], title: 'A page' }
    );

    expect(zones).toHaveLength(1);
    expect(zones[0]!.name).toBe('blocks');
  });

  it('returns nothing for a content type with no dynamic zone', () => {
    // The detail page uses an empty result to omit the whole section rather than
    // render an empty heading on every non-widget record.
    expect(extractWidgetZones({ title: 'Old' }, { title: 'New' })).toEqual([]);
  });

  it('pairs a changed widget so both versions are available', () => {
    const zones = extractWidgetZones(
      { widgets: [kpi(), hero('Welcome to YCS')] },
      { widgets: [kpi(), hero('Run your hotel better')] }
    );

    const slots = zones[0]!.slots;
    expect(zones[0]!.changedCount).toBe(1);

    expect(slots[0]).toMatchObject({ index: 0, status: 'unchanged' });

    // The whole point: one slot, two complete widgets, old and new.
    expect(slots[1]).toMatchObject({ index: 1, status: 'changed', component: 'home.hero' });
    expect(slots[1]!.before).toMatchObject({ heading: 'Welcome to YCS' });
    expect(slots[1]!.after).toMatchObject({ heading: 'Run your hotel better' });
    expect(slots[1]!.changedFields).toEqual(['heading']);
  });

  it('reports nested component fields at their dotted path', () => {
    const zones = extractWidgetZones(
      { widgets: [hero('Same', { cta: { label: 'Book a demo', url: '/demo' } })] },
      { widgets: [hero('Same', { cta: { label: 'Get started', url: '/demo' } })] }
    );

    // `cta.label`, not `cta` — so the highlight lands on the field that moved
    // rather than on the whole nested component.
    expect(zones[0]!.slots[0]!.changedFields).toEqual(['cta.label']);
  });

  it('marks an added widget with no before side', () => {
    const zones = extractWidgetZones({ widgets: [kpi()] }, { widgets: [kpi(), hero('New')] });

    expect(zones[0]!.slots[1]).toMatchObject({ status: 'added', before: null });
    expect(zones[0]!.slots[1]!.after).toMatchObject({ heading: 'New' });
  });

  it('marks a removed widget with no after side', () => {
    const zones = extractWidgetZones({ widgets: [kpi(), hero('Gone')] }, { widgets: [kpi()] });

    expect(zones[0]!.slots[1]).toMatchObject({ status: 'removed', after: null });
    expect(zones[0]!.slots[1]!.before).toMatchObject({ heading: 'Gone' });
  });

  it('names the widget a slot used to hold when it was replaced', () => {
    const zones = extractWidgetZones({ widgets: [hero('Old')] }, { widgets: [kpi()] });

    expect(zones[0]!.slots[0]).toMatchObject({
      status: 'changed',
      component: 'home.kpi-grid',
      replacedComponent: 'home.hero',
    });
  });

  it('ignores a component row id, which Strapi regenerates on every save', () => {
    // The Content Manager sends the whole zone back and the repository replaces
    // its rows, so ids differ after any save. Treating that as a change would
    // mark every widget on the page as edited.
    const zones = extractWidgetZones(
      { widgets: [{ id: 1, __component: 'home.hero', heading: 'Same' }] },
      { widgets: [{ id: 99, __component: 'home.hero', heading: 'Same' }] }
    );

    expect(zones[0]!.slots[0]!.status).toBe('unchanged');
    expect(zones[0]!.changedCount).toBe(0);
  });

  it('treats a date and its ISO string as equal', () => {
    const zones = extractWidgetZones(
      { widgets: [hero('Same', { publishOn: new Date('2026-01-01T00:00:00.000Z') })] },
      { widgets: [hero('Same', { publishOn: '2026-01-01T00:00:00.000Z' })] }
    );

    expect(zones[0]!.slots[0]!.status).toBe('unchanged');
  });

  it('treats an absent field and a null field as equal', () => {
    const zones = extractWidgetZones(
      { widgets: [{ id: 1, __component: 'home.hero', heading: 'Same', note: null }] },
      { widgets: [{ id: 1, __component: 'home.hero', heading: 'Same' }] }
    );

    expect(zones[0]!.slots[0]!.status).toBe('unchanged');
  });

  it('reports a reorder as a change to each moved slot', () => {
    // Slot position is what an editor sees and reasons about, and the stored
    // order *is* the content — so a reorder must show up rather than be absorbed.
    const zones = extractWidgetZones(
      { widgets: [hero('A'), kpi()] },
      { widgets: [kpi(), hero('A')] }
    );

    expect(zones[0]!.changedCount).toBe(2);
  });

  it('handles a create, where there is no before snapshot at all', () => {
    const zones = extractWidgetZones(null, { widgets: [hero('New page')] });

    expect(zones[0]!.slots[0]).toMatchObject({ status: 'added', before: null });
  });

  it('handles a zone emptied to nothing', () => {
    const zones = extractWidgetZones({ widgets: [hero('Gone')] }, { widgets: [] });

    expect(zones[0]!.slots).toHaveLength(1);
    expect(zones[0]!.slots[0]!.status).toBe('removed');
  });
});

describe('widgetRows', () => {
  it('flattens nested components into dotted paths matching changedFields', () => {
    const rows = widgetRows(hero('Welcome', { cta: { label: 'Book', url: '/demo' } }));
    const paths = rows.map((row) => row.path);

    expect(paths).toEqual(
      expect.arrayContaining(['heading', 'subheading', 'cta.label', 'cta.url'])
    );
    // Structural keys describe the row, not the content.
    expect(paths).not.toContain('id');
    expect(paths).not.toContain('__component');
  });

  it('keeps arrays whole rather than descending into them', () => {
    const rows = widgetRows({
      __component: 'home.kpi-grid',
      items: [{ label: 'Rooms' }, { label: 'Revenue' }],
    });

    expect(rows.map((row) => row.path)).toEqual(['items']);
  });

  it('returns nothing for an absent widget', () => {
    expect(widgetRows(null)).toEqual([]);
  });
});

describe('widgetLabel', () => {
  it('turns a component uid into a readable name', () => {
    expect(widgetLabel('home.hero')).toBe('Hero');
    expect(widgetLabel('platform-detail.media-text-cta')).toBe('Media Text Cta');
  });

  it('falls back to the raw value for anything unexpected', () => {
    expect(widgetLabel('unknown')).toBe('Unknown');
  });
});
