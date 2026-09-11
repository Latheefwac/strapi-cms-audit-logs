import bootstrap from './bootstrap';
import config from './config';
import contentTypes from './content-types';
import controllers from './controllers';
import destroy from './destroy';
import register from './register';
import routes from './routes';
import services from './services';

/**
 * Server half of the plugin, loaded by Strapi through the `./strapi-server`
 * export in package.json.
 */
export default {
  register,
  bootstrap,
  destroy,
  config,
  contentTypes,
  controllers,
  routes,
  services,
};

/** Public type surface — see `server/src/types`. */
export type {
  AuditAction,
  AuditActor,
  AuditAnyAction,
  AuditChange,
  AuditChangeSet,
  AuditConfig,
  AuditContext,
  AuditEntryInput,
  AuditFilterOptions,
  AuditLog,
  AuditLogListResult,
  AuditLogQuery,
  AuditLogLevel,
  AuditMaintenanceAction,
  IntegrityReport,
  AuditMetadata,
  AuditOutcome,
  AuditRequestContext,
  AuditSecurityAction,
  AuditSource,
  AuditUserConfig,
  AuditWriteMode,
  ContentTypeSelector,
  SecurityEventSelector,
} from './types';

export {
  PLUGIN_ID,
  AUDIT_LOG_UID,
  PERMISSIONS,
  DEFAULT_IGNORED_FIELDS,
  CONTENT_ACTIONS,
  ALL_SECURITY_ACTIONS,
  ALL_MAINTENANCE_ACTIONS,
  SECURITY_EVENT_MAP,
  SUBJECTS,
} from './constants';
