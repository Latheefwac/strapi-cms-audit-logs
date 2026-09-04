import { Badge, Box, Divider, Flex, Grid, Typography } from '@strapi/design-system';
import { BackButton, Layouts, Page } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import { useParams } from 'react-router-dom';

import { ChangeViewer } from '../components/ChangeViewer';
import { JsonViewer } from '../components/JsonViewer';
import { WidgetDiff } from '../components/WidgetDiff';
import { useAuditLog } from '../hooks/useAuditLogs';
import { actionColor, formatDate, formatUser, shortContentTypeName } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';

interface MetaFieldProps {
  label: string;
  value: React.ReactNode;
  /** Long opaque values (ids, user agents) read better in a monospaced face. */
  mono?: boolean;
}

const MetaField = ({ label, value, mono = false }: MetaFieldProps) => (
  <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="sigma" textColor="neutral600">
      {label}
    </Typography>
    <Typography
      textColor="neutral800"
      style={{
        wordBreak: 'break-word',
        ...(mono
          ? {
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            }
          : {}),
      }}
    >
      {value ?? '-'}
    </Typography>
  </Grid.Item>
);

/**
 * A single audit record in full.
 *
 * Laid out as metadata first, then the diff, then the raw snapshots. That order
 * matches how the page is actually read: "who and when" answers most questions
 * outright, the diff answers most of the rest, and the raw JSON is there for the
 * cases where neither does.
 */
const AuditLogDetails = () => {
  const { formatMessage, locale } = useIntl();
  const { id } = useParams<{ id: string }>();

  const { data: log, isLoading, error } = useAuditLog(id);

  if (isLoading) return <Page.Loading />;

  if (error || !log) {
    return <Page.Error content={error ?? undefined} />;
  }

  const colors = actionColor(log.action);

  return (
    <Page.Main>
      <Page.Title>
        {formatMessage({ id: getTranslation('detail.title'), defaultMessage: 'Audit Log' })}
      </Page.Title>

      <Layouts.Header
        navigationAction={<BackButton fallback=".." />}
        title={`${log.action} · ${log.contentTypeDisplayName || shortContentTypeName(log.contentType)}`}
        subtitle={formatDate(log.createdAt, locale)}
      />

      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
            <Typography variant="delta" tag="h2">
              {formatMessage({ id: getTranslation('detail.overview'), defaultMessage: 'Overview' })}
            </Typography>

            <Box paddingTop={4}>
              <Grid.Root gap={5}>
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.action'),
                    defaultMessage: 'Action',
                  })}
                  value={
                    <Badge backgroundColor={colors.background} textColor={colors.text}>
                      {log.action}
                    </Badge>
                  }
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.outcome'),
                    defaultMessage: 'Outcome',
                  })}
                  value={
                    <Badge
                      backgroundColor={log.outcome === 'failure' ? 'danger100' : 'success100'}
                      textColor={log.outcome === 'failure' ? 'danger600' : 'success600'}
                    >
                      {log.outcome ?? 'success'}
                    </Badge>
                  }
                />
                <MetaField
                  label={formatMessage({ id: getTranslation('detail.user'), defaultMessage: 'User' })}
                  value={formatUser(log)}
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.userEmail'),
                    defaultMessage: 'User email',
                  })}
                  value={log.userEmail}
                />
                <MetaField
                  label={formatMessage({ id: getTranslation('detail.date'), defaultMessage: 'Date' })}
                  value={formatDate(log.createdAt, locale)}
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.contentType'),
                    defaultMessage: 'Content type',
                  })}
                  value={log.contentType}
                  mono
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.documentId'),
                    defaultMessage: 'Document ID',
                  })}
                  value={log.contentDocumentId}
                  mono
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.entryId'),
                    defaultMessage: 'Entry ID',
                  })}
                  value={log.contentId}
                  mono
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.locale'),
                    defaultMessage: 'Locale',
                  })}
                  value={log.locale}
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.source'),
                    defaultMessage: 'Source',
                  })}
                  value={log.source}
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.ipAddress'),
                    defaultMessage: 'IP address',
                  })}
                  value={log.ipAddress}
                  mono
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.requestId'),
                    defaultMessage: 'Request ID',
                  })}
                  value={log.requestId}
                  mono
                />
                <MetaField
                  label={formatMessage({
                    id: getTranslation('detail.userAgent'),
                    defaultMessage: 'User agent',
                  })}
                  value={log.userAgent}
                  mono
                />
              </Grid.Root>
            </Box>
          </Box>

          {/* Only rendered for the actions that carry it — a login has no
              document, and an empty card on every one of them is noise. */}
          {log.metadata && Object.keys(log.metadata).length > 0 ? (
            <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
              <Typography variant="delta" tag="h2">
                {formatMessage({
                  id: getTranslation('detail.metadata'),
                  defaultMessage: 'Event detail',
                })}
              </Typography>
              <Box paddingTop={4}>
                <Grid.Root gap={5}>
                  {Object.entries(log.metadata).map(([key, value]) => (
                    <MetaField
                      key={key}
                      label={key}
                      value={
                        value === null || value === undefined
                          ? '-'
                          : typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)
                      }
                      mono={key === 'path' || key === 'attemptedEmail'}
                    />
                  ))}
                </Grid.Root>
              </Box>
            </Box>
          ) : null}

          {/*
            The per-widget view comes BEFORE the flat change list on purpose.
            For a widget-driven page it is the section that answers the question
            the reader arrived with; the dotted-path list below it is the precise
            fallback, not the headline. `WidgetDiff` renders nothing at all when
            neither snapshot holds a dynamic zone, so content types without one
            are unaffected.
          */}
          <WidgetDiff before={log.before} after={log.after} />

          <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
            <ChangeViewer changes={log.changes} />
          </Box>

          <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
            <Typography variant="delta" tag="h2">
              {formatMessage({
                id: getTranslation('detail.snapshots'),
                defaultMessage: 'Raw snapshots',
              })}
            </Typography>
            <Box paddingTop={2} paddingBottom={4}>
              <Typography variant="pi" textColor="neutral600">
                {formatMessage({
                  id: getTranslation('detail.snapshotsHint'),
                  defaultMessage:
                    'The document state either side of this operation, with configured sensitive fields removed. A missing snapshot means the state did not exist (a create has no before, a delete has no after) or storage for it is disabled in the plugin configuration.',
                })}
              </Typography>
            </Box>

            <Flex direction="column" alignItems="stretch" gap={4}>
              <JsonViewer
                label={formatMessage({
                  id: getTranslation('detail.before'),
                  defaultMessage: 'Before',
                })}
                value={log.before}
              />
              <Divider />
              <JsonViewer
                label={formatMessage({ id: getTranslation('detail.after'), defaultMessage: 'After' })}
                value={log.after}
              />
            </Flex>
          </Box>
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
};

export { AuditLogDetails };
