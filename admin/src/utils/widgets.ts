/**
 * Turns a pair of raw snapshots into a per-widget before/after view.
 *
 * ## The problem this solves
 *
 * The server's diff engine flattens everything into dotted paths, so editing one
 * widget on a page produces entries like `widgets[3].heading` and
 * `widgets[3].cta.label`. That is exactly right for a field-level question
 * ("what text changed?") and exactly wrong for the question editors actually
 * ask, which is "what did that widget look like before, and what does it look
 * like now?". Answering it from a flat path list means reading an index out of a
 * string and mentally reassembling a component.
 *
 * So the widgets are reassembled here instead: each changed slot yields the
 * whole component as it was and the whole component as it now is, and the detail
 * page renders the widget twice, once per side.
 *
 * ## Why this runs in the browser
 *
 * Everything it needs is already on the record — `before` and `after` are
 * returned in full by `GET /audit-log/logs/:id`. Computing it server-side would
 * mean either a new stored column (wrong for existing rows, which would show
 * nothing) or a per-request pass over two JSON blobs to produce something only
 * the detail page reads. Doing it here also means the feature works
 * retroactively, on every record already in the table.
 *
 * ## Why it is not schema-aware
 *
 * Nothing here knows what a "widget" is in any particular project. A dynamic
 * zone is recognised structurally — an array whose members are objects carrying
 * `__component` — which is how Strapi itself marks them in a populated result.
 * That covers `widgets` on a page, `blocks` on an article and any zone added
 * later, on any content type, with no list to maintain.
 */

/** One component instance inside a dynamic zone, as it appears in a snapshot. */
export interface WidgetInstance {
  __component: string;
  [field: string]: unknown;
}

export type WidgetStatus = 'changed' | 'added' | 'removed' | 'unchanged';

/** One slot of a dynamic zone, paired across the operation. */
export interface WidgetSlot {
  /** Position in the zone. The slot is the unit of comparison — see {@link pairSlots}. */
  index: number;
  status: WidgetStatus;
  /** Component uid, from whichever side exists. */
  component: string;
  /** The component uid on the other side, when the slot was replaced with a different widget. */
  replacedComponent: string | null;
  before: WidgetInstance | null;
  after: WidgetInstance | null;
  /** Dotted field paths that differ, relative to the widget — `heading`, `cta.label`. */
  changedFields: string[];
}

/** A dynamic zone attribute, with its slots paired. */
export interface WidgetZone {
  /** Attribute name on the content type — `widgets`, `blocks`. */
  name: string;
  slots: WidgetSlot[];
  changedCount: number;
}

/** Keys that describe the row rather than the content, and so are never a "change". */
const STRUCTURAL_KEYS = new Set(['id', '__component', '__temp_key__', 'createdAt', 'updatedAt']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True for an array Strapi populated from a dynamic zone. */
const isWidgetArray = (value: unknown): value is WidgetInstance[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isObject(item) && typeof item.__component === 'string');

/**
 * Structural equality, matching the server's own comparison rules.
 *
 * A `Date` and its ISO string compare equal, and `null` and `undefined` both
 * mean "no value" — without those two rules a re-save would report every
 * datetime and every absent optional field as a change, and the "unchanged"
 * group would always be empty.
 */
const isEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const right = b instanceof Date ? b.getTime() : Date.parse(String(b));
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => isEqual(item, b[index]));
  }

  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (STRUCTURAL_KEYS.has(key)) continue;
      if (!isEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
};

/** Dotted paths whose values differ between two widgets, ignoring structural keys. */
const diffFields = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  prefix = ''
): string[] => {
  const paths: string[] = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const key of keys) {
    if (prefix === '' && STRUCTURAL_KEYS.has(key)) continue;

    const left = before?.[key];
    const right = after?.[key];
    if (isEqual(left, right)) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    // Descend into nested components so the highlight lands on `cta.label`
    // rather than on the whole `cta` object — but stop at arrays and scalars,
    // where the containing field is the useful granularity.
    if (isObject(left) && isObject(right)) {
      paths.push(...diffFields(left, right, path));
    } else {
      paths.push(path);
    }
  }

  return paths;
};

/**
 * Pairs the two sides of a zone by slot position.
 *
 * Position, not component id: Strapi does not preserve component row ids across
 * an update — the Content Manager sends the whole zone back and the repository
 * replaces its rows — so ids are new on every save and pairing by them would
 * report every widget as removed-and-added. Position is what an editor sees and
 * reasons about ("the third block"), and it makes a reorder show up as the
 * change it is rather than being silently absorbed.
 */
const pairSlots = (before: WidgetInstance[], after: WidgetInstance[]): WidgetSlot[] => {
  const length = Math.max(before.length, after.length);
  const slots: WidgetSlot[] = [];

  for (let index = 0; index < length; index += 1) {
    const left = before[index] ?? null;
    const right = after[index] ?? null;

    let status: WidgetStatus;
    if (!left) status = 'added';
    else if (!right) status = 'removed';
    else if (isEqual(left, right)) status = 'unchanged';
    else status = 'changed';

    const sameComponent = left && right && left.__component === right.__component;

    slots.push({
      index,
      status,
      component: (right?.__component ?? left?.__component ?? 'unknown') as string,
      // Only meaningful when the slot held one widget and now holds another —
      // otherwise the header would repeat the same name twice.
      replacedComponent: left && right && !sameComponent ? left.__component : null,
      before: left,
      after: right,
      changedFields: status === 'changed' ? diffFields(left, right) : [],
    });
  }

  return slots;
};

/**
 * Every dynamic zone touched by an operation, with its slots paired.
 *
 * Returns an empty array when neither snapshot contains a zone, which is the
 * signal for the detail page to omit the section entirely rather than render an
 * empty heading. A zone identical on both sides is still returned — its slots
 * are all `unchanged`, and the page shows them collapsed as context.
 */
export const extractWidgetZones = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): WidgetZone[] => {
  const zones: WidgetZone[] = [];
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const name of names) {
    const left = before?.[name];
    const right = after?.[name];

    // One side may legitimately be absent — a zone emptied to `[]`, or a create
    // with no `before` at all — so it is enough that *either* side looks like a
    // dynamic zone.
    if (!isWidgetArray(left) && !isWidgetArray(right)) continue;

    const slots = pairSlots(
      isWidgetArray(left) ? left : [],
      isWidgetArray(right) ? right : []
    );

    zones.push({
      name,
      slots,
      changedCount: slots.filter((slot) => slot.status !== 'unchanged').length,
    });
  }

  return zones.sort((a, b) => a.name.localeCompare(b.name));
};

/** `home.hero` -> `Hero`. Falls back to the raw uid for anything unexpected. */
export const widgetLabel = (component: string): string => {
  const name = component.includes('.') ? component.slice(component.indexOf('.') + 1) : component;
  return name
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * A widget flattened to the rows the card renders.
 *
 * Nested components are flattened into dotted paths so a card is a flat list of
 * label/value pairs — the same shape whatever depth the field lives at, and the
 * same shape the `changedFields` highlight is keyed by. Arrays and media objects
 * stop the descent: below that point a card is the wrong tool and the raw JSON
 * viewer is the right one.
 */
export const widgetRows = (
  widget: WidgetInstance | null,
  prefix = ''
): Array<{ path: string; value: unknown }> => {
  if (!widget) return [];

  const rows: Array<{ path: string; value: unknown }> = [];

  for (const [key, value] of Object.entries(widget)) {
    if (prefix === '' && STRUCTURAL_KEYS.has(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (isObject(value) && !(value instanceof Date)) {
      const nested = widgetRows(value as WidgetInstance, path);
      // An object that flattened to nothing (an empty relation, say) is still
      // worth a row — otherwise a cleared field vanishes instead of showing.
      if (nested.length > 0) rows.push(...nested);
      else rows.push({ path, value });
      continue;
    }

    rows.push({ path, value });
  }

  return rows;
};
