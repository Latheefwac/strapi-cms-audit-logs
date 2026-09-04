import * as React from 'react';

import { Badge, Box, Divider, Flex, Typography } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { formatValue, isStructured } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';
import type { AuditChangeSet } from '../types';

import { JsonViewer } from './JsonViewer';

interface ChangeViewerProps {
  changes: AuditChangeSet | null;
}

interface ChangeRowProps {
  path: string;
  from: unknown;
  to: unknown;
}

/**
 * One field's before/after.
 *
 * Stacked rather than side-by-side: values in a CMS are frequently long
 * paragraphs, and two narrow columns turn a one-line copy edit into two
 * unreadable ribbons of wrapped text.
 */
const ChangeRow = ({ path, from, to }: ChangeRowProps) => {
  const { formatMessage } = useIntl();
  const structured = isStructured(from) || isStructured(to);

  return (
    <Box paddingTop={4} paddingBottom={4}>
      <Typography variant="sigma" textColor="neutral600">
        {path}
      </Typography>

      <Box paddingTop={2}>
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Box background="danger100" hasRadius padding={3}>
            <Typography variant="pi" fontWeight="bold" textColor="danger600">
              {formatMessage({ id: getTranslation('changes.before'), defaultMessage: 'Before' })}
            </Typography>
            <Box paddingTop={1}>
              <Typography tag="p" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {formatValue(from)}
              </Typography>
            </Box>
          </Box>

          <Box background="success100" hasRadius padding={3}>
            <Typography variant="pi" fontWeight="bold" textColor="success600">
              {formatMessage({ id: getTranslation('changes.after'), defaultMessage: 'After' })}
            </Typography>
            <Box paddingTop={1}>
              <Typography tag="p" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {formatValue(to)}
              </Typography>
            </Box>
          </Box>
        </Flex>
      </Box>

      {/* Structured values are truncated above, so offer the full payload. */}
      {structured ? (
        <Box paddingTop={3}>
          <JsonViewer
            label={formatMessage(
              { id: getTranslation('changes.raw'), defaultMessage: 'Raw value for {path}' },
              { path }
            )}
            value={{ from, to }}
          />
        </Box>
      ) : null}
    </Box>
  );
};

/**
 * Renders the field-level diff of an audit record.
 *
 * Paths arrive already flattened by the server's diff engine
 * (`seo.metaTitle`, `blocks[2].heading`), so nesting is conveyed by the path
 * itself and the list stays flat and scannable however deep the change was.
 */
const ChangeViewer = ({ changes }: ChangeViewerProps) => {
  const { formatMessage } = useIntl();

  const entries = React.useMemo(
    () =>
      Object.entries(changes ?? {})
        // Sort so shallow, top-level fields come first: a title change should not
        // be buried under twenty dynamic-zone paths.
        .sort(([a], [b]) => a.split('.').length - b.split('.').length || a.localeCompare(b)),
    [changes]
  );

  if (entries.length === 0) {
    return (
      <Typography textColor="neutral600">
        {formatMessage({
          id: getTranslation('changes.empty'),
          defaultMessage:
            'No field-level changes were recorded for this operation. This is expected for creates and deletes, and for updates that re-saved a document without modifying it.',
        })}
      </Typography>
    );
  }

  return (
    <Box>
      <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
        <Typography variant="delta" tag="h2">
          {formatMessage({ id: getTranslation('changes.title'), defaultMessage: 'Changes' })}
        </Typography>
        <Badge>{entries.length}</Badge>
      </Flex>

      {entries.map(([path, change], index) => (
        <React.Fragment key={path}>
          {index > 0 ? <Divider /> : null}
          <ChangeRow path={path} from={change?.from} to={change?.to} />
        </React.Fragment>
      ))}
    </Box>
  );
};

export { ChangeViewer };
