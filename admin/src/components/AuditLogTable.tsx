import * as React from 'react';

import {
  Badge,
  Box,
  EmptyStateLayout,
  Flex,
  IconButton,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { CaretDown, CaretUp, Eye } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { actionColor, formatDate, formatUser, shortContentTypeName } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';
import type { AuditLog } from '../types';

interface AuditLogTableProps {
  logs: AuditLog[];
  sort: string;
  onSortChange: (sort: string) => void;
  onView: (log: AuditLog) => void;
  isLoading: boolean;
}

/** Columns, and whether the server will sort by them. */
const COLUMNS = [
  { key: 'createdAt', label: 'Date', sortable: true },
  { key: 'userName', label: 'User', sortable: true },
  { key: 'action', label: 'Action', sortable: true },
  { key: 'contentType', label: 'Content type', sortable: true },
  { key: 'contentDocumentId', label: 'Document ID', sortable: false },
  { key: 'locale', label: 'Locale', sortable: true },
  { key: 'source', label: 'Source', sortable: true },
  { key: 'outcome', label: 'Outcome', sortable: true },
] as const;

const SortIndicator = ({ direction }: { direction: 'asc' | 'desc' | null }) => {
  if (!direction) return null;
  return direction === 'asc' ? <CaretUp /> : <CaretDown />;
};

/**
 * The audit list.
 *
 * Sorting is a link back to the parent's query state rather than an in-memory
 * `Array.sort`: the table only ever holds one page, so sorting it locally would
 * reorder twenty rows and quietly lie about the other ten thousand.
 */
const AuditLogTable = ({
  logs,
  sort,
  onSortChange,
  onView,
  isLoading,
}: AuditLogTableProps) => {
  const { formatMessage, locale } = useIntl();

  const [sortField, sortDirection] = React.useMemo(() => {
    const [field, direction] = (sort || 'createdAt:desc').split(':');
    return [field, direction === 'asc' ? 'asc' : 'desc'] as const;
  }, [sort]);

  const toggleSort = (key: string) => {
    // Same column flips the direction; a new column starts descending, because
    // "most recent first" is what someone opening an audit log wants.
    const direction = sortField === key && sortDirection === 'desc' ? 'asc' : 'desc';
    onSortChange(`${key}:${direction}`);
  };

  if (!isLoading && logs.length === 0) {
    return (
      <Box background="neutral0" hasRadius shadow="tableShadow" padding={8}>
        <EmptyStateLayout
          content={formatMessage({
            id: getTranslation('list.empty'),
            defaultMessage:
              'No audit logs match these filters. Records appear here as soon as content is created, updated, deleted, published or unpublished.',
          })}
        />
      </Box>
    );
  }

  return (
    <Table colCount={COLUMNS.length + 1} rowCount={logs.length + 1}>
      <Thead>
        <Tr>
          {COLUMNS.map(({ key, label, sortable }) => (
            <Th
              key={key}
              action={
                sortable ? <SortIndicator direction={sortField === key ? sortDirection : null} /> : undefined
              }
            >
              {sortable ? (
                <Typography
                  variant="sigma"
                  tag="button"
                  onClick={() => toggleSort(key)}
                  style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
                >
                  {formatMessage({ id: getTranslation(`list.column.${key}`), defaultMessage: label })}
                </Typography>
              ) : (
                <Typography variant="sigma">
                  {formatMessage({ id: getTranslation(`list.column.${key}`), defaultMessage: label })}
                </Typography>
              )}
            </Th>
          ))}
          <Th>
            <VisuallyHidden>
              {formatMessage({ id: getTranslation('list.column.actions'), defaultMessage: 'Actions' })}
            </VisuallyHidden>
          </Th>
        </Tr>
      </Thead>

      <Tbody>
        {logs.map((log) => {
          const colors = actionColor(log.action);

          return (
            <Tr key={log.id} onClick={() => onView(log)} style={{ cursor: 'pointer' }}>
              <Td>
                <Typography textColor="neutral800">{formatDate(log.createdAt, locale)}</Typography>
              </Td>
              <Td>
                <Typography textColor="neutral800">{formatUser(log)}</Typography>
              </Td>
              <Td>
                <Badge backgroundColor={colors.background} textColor={colors.text}>
                  {log.action}
                </Badge>
              </Td>
              <Td>
                <Typography textColor="neutral800" title={log.contentType}>
                  {log.contentTypeDisplayName || shortContentTypeName(log.contentType)}
                </Typography>
              </Td>
              <Td>
                <Typography variant="pi" textColor="neutral600">
                  {log.contentDocumentId ?? '-'}
                </Typography>
              </Td>
              <Td>
                <Typography textColor="neutral800">{log.locale ?? '-'}</Typography>
              </Td>
              <Td>
                <Typography textColor="neutral600">{log.source}</Typography>
              </Td>
              <Td>
                {/* A failure is the row a reviewer is scanning for, so it gets a
                    badge; a success is the norm and stays quiet neutral text. */}
                {log.outcome === 'failure' ? (
                  <Badge backgroundColor="danger100" textColor="danger600">
                    {log.outcome}
                  </Badge>
                ) : (
                  <Typography textColor="neutral600">{log.outcome ?? 'success'}</Typography>
                )}
              </Td>
              <Td>
                {/* Row-level buttons live inside a click-through row, so each one
                    has to stop the event reaching the row's navigation handler. */}
                <Flex gap={1} justifyContent="flex-end" onClick={(event) => event.stopPropagation()}>
                  <IconButton
                    label={formatMessage({
                      id: getTranslation('list.view'),
                      defaultMessage: 'View details',
                    })}
                    variant="ghost"
                    onClick={() => onView(log)}
                  >
                    <Eye />
                  </IconButton>
                </Flex>
              </Td>
            </Tr>
          );
        })}
      </Tbody>
    </Table>
  );
};

export { AuditLogTable };
