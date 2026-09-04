/**
 * Content-type fixtures.
 *
 * `api::page.page` is deliberately built to look like the pathological case the
 * plugin is designed for: a localized, draft-and-publish content type whose
 * dynamic zone declares a very large number of possible widgets while any given
 * page uses a handful.
 */

import type { Schema } from './strapi';

/** Number of widget components the page's dynamic zone *could* hold. */
export const WIDGET_COUNT = 173;

export const WIDGET_UIDS = Array.from({ length: WIDGET_COUNT }, (_, index) => `widgets.w${index}`);

/** One component schema per declared widget, so a schema-walking populate would find all of them. */
export const widgetSchemas: Record<string, Schema> = Object.fromEntries(
  WIDGET_UIDS.map((uid) => [
    uid,
    {
      uid,
      modelType: 'component',
      info: { displayName: uid },
      attributes: {
        heading: { type: 'string' },
        image: { type: 'media', multiple: false },
        link: { type: 'relation', relation: 'oneToOne', target: 'api::page.page' },
      },
    },
  ])
);

export const seoComponent: Schema = {
  uid: 'shared.seo',
  modelType: 'component',
  info: { displayName: 'SEO' },
  attributes: {
    metaTitle: { type: 'string' },
    metaDescription: { type: 'text' },
    internalToken: { type: 'string' },
  },
};

export const pageSchema: Schema = {
  uid: 'api::page.page',
  modelType: 'contentType',
  kind: 'collectionType',
  collectionName: 'pages',
  info: { singularName: 'page', pluralName: 'pages', displayName: 'Page' },
  options: { draftAndPublish: true },
  pluginOptions: { i18n: { localized: true } },
  attributes: {
    title: { type: 'string' },
    slug: { type: 'uid' },
    body: { type: 'richtext' },
    seo: { type: 'component', component: 'shared.seo', repeatable: false },
    cover: { type: 'media', multiple: false },
    gallery: { type: 'media', multiple: true },
    author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
    blocks: { type: 'dynamiczone', components: WIDGET_UIDS },
  },
};

export const authorSchema: Schema = {
  uid: 'api::author.author',
  modelType: 'contentType',
  kind: 'collectionType',
  collectionName: 'authors',
  info: { singularName: 'author', pluralName: 'authors', displayName: 'Author' },
  options: { draftAndPublish: false },
  attributes: {
    name: { type: 'string' },
    email: { type: 'email' },
    password: { type: 'password' },
    apiKey: { type: 'string' },
  },
};

export const internalLogSchema: Schema = {
  uid: 'api::internal-log.internal-log',
  modelType: 'contentType',
  kind: 'collectionType',
  collectionName: 'internal_logs',
  info: { singularName: 'internal-log', pluralName: 'internal-logs', displayName: 'Internal Log' },
  options: { draftAndPublish: false },
  attributes: { message: { type: 'text' } },
};

/** The plugin's own collection type, so the harness can store audit rows. */
export const auditLogSchema: Schema = {
  uid: 'plugin::audit-log.audit-log',
  modelType: 'contentType',
  kind: 'collectionType',
  collectionName: 'audit_logs',
  info: { singularName: 'audit-log', pluralName: 'audit-logs', displayName: 'Audit Log' },
  options: { draftAndPublish: false },
  attributes: {
    action: { type: 'string' },
    contentType: { type: 'string' },
    contentTypeDisplayName: { type: 'string' },
    contentDocumentId: { type: 'string' },
    contentId: { type: 'string' },
    locale: { type: 'string' },
    userId: { type: 'string' },
    userEmail: { type: 'string' },
    userName: { type: 'string' },
    changes: { type: 'json' },
    before: { type: 'json' },
    after: { type: 'json' },
    outcome: { type: 'string' },
    metadata: { type: 'json' },
    ipAddress: { type: 'string' },
    userAgent: { type: 'text' },
    source: { type: 'string' },
    requestId: { type: 'string' },
  },
};

export const allSchemas: Record<string, Schema> = {
  [pageSchema.uid]: pageSchema,
  [authorSchema.uid]: authorSchema,
  [internalLogSchema.uid]: internalLogSchema,
  [auditLogSchema.uid]: auditLogSchema,
  [seoComponent.uid]: seoComponent,
  ...widgetSchemas,
};

/** A page row as it sits in the database: five widgets used out of 173 declared. */
export const pageRow = (overrides: Record<string, any> = {}) => ({
  id: 1,
  documentId: 'page-doc-1',
  locale: 'en',
  publishedAt: null,
  title: 'Old Homepage',
  slug: 'home',
  body: '<p>Original body</p>',
  seo: {
    id: 10,
    metaTitle: 'Old title',
    metaDescription: 'Old description',
    internalToken: 'tok_should_never_be_stored',
  },
  cover: { id: 5, documentId: 'file-5', name: 'hero.png', url: '/uploads/hero.png', mime: 'image/png', size: 12 },
  gallery: [],
  author: { id: 3, documentId: 'author-doc-3', name: 'Ada', password: 'hunter2' },
  blocks: [
    { id: 101, __component: 'widgets.w0', heading: 'First widget' },
    { id: 102, __component: 'widgets.w1', heading: 'Second widget' },
    { id: 103, __component: 'widgets.w2', heading: 'Third widget' },
    { id: 104, __component: 'widgets.w3', heading: 'Fourth widget' },
    { id: 105, __component: 'widgets.w4', heading: 'Fifth widget' },
  ],
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

/** A Koa context shaped like an authenticated admin request. */
export const adminRequestContext = (overrides: Record<string, any> = {}) => ({
  state: {
    route: { info: { type: 'admin' } },
    user: { id: 7, email: 'admin@example.com', firstname: 'Ada', lastname: 'Lovelace' },
    auth: { strategy: { name: 'admin' } },
    ...overrides.state,
  },
  request: {
    ip: '203.0.113.10',
    headers: { 'user-agent': 'Mozilla/5.0 (Test)', 'x-request-id': 'req-abc-123' },
    ...overrides.request,
  },
});
