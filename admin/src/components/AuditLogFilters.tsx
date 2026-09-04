import * as React from 'react';

import {
  Box,
  Button,
  Combobox,
  ComboboxOption,
  DatePicker,
  Field,
  Flex,
  Grid,
  SingleSelect,
  SingleSelectOption,
  TextInput,
} from '@strapi/design-system';
import { Cross } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { shortContentTypeName } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';
import type { AuditFilterOptions, AuditListQuery } from '../types';

interface AuditLogFiltersProps {
  options: AuditFilterOptions;
  query: AuditListQuery;
  onChange: (patch: Partial<AuditListQuery>) => void;
  onClear: () => void;
}

const ALL = '__all__';

/** Query-string keys this component owns, for the "clear" action. */
const FILTER_KEYS: Array<keyof AuditListQuery> = [
  'action',
  'contentType',
  'userId',
  'locale',
  'source',
  'outcome',
  'contentDocumentId',
  'dateFrom',
  'dateTo',
];

const toDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Filter bar for the audit list.
 *
 * Every control writes to the URL rather than to local state, which is what
 * makes a filtered view shareable — pasting the link into a ticket reproduces
 * exactly what the reporter was looking at. The parent turns that query string
 * straight into the server request; nothing is filtered in the browser.
 */
const AuditLogFilters = ({ options, query, onChange, onClear }: AuditLogFiltersProps) => {
  const { formatMessage } = useIntl();

  const hasActiveFilter = FILTER_KEYS.some((key) => Boolean(query[key]));

  /** `SingleSelect` has no "unset" value, so an explicit sentinel stands in for it. */
  const select = (key: keyof AuditListQuery) => (value: string | number) =>
    onChange({ [key]: value === ALL ? undefined : String(value) } as Partial<AuditListQuery>);

  /**
   * `Combobox` clears to `undefined` and reports "nothing selected" as an empty
   * string. Both mean the same thing here: drop the filter.
   */
  const combo = (key: keyof AuditListQuery) => (value?: string | null) =>
    onChange({ [key]: value ? String(value) : undefined } as Partial<AuditListQuery>);

  const dateChange = (key: 'dateFrom' | 'dateTo') => (date: Date | undefined) => {
    if (!date) {
      onChange({ [key]: undefined } as Partial<AuditListQuery>);
      return;
    }

    // `dateFrom` opens the day, `dateTo` closes it — otherwise picking the same
    // day for both selects an empty range and the user sees no results at all.
    const bounded = new Date(date);
    if (key === 'dateFrom') bounded.setHours(0, 0, 0, 0);
    else bounded.setHours(23, 59, 59, 999);

    onChange({ [key]: bounded.toISOString() } as Partial<AuditListQuery>);
  };

  return (
    <Box background="neutral0" hasRadius shadow="tableShadow" padding={4} marginBottom={4}>
      <Grid.Root gap={4}>
        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="action">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.action'), defaultMessage: 'Action' })}
            </Field.Label>
            <SingleSelect value={query.action ?? ALL} onChange={select('action')}>
              <SingleSelectOption value={ALL}>
                {formatMessage({ id: getTranslation('filters.all'), defaultMessage: 'All' })}
              </SingleSelectOption>
              {options.actions.map((action) => (
                <SingleSelectOption key={action} value={action}>
                  {action}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="contentType">
            <Field.Label>
              {formatMessage({
                id: getTranslation('filters.contentType'),
                defaultMessage: 'Content type',
              })}
            </Field.Label>
            {/*
              A Combobox rather than a SingleSelect: the list is every content
              type this project audits, which on a widget-driven site runs to
              fifty or more. A plain select means scrolling for "Webinar"; typing
              three letters does not.
            */}
            <Combobox
              value={query.contentType ?? ''}
              onChange={combo('contentType')}
              onClear={() => onChange({ contentType: undefined })}
              placeholder={formatMessage({
                id: getTranslation('filters.all'),
                defaultMessage: 'All',
              })}
            >
              {options.contentTypes.map(({ uid, displayName }) => (
                <ComboboxOption key={uid} value={uid}>
                  {displayName || shortContentTypeName(uid)}
                </ComboboxOption>
              ))}
            </Combobox>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="userId">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.user'), defaultMessage: 'User' })}
            </Field.Label>
            <Combobox
              value={query.userId ?? ''}
              onChange={combo('userId')}
              onClear={() => onChange({ userId: undefined })}
              placeholder={formatMessage({
                id: getTranslation('filters.all'),
                defaultMessage: 'All',
              })}
            >
              {options.users.map(({ userId, label }) => (
                <ComboboxOption key={userId} value={userId}>
                  {label}
                </ComboboxOption>
              ))}
            </Combobox>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="locale">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.locale'), defaultMessage: 'Locale' })}
            </Field.Label>
            <SingleSelect value={query.locale ?? ALL} onChange={select('locale')}>
              <SingleSelectOption value={ALL}>
                {formatMessage({ id: getTranslation('filters.all'), defaultMessage: 'All' })}
              </SingleSelectOption>
              {options.locales.map((locale) => (
                <SingleSelectOption key={locale} value={locale}>
                  {locale}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="source">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.source'), defaultMessage: 'Source' })}
            </Field.Label>
            <SingleSelect value={query.source ?? ALL} onChange={select('source')}>
              <SingleSelectOption value={ALL}>
                {formatMessage({ id: getTranslation('filters.all'), defaultMessage: 'All' })}
              </SingleSelectOption>
              {options.sources.map((source) => (
                <SingleSelectOption key={source} value={source}>
                  {source}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="outcome">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.outcome'), defaultMessage: 'Outcome' })}
            </Field.Label>
            <SingleSelect value={query.outcome ?? ALL} onChange={select('outcome')}>
              <SingleSelectOption value={ALL}>
                {formatMessage({ id: getTranslation('filters.all'), defaultMessage: 'All' })}
              </SingleSelectOption>
              {options.outcomes.map((outcome) => (
                <SingleSelectOption key={outcome} value={outcome}>
                  {outcome}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="contentDocumentId">
            <Field.Label>
              {formatMessage({
                id: getTranslation('filters.documentId'),
                defaultMessage: 'Document ID',
              })}
            </Field.Label>
            <TextInput
              placeholder={formatMessage({
                id: getTranslation('filters.documentIdPlaceholder'),
                defaultMessage: 'Exact document id',
              })}
              value={query.contentDocumentId ?? ''}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ contentDocumentId: event.target.value || undefined })
              }
            />
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="dateFrom">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.dateFrom'), defaultMessage: 'From' })}
            </Field.Label>
            <DatePicker
              value={toDate(query.dateFrom)}
              onChange={dateChange('dateFrom')}
              onClear={() => onChange({ dateFrom: undefined })}
              clearLabel={formatMessage({
                id: getTranslation('filters.clearDate'),
                defaultMessage: 'Clear date',
              })}
            />
          </Field.Root>
        </Grid.Item>

        <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
          <Field.Root name="dateTo">
            <Field.Label>
              {formatMessage({ id: getTranslation('filters.dateTo'), defaultMessage: 'To' })}
            </Field.Label>
            <DatePicker
              value={toDate(query.dateTo)}
              onChange={dateChange('dateTo')}
              onClear={() => onChange({ dateTo: undefined })}
              clearLabel={formatMessage({
                id: getTranslation('filters.clearDate'),
                defaultMessage: 'Clear date',
              })}
            />
          </Field.Root>
        </Grid.Item>
      </Grid.Root>

      {hasActiveFilter ? (
        <Flex paddingTop={4} justifyContent="flex-end">
          <Button variant="tertiary" startIcon={<Cross />} onClick={onClear}>
            {formatMessage({
              id: getTranslation('filters.clear'),
              defaultMessage: 'Clear all filters',
            })}
          </Button>
        </Flex>
      ) : null}
    </Box>
  );
};

export { AuditLogFilters };
