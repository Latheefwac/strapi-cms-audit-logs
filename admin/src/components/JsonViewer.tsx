import * as React from 'react';

import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { CaretDown, CaretUp } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { getTranslation } from '../utils/getTranslation';

interface JsonViewerProps {
  value: unknown;
  /** Rendered above the block; also the label of the expand/collapse control. */
  label: string;
  /** Start expanded. Small payloads read better open. */
  defaultOpen?: boolean;
  /** Lines shown before the block scrolls internally. */
  maxHeight?: string;
}

const stringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A snapshot came out of the database, so a cycle is not expected — but a
    // viewer that throws is worse than one that says it could not render.
    return '/* value could not be serialised */';
  }
};

/**
 * Collapsible, monospaced JSON block.
 *
 * Collapsed by default because a `before`/`after` snapshot of a page with a
 * dynamic zone is thousands of lines, and a detail page that opens with a wall
 * of JSON buries the thing the reader came for — the diff. The raw payload is
 * still one click away, which matters when the diff summary is not enough.
 */
const JsonViewer = ({ value, label, defaultOpen = false, maxHeight = '420px' }: JsonViewerProps) => {
  const { formatMessage } = useIntl();
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  const json = React.useMemo(() => stringify(value), [value]);
  const lineCount = React.useMemo(() => json.split('\n').length, [json]);

  return (
    <Box>
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="delta" tag="h3">
          {label}
        </Typography>
        <Button
          variant="tertiary"
          size="S"
          startIcon={isOpen ? <CaretUp /> : <CaretDown />}
          onClick={() => setIsOpen((open) => !open)}
        >
          {isOpen
            ? formatMessage({ id: getTranslation('json.hide'), defaultMessage: 'Hide' })
            : formatMessage(
                { id: getTranslation('json.show'), defaultMessage: 'Show ({count} lines)' },
                { count: lineCount }
              )}
        </Button>
      </Flex>

      {isOpen ? (
        <Box
          background="neutral100"
          hasRadius
          padding={4}
          style={{ maxHeight, overflow: 'auto' }}
          borderColor="neutral200"
        >
          <Typography
            tag="pre"
            variant="pi"
            style={{
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
              whiteSpace: 'pre',
              margin: 0,
            }}
          >
            {json}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
};

export { JsonViewer };
