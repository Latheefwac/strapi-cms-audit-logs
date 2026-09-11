import * as React from 'react';

import { Box, Flex, Typography } from '@strapi/design-system';
import { Layouts, Page, Pagination, SearchInput, useQueryParams } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import { useNavigate } from 'react-router-dom';

import { AuditLogFilters } from '../components/AuditLogFilters';
import { AuditLogTable } from '../components/AuditLogTable';
import { IntegrityStatus } from '../components/IntegrityStatus';
import { useAuditFilterOptions, useAuditLogs } from '../hooks/useAuditLogs';
import { getTranslation } from '../utils/getTranslation';
import type { AuditListQuery } from '../types';

/**
 * Turns the page's query state into the server request.
 *
 * Empty values are dropped rather than sent as blanks, so the URL stays legible
 * and the server never has to decide what `action=` (with no value) means.
 */
const toSearchParams = (query: AuditListQuery): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  return params.toString();
};

const AuditLogs = () => {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();

  const [{ query }, setQuery] = useQueryParams<AuditListQuery>({ page: 1, pageSize: 20 });

  const search = React.useMemo(() => toSearchParams(query), [query]);
  const { data, pagination, isLoading, error } = useAuditLogs(search);
  const { options } = useAuditFilterOptions();

  /**
   * Any filter change resets to page 1.
   *
   * Without this, narrowing a filter while on page 7 of 9 lands on a page that
   * no longer exists and the table appears empty.
   */
  const updateQuery = React.useCallback(
    (patch: Partial<AuditListQuery>) => {
      setQuery({ ...patch, page: 1 } as AuditListQuery);
    },
    [setQuery]
  );

  const clearFilters = React.useCallback(() => {
    setQuery(
      {
        action: undefined,
        contentType: undefined,
        userId: undefined,
        locale: undefined,
        source: undefined,
        outcome: undefined,
        contentDocumentId: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        page: 1,
      } as AuditListQuery,
      'remove'
    );
  }, [setQuery]);

  return (
    <Page.Main>
      <Page.Title>
        {formatMessage({ id: getTranslation('plugin.name'), defaultMessage: 'Audit Logs' })}
      </Page.Title>

      <Layouts.Header
        title={formatMessage({ id: getTranslation('plugin.name'), defaultMessage: 'Audit Logs' })}
        subtitle={formatMessage(
          {
            id: getTranslation('list.subtitle'),
            defaultMessage:
              '{total, plural, =0 {No records} one {# record} other {# records}} of content changes',
          },
          { total: pagination.total }
        )}
      />

      <Layouts.Action
        startActions={
          <SearchInput
            label={formatMessage({
              id: getTranslation('list.search'),
              defaultMessage: 'Search by document id, user, content type or request id',
            })}
          />
        }
      />

      <Layouts.Content>
        <Box paddingBottom={4}>
          <IntegrityStatus />
        </Box>

        <AuditLogFilters
          options={options}
          query={query}
          onChange={updateQuery}
          onClear={clearFilters}
        />

        {error ? (
          <Box background="danger100" padding={4} hasRadius marginBottom={4}>
            <Typography textColor="danger600">{error}</Typography>
          </Box>
        ) : null}

        {isLoading ? (
          <Page.Loading />
        ) : (
          <AuditLogTable
            logs={data}
            isLoading={isLoading}
            sort={String(query.sort ?? 'createdAt:desc')}
            onSortChange={(sort) => setQuery({ sort, page: 1 } as AuditListQuery)}
            onView={(log) => navigate(`${log.id}`)}
          />
        )}

        <Box paddingTop={4}>
          <Pagination.Root
            pageCount={pagination.pageCount}
            total={pagination.total}
            defaultPageSize={pagination.pageSize}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Pagination.PageSize options={['10', '20', '50', '100']} />
              <Pagination.Links />
            </Flex>
          </Pagination.Root>
        </Box>
      </Layouts.Content>
    </Page.Main>
  );
};

export { AuditLogs };
