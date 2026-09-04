import * as React from 'react';

import { useFetchClient } from '@strapi/strapi/admin';

import { PLUGIN_ID } from '../pluginId';
import type {
  AuditFilterOptions,
  AuditLog,
  AuditLogListResponse,
  AuditPagination,
} from '../types';

const EMPTY_PAGINATION: AuditPagination = { page: 1, pageSize: 20, pageCount: 0, total: 0 };

const EMPTY_FILTERS: AuditFilterOptions = {
  contentTypes: [],
  users: [],
  locales: [],
  actions: [],
  sources: [],
  outcomes: [],
};

const message = (error: unknown): string =>
  (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
    ?.message ??
  (error as Error)?.message ??
  'Something went wrong while loading audit logs.';

/**
 * Fetches one page of audit logs.
 *
 * The whole query — filters, search, sort, pagination — is forwarded to the
 * server and applied in SQL. Nothing is filtered in the browser, because the
 * audit table is the one table in a Strapi project that grows without bound;
 * fetching it to filter it client-side would work fine in development and fall
 * over the first time it matters.
 */
export const useAuditLogs = (search: string) => {
  const { get } = useFetchClient();

  const [data, setData] = React.useState<AuditLog[]>([]);
  const [pagination, setPagination] = React.useState<AuditPagination>(EMPTY_PAGINATION);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  React.useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const { data: response } = await get<AuditLogListResponse>(
          `/${PLUGIN_ID}/logs${search ? `?${search}` : ''}`
        );

        if (cancelled) return;
        setData(response.results ?? []);
        setPagination(response.pagination ?? EMPTY_PAGINATION);
      } catch (err) {
        // `useFetchClient` aborts in-flight requests when the component
        // unmounts; that rejection is not a failure worth showing anyone.
        if (cancelled) return;
        setError(message(err));
        setData([]);
        setPagination(EMPTY_PAGINATION);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [get, search, refreshToken]);

  return { data, pagination, isLoading, error, refresh };
};

/**
 * Loads the distinct values behind the filter dropdowns.
 *
 * Fetched once per mount rather than derived from the current page: a filter
 * list built from twenty visible rows would offer only the options the user can
 * already see.
 */
export const useAuditFilterOptions = () => {
  const { get } = useFetchClient();

  const [options, setOptions] = React.useState<AuditFilterOptions>(EMPTY_FILTERS);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { data } = await get<{ data: AuditFilterOptions }>(`/${PLUGIN_ID}/filters`);
        if (!cancelled) setOptions(data.data ?? EMPTY_FILTERS);
      } catch {
        // Filters are a convenience. If they fail to load the list still works,
        // so degrade to empty dropdowns rather than failing the whole page.
        if (!cancelled) setOptions(EMPTY_FILTERS);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [get]);

  return { options, isLoading };
};

/** Loads one audit record for the detail page. */
export const useAuditLog = (id: string | undefined) => {
  const { get } = useFetchClient();

  const [data, setData] = React.useState<AuditLog | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    if (!id) {
      setError('Missing audit log id.');
      setIsLoading(false);
      return;
    }

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const { data: response } = await get<{ data: AuditLog }>(`/${PLUGIN_ID}/logs/${id}`);
        if (!cancelled) setData(response.data);
      } catch (err) {
        if (!cancelled) {
          setError(message(err));
          setData(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [get, id]);

  return { data, isLoading, error };
};

/** Deletes one record. Requires `plugin::audit-log.delete` on the server. */
export const useDeleteAuditLog = () => {
  const { del } = useFetchClient();

  return React.useCallback(
    async (id: number): Promise<void> => {
      await del(`/${PLUGIN_ID}/logs/${id}`);
    },
    [del]
  );
};
