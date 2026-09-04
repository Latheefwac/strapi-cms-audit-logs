import * as React from 'react';

import { Badge, Box, Button, Flex, Typography } from '@strapi/design-system';
import { CaretDown, CaretUp } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { formatValue } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';
import {
  extractWidgetZones,
  widgetLabel,
  widgetRows,
  type WidgetInstance,
  type WidgetSlot,
  type WidgetStatus,
} from '../utils/widgets';

import { JsonViewer } from './JsonViewer';

interface WidgetDiffProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const STATUS_STYLE: Record<WidgetStatus, { background: string; text: string; border: string }> = {
  changed: { background: 'primary100', text: 'primary600', border: 'primary200' },
  added: { background: 'success100', text: 'success600', border: 'success200' },
  removed: { background: 'danger100', text: 'danger600', border: 'danger200' },
  unchanged: { background: 'neutral150', text: 'neutral600', border: 'neutral200' },
};

/** Rows shown before a long widget collapses behind "show all fields". */
const COLLAPSE_AFTER_ROWS = 12;

interface WidgetCardProps {
  side: 'before' | 'after';
  widget: WidgetInstance | null;
  changedFields: string[];
  emptyLabel: string;
}

/**
 * One side of one widget, rendered in full.
 *
 * Full state rather than only the fields that moved: the point of showing the
 * widget twice is that each card is a readable picture of the widget at a moment
 * in time. A card containing only the two fields that changed would be the flat
 * diff again, in a box.
 */
const WidgetCard = ({ side, widget, changedFields, emptyLabel }: WidgetCardProps) => {
  const { formatMessage } = useIntl();
  const [showAll, setShowAll] = React.useState(false);

  const rows = React.useMemo(() => widgetRows(widget), [widget]);
  const changed = React.useMemo(() => new Set(changedFields), [changedFields]);

  const isBefore = side === 'before';
  const tint = isBefore
    ? { background: 'danger100', text: 'danger600', border: 'danger200' }
    : { background: 'success100', text: 'success600', border: 'success200' };

  const visible = showAll ? rows : rows.slice(0, COLLAPSE_AFTER_ROWS);
  const hidden = rows.length - visible.length;

  return (
    <Box
      background={tint.background}
      hasRadius
      padding={4}
      borderColor={tint.border}
      borderWidth="1px"
      borderStyle="solid"
    >
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="pi" fontWeight="bold" textColor={tint.text}>
          {isBefore
            ? formatMessage({ id: getTranslation('widgets.before'), defaultMessage: 'Before' })
            : formatMessage({ id: getTranslation('widgets.after'), defaultMessage: 'After' })}
        </Typography>
        {rows.length > 0 ? (
          <Typography variant="pi" textColor="neutral600">
            {formatMessage(
              { id: getTranslation('widgets.fieldCount'), defaultMessage: '{count} fields' },
              { count: rows.length }
            )}
          </Typography>
        ) : null}
      </Flex>

      {widget === null ? (
        <Typography variant="pi" textColor="neutral600" style={{ fontStyle: 'italic' }}>
          {emptyLabel}
        </Typography>
      ) : (
        <Flex direction="column" alignItems="stretch" gap={2}>
          {visible.map(({ path, value }) => {
            const isChanged = changed.has(path);

            return (
              <Flex key={path} alignItems="flex-start" gap={3}>
                <Box style={{ minWidth: '30%', maxWidth: '30%' }}>
                  <Typography
                    variant="pi"
                    fontWeight={isChanged ? 'bold' : 'regular'}
                    textColor={isChanged ? tint.text : 'neutral600'}
                    style={{ wordBreak: 'break-word' }}
                  >
                    {path}
                  </Typography>
                </Box>
                <Box style={{ flex: 1 }}>
                  <Typography
                    variant="pi"
                    tag="p"
                    fontWeight={isChanged ? 'bold' : 'regular'}
                    textColor="neutral800"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}
                  >
                    {formatValue(value, 320)}
                  </Typography>
                </Box>
              </Flex>
            );
          })}

          {hidden > 0 ? (
            <Box paddingTop={1}>
              <Button variant="tertiary" size="S" onClick={() => setShowAll(true)}>
                {formatMessage(
                  {
                    id: getTranslation('widgets.showAllFields'),
                    defaultMessage: 'Show {count} more fields',
                  },
                  { count: hidden }
                )}
              </Button>
            </Box>
          ) : null}
        </Flex>
      )}
    </Box>
  );
};

/**
 * One slot of a dynamic zone.
 *
 * A changed slot renders two cards stacked — the widget as it was, then the
 * widget as it is. Stacked rather than side by side because CMS values are
 * routinely whole paragraphs, and two narrow columns turn a one-line copy edit
 * into a pair of unreadable ribbons of wrapped text. Stacking keeps every value
 * at full width and puts the two versions of a field within a screen of each
 * other, which is where a reader compares them.
 */
const WidgetSlotView = ({ slot }: { slot: WidgetSlot }) => {
  const { formatMessage } = useIntl();
  const [isOpen, setIsOpen] = React.useState(slot.status !== 'unchanged');

  const style = STATUS_STYLE[slot.status];

  const statusLabel = formatMessage({
    id: getTranslation(`widgets.status.${slot.status}`),
    defaultMessage: slot.status,
  });

  return (
    <Box
      hasRadius
      background="neutral0"
      borderColor={style.border}
      borderWidth="1px"
      borderStyle="solid"
      padding={4}
    >
      <Flex justifyContent="space-between" alignItems="center" gap={3}>
        <Flex alignItems="center" gap={2} style={{ minWidth: 0 }}>
          <Badge>{`#${slot.index}`}</Badge>
          <Typography variant="delta" tag="h4" style={{ wordBreak: 'break-word' }}>
            {widgetLabel(slot.component)}
          </Typography>
          <Typography
            variant="pi"
            textColor="neutral500"
            style={{
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            }}
          >
            {slot.component}
          </Typography>
        </Flex>

        <Flex alignItems="center" gap={2}>
          <Badge backgroundColor={style.background} textColor={style.text}>
            {statusLabel}
          </Badge>
          <Button
            variant="tertiary"
            size="S"
            startIcon={isOpen ? <CaretUp /> : <CaretDown />}
            onClick={() => setIsOpen((open) => !open)}
          >
            {isOpen
              ? formatMessage({ id: getTranslation('widgets.hide'), defaultMessage: 'Hide' })
              : formatMessage({ id: getTranslation('widgets.show'), defaultMessage: 'Show' })}
          </Button>
        </Flex>
      </Flex>

      {/* The slot held one widget and now holds another — worth saying outright,
          because the two cards below otherwise look like an unusually large edit. */}
      {slot.replacedComponent ? (
        <Box paddingTop={2}>
          <Typography variant="pi" textColor="warning600">
            {formatMessage(
              {
                id: getTranslation('widgets.replaced'),
                defaultMessage: 'This slot previously held a different widget ({component}).',
              },
              { component: slot.replacedComponent }
            )}
          </Typography>
        </Box>
      ) : null}

      {isOpen ? (
        <Box paddingTop={4}>
          <Flex direction="column" alignItems="stretch" gap={3}>
            {/* An added widget has no "before" worth a card — showing an empty
                red box would imply something was there. Same for a removal. */}
            {slot.status !== 'added' ? (
              <WidgetCard
                side="before"
                widget={slot.before}
                changedFields={slot.changedFields}
                emptyLabel={formatMessage({
                  id: getTranslation('widgets.noBefore'),
                  defaultMessage: 'This widget did not exist before the change.',
                })}
              />
            ) : null}

            {slot.status !== 'removed' ? (
              <WidgetCard
                side="after"
                widget={slot.after}
                changedFields={slot.changedFields}
                emptyLabel={formatMessage({
                  id: getTranslation('widgets.noAfter'),
                  defaultMessage: 'This widget was removed by the change.',
                })}
              />
            ) : null}

            <JsonViewer
              label={formatMessage(
                { id: getTranslation('widgets.raw'), defaultMessage: 'Raw JSON for slot {index}' },
                { index: slot.index }
              )}
              value={{ before: slot.before, after: slot.after }}
            />
          </Flex>
        </Box>
      ) : null}
    </Box>
  );
};

/**
 * Per-widget before/after view of a dynamic zone.
 *
 * The flat `changes` list one section up answers "which fields moved". This
 * answers the question an editor actually arrives with — "what did that widget
 * look like before, and what does it look like now" — by rendering each changed
 * widget twice, once per side, in full.
 *
 * Zones are found structurally rather than by name (see `utils/widgets.ts`), so
 * this works on `widgets`, on `blocks`, and on any zone added to any content
 * type later, with nothing to register.
 */
const WidgetDiff = ({ before, after }: WidgetDiffProps) => {
  const { formatMessage } = useIntl();
  const [showUnchanged, setShowUnchanged] = React.useState(false);

  const zones = React.useMemo(() => extractWidgetZones(before, after), [before, after]);

  // No dynamic zone in either snapshot: this record is about a content type that
  // has none, and an empty heading would be noise on every one of them.
  if (zones.length === 0) return null;

  return (
    // The component owns its card rather than being wrapped by the page: it
    // renders nothing when there is no dynamic zone, and a caller-supplied
    // wrapper would leave an empty card behind on every content type without one.
    <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="delta" tag="h2">
          {formatMessage({ id: getTranslation('widgets.title'), defaultMessage: 'Widgets' })}
        </Typography>
        <Button variant="tertiary" size="S" onClick={() => setShowUnchanged((show) => !show)}>
          {showUnchanged
            ? formatMessage({
                id: getTranslation('widgets.hideUnchanged'),
                defaultMessage: 'Hide unchanged widgets',
              })
            : formatMessage({
                id: getTranslation('widgets.showUnchanged'),
                defaultMessage: 'Show unchanged widgets',
              })}
        </Button>
      </Flex>

      <Box paddingBottom={4}>
        <Typography variant="pi" textColor="neutral600">
          {formatMessage({
            id: getTranslation('widgets.hint'),
            defaultMessage:
              'Each changed widget is shown twice — once with the data it held before this operation, and once with the data it holds after. Fields that differ are highlighted in both copies.',
          })}
        </Typography>
      </Box>

      <Flex direction="column" alignItems="stretch" gap={6}>
        {zones.map((zone) => {
          const visible = showUnchanged
            ? zone.slots
            : zone.slots.filter((slot) => slot.status !== 'unchanged');
          const hiddenCount = zone.slots.length - visible.length;

          return (
            <Box key={zone.name}>
              <Flex alignItems="center" gap={2} paddingBottom={3}>
                <Typography variant="sigma" textColor="neutral600">
                  {zone.name}
                </Typography>
                <Badge>
                  {formatMessage(
                    {
                      id: getTranslation('widgets.zoneSummary'),
                      defaultMessage: '{changed} changed of {total}',
                    },
                    { changed: zone.changedCount, total: zone.slots.length }
                  )}
                </Badge>
              </Flex>

              {visible.length === 0 ? (
                <Typography textColor="neutral600">
                  {formatMessage(
                    {
                      id: getTranslation('widgets.allUnchanged'),
                      defaultMessage:
                        'No widget in this zone changed. {count} unchanged widgets are hidden.',
                    },
                    { count: hiddenCount }
                  )}
                </Typography>
              ) : (
                <Flex direction="column" alignItems="stretch" gap={3}>
                  {visible.map((slot) => (
                    <WidgetSlotView key={`${zone.name}-${slot.index}`} slot={slot} />
                  ))}
                </Flex>
              )}
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
};

export { WidgetDiff };
