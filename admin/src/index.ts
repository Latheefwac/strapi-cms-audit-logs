import { PluginIcon } from './components/PluginIcon';
import { PLUGIN_ID } from './pluginId';
import { PERMISSIONS } from './permissions';
import { getTranslation } from './utils/getTranslation';

import type { StrapiApp } from '@strapi/strapi/admin';

const plugin: StrapiApp['appPlugins'][string] = {
  register(app) {
    /**
     * The sidebar entry.
     *
     * `permissions` is what makes it RBAC-aware: the admin's left menu filters
     * items against the signed-in user's permissions before rendering, so a role
     * without `plugin::audit-log.read` never sees the link. The routes behind it
     * are guarded independently on the server, so hiding the link is a courtesy
     * rather than the security boundary.
     *
     * `to` is relative — an absolute path is deprecated in Strapi v5 and gets
     * rewritten with a console warning — which resolves to `/admin/audit-logs`.
     */
    app.addMenuLink({
      to: 'audit-logs',
      icon: PluginIcon,
      intlLabel: {
        id: `${PLUGIN_ID}.plugin.name`,
        defaultMessage: 'Audit Logs',
      },
      permissions: PERMISSIONS.read,
      Component: () => import('./pages/App').then((mod) => ({ default: mod.App })),
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      isReady: true,
    });
  },

  /**
   * Loads a translation bundle per admin locale, namespacing every key with the
   * plugin id so it cannot collide with the admin's own messages. A locale with
   * no bundle resolves to an empty object, and React Intl falls back to each
   * message's `defaultMessage`.
   */
  registerTrads({ locales }: { locales: string[] }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = (await import(`./translations/${locale}.json`)) as {
            default: Record<string, string>;
          };

          const namespaced: Record<string, string> = {};
          for (const key of Object.keys(data)) {
            namespaced[getTranslation(key)] = data[key] as string;
          }

          return { data: namespaced, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};

export default plugin;
