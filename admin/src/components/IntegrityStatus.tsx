import { Badge, Box, Flex, Typography } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { useAuditIntegrity } from '../hooks/useAuditLogs';
import { formatDate } from '../utils/format';
import { getTranslation } from '../utils/getTranslation';

/**
 * The hash-chain verdict, shown above the list.
 *
 * An audit log that cannot say whether it has been tampered with is taking its
 * own word for it. This runs the full chain walk on every visit to the page —
 * deliberately, rather than on demand, so that the check is not something an
 * administrator has to remember to do — and states the result in one line.
 *
 * A broken chain is the one thing on this page that should look alarming, so it
 * is the only thing here rendered in red.
 */
const IntegrityStatus = () => {
  const { formatMessage, locale } = useIntl();
  const { data, isLoading, error } = useAuditIntegrity();

  if (isLoading) {
    return (
      <Typography variant="pi" textColor="neutral600">
        {formatMessage({
          id: getTranslation('integrity.checking'),
          defaultMessage: 'Verifying the audit chain…',
        })}
      </Typography>
    );
  }

  if (error || !data) {
    return (
      <Typography variant="pi" textColor="warning600">
        {formatMessage(
          {
            id: getTranslation('integrity.unavailable'),
            defaultMessage: 'Integrity check unavailable: {error}',
          },
          { error: error ?? 'no report' }
        )}
      </Typography>
    );
  }

  if (!data.ok) {
    return (
      <Box background="danger100" hasRadius padding={3} borderColor="danger200" borderWidth="1px" borderStyle="solid">
        <Flex alignItems="center" gap={2} wrap="wrap">
          <Badge backgroundColor="danger600" textColor="neutral0">
            {formatMessage({ id: getTranslation('integrity.broken'), defaultMessage: 'CHAIN BROKEN' })}
          </Badge>
          <Typography variant="pi" textColor="danger700" fontWeight="bold">
            {formatMessage(
              {
                id: getTranslation('integrity.brokenAt'),
                defaultMessage: 'Record #{id}: {reason}',
              },
              { id: data.brokenAt?.id ?? '?', reason: data.brokenAt?.reason ?? '' }
            )}
          </Typography>
        </Flex>
        <Box paddingTop={1}>
          <Typography variant="pi" textColor="danger700">
            {formatMessage({
              id: getTranslation('integrity.brokenHint'),
              defaultMessage:
                'A record was modified, removed or inserted after it was written. Treat everything from this point as unverified and compare against the forwarded copy.',
            })}
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Flex alignItems="center" gap={2} wrap="wrap">
      <Badge backgroundColor="success100" textColor="success700">
        {formatMessage({ id: getTranslation('integrity.ok'), defaultMessage: 'Chain verified' })}
      </Badge>
      <Typography variant="pi" textColor="neutral600">
        {formatMessage(
          {
            id: getTranslation('integrity.summary'),
            defaultMessage:
              '{hashed, plural, one {# linked record} other {# linked records}}{legacy, plural, =0 {} one { · # pre-chain record} other { · # pre-chain records}} · checked {when}',
          },
          { hashed: data.hashed, legacy: data.legacy, when: formatDate(data.verifiedAt, locale) }
        )}
      </Typography>
    </Flex>
  );
};

export { IntegrityStatus };
