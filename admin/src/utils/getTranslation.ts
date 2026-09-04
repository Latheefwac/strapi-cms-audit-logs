import { PLUGIN_ID } from '../pluginId';

/** Namespaces a translation key, so plugin keys cannot collide with the admin's. */
export const getTranslation = (id: string): string => `${PLUGIN_ID}.${id}`;
