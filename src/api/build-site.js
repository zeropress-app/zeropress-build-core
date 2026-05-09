import { createHash } from 'node:crypto';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import { isSafeSlugSegment, normalizeStoredSlug } from '@zeropress/slug-policy';
import { validateThemeFiles } from '@zeropress/theme-validator';
import { AssetProcessor } from '../assets/asset-processor.js';
import { renderDocument, renderDocumentContent } from '../render/content-renderer.js';
import { ZeroPressEngine } from '../render/zeropress-engine.js';

const DEFAULT_OPTIONS = {
  assetHashing: true,
  generateSpecialFiles: true,
  generateRobotsTxt: true,
  writeManifest: false,
};

const DEFAULT_POSTS_PER_PAGE = 10;
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
const DEFAULT_TIME_FORMAT = 'HH:mm';
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LOCALE = 'en-US';
const DEFAULT_PERMALINKS = Object.freeze({
  output_style: 'directory',
  posts: '/posts/:slug/',
  pages: '/:slug/',
  categories: '/categories/:slug/',
  tags: '/tags/:slug/',
});
const DEFAULT_FRONT_PAGE = Object.freeze({
  type: 'theme_index',
});
const DEFAULT_POST_INDEX = Object.freeze({
  enabled: true,
  path: '/',
  paginate: true,
});
const PERMALINK_OUTPUT_STYLES = new Set(['directory', 'html-extension']);
const COMMENT_POLICY_OUTPUT_PATH = '_zeropress/comment-policy.json';
const OUTPUT_PATH_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const SAFE_MEDIA_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
export async function buildSite(input) {
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const state = await createBuildState(input, options);
  assertPlannedOutputPathsSafe(state);

  if (state.renderData.frontPageRoute) {
    await renderFrontPage(state, state.renderData.frontPageRoute);
  }

  for (const route of state.renderData.indexRoutes) {
    await renderRoute(state, 'index', route);
  }

  for (const post of state.renderData.posts) {
    await renderPost(state, post);
  }

  for (const page of state.renderData.pages) {
    await renderPage(state, page);
  }

  if (hasTemplate(state, 'category')) {
    for (const route of state.renderData.categoryRoutes) {
      await renderRoute(state, 'category', route);
    }
  }

  if (hasTemplate(state, 'tag')) {
    for (const route of state.renderData.tagRoutes) {
      await renderRoute(state, 'tag', route);
    }
  }

  if (hasTemplate(state, 'archive')) {
    for (const route of state.renderData.archiveRoutes) {
      await renderRoute(state, 'archive', route);
    }
  }

  for (const assetOutput of state.assetOutputs) {
    await writeOutput(state.writer, state.summaries, assetOutput.path, assetOutput.content, assetOutput.contentType);
  }

  await writeOutput(
    state.writer,
    state.summaries,
    COMMENT_POLICY_OUTPUT_PATH,
    state.commentPolicyContent,
    'application/json',
  );

  if (options.generateSpecialFiles) {
    await maybeRenderNotFoundPage(state);
    if (hasCanonicalSiteUrl(state.previewData.site.url)) {
      await writeOutput(state.writer, state.summaries, 'sitemap.xml', buildSitemapXml(state.previewData.site, state.emitted, state.generatedAt), 'application/xml');
      await writeOutput(state.writer, state.summaries, 'feed.xml', buildFeedXml(state.previewData.site, state.emitted, state.generatedAt), 'application/rss+xml');
    }
    if (shouldGenerateRobotsTxt(options)) {
      await writeOutput(state.writer, state.summaries, 'robots.txt', buildRobotsTxt(state.previewData.site), 'text/plain');
    }
  }

  return finalizeBuildResult(state.writer, state.summaries, options);
}

async function createBuildState(input, options) {
  if (!input?.writer || typeof input.writer.write !== 'function') {
    throw new Error('buildSite requires a writer with an async write(file) method');
  }

  assertBuildPreviewData(input.previewData);
  const themePackage = await normalizeAndValidateThemePackage(input.themePackage);

  const engine = new ZeroPressEngine();
  const assetProcessor = new AssetProcessor();
  const summaries = [];
  const previewData = normalizePreviewData(input.previewData);
  const renderData = createRenderData(previewData, themePackage.metadata);

  engine.initialize(themePackage);

  const assetOutputs = await buildAssetOutputs(themePackage.assets, assetProcessor, options);
  const customCssAsset = await buildCustomCssAsset(previewData.custom_css, assetProcessor, options);
  if (customCssAsset) {
    assetOutputs.push(customCssAsset);
  }
  const assetMap = new Map(
    assetOutputs.map((asset) => [`/assets/${asset.originalPath}`, `/${asset.path}`]),
  );

  return {
    writer: input.writer,
    previewData,
    renderData,
    widgets: resolveWidgetAreas(previewData, renderData),
    engine,
    assetProcessor,
    summaries,
    assetOutputs,
    assetMap,
    customCssHref: customCssAsset ? `/${customCssAsset.path}` : '',
    customHtml: previewData.custom_html,
    commentPolicyContent: buildCommentPolicyManifest(renderData.posts),
    options,
    generatedAt: new Date(),
    emitted: {
      frontPage: null,
      indexRoutes: [],
      archiveRoutes: [],
      categoryRoutes: [],
      tagRoutes: [],
      posts: [],
      pages: [],
    },
  };
}

function assertBuildPreviewData(previewData) {
  try {
    assertPreviewData(previewData);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Invalid preview-data')) {
      throw error;
    }
    throw new Error(`Invalid preview-data: ${message}`);
  }
}

async function finalizeBuildResult(writer, summaries, options) {
  let manifest;
  if (options.writeManifest) {
    manifest = {
      generatedAt: formatUtcIsoSeconds(new Date()),
      files: summaries.map((file) => ({ ...file })),
    };
    await writeOutput(
      writer,
      summaries,
      'build-manifest.json',
      JSON.stringify(manifest, null, 2),
      'application/json',
    );
  }

  return {
    files: summaries,
    manifest,
  };
}

async function renderRoute(state, templateName, route) {
  const currentUrl = routePathToPublicUrl(route.path, state.previewData.site.permalinks.output_style);
  const routeContext = buildRouteContext(route.route_type || templateName, currentUrl, {
    isFrontPage: route.is_front_page === true,
    isPostIndex: route.is_post_index === true,
  });
  let html = await state.engine.render(
    templateName,
    {
      menus: state.previewData.menus,
      widgets: state.widgets,
      collections: state.renderData.collections,
      taxonomies: state.renderData.taxonomies,
      ...route,
      route: routeContext,
      meta: buildPageMeta(state.previewData.site, {
        currentUrl,
        title: state.previewData.site.title,
        description: state.previewData.site.description,
        ogType: 'website',
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state);
  await writeOutput(state.writer, state.summaries, routePathToOutputPath(route.path, state.previewData.site.permalinks.output_style), html, 'text/html');
  recordRouteEmission(state, templateName, route, currentUrl);
}

async function renderFrontPage(state, route) {
  const currentUrl = '/';
  const routeContext = buildRouteContext('front_page', currentUrl, {
    isFrontPage: true,
    isPostIndex: false,
  });

  if (route.front_page_type === 'standalone_html') {
    await writeOutput(state.writer, state.summaries, 'index.html', route.html, 'text/html');
    state.emitted.frontPage = {
      url: currentUrl,
      title: state.previewData.site.title,
      description: state.previewData.site.description,
      includeInFeed: false,
    };
    return;
  }

  if (route.front_page_type === 'page') {
    const page = {
      ...route.page,
      url: currentUrl,
    };
    let html = await state.engine.render(
      'page',
      {
        menus: state.previewData.menus,
        widgets: state.widgets,
        collections: state.renderData.collections,
        taxonomies: state.renderData.taxonomies,
        page,
        route: routeContext,
        meta: buildPageMeta(state.previewData.site, {
          currentUrl,
          title: buildDocumentTitle(page.title, state.previewData.site.title),
          description: page.excerpt,
          ogType: 'website',
          image: page.featured_image,
        }),
      },
      createRenderContext(state.previewData.site, currentUrl),
    );
    html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
    html = injectSiteCustomizations(html, state);
    await writeOutput(state.writer, state.summaries, 'index.html', html, 'text/html');
    state.emitted.frontPage = {
      url: currentUrl,
      title: page.title,
      description: page.excerpt,
      includeInFeed: false,
    };
    return;
  }

  let html = await state.engine.render(
    'index',
    {
      menus: state.previewData.menus,
      widgets: state.widgets,
      collections: state.renderData.collections,
      taxonomies: state.renderData.taxonomies,
      ...route,
      route: routeContext,
      meta: buildPageMeta(state.previewData.site, {
        currentUrl,
        title: state.previewData.site.title,
        description: state.previewData.site.description,
        ogType: 'website',
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state);
  await writeOutput(state.writer, state.summaries, 'index.html', html, 'text/html');
  state.emitted.frontPage = {
    url: currentUrl,
    title: state.previewData.site.title,
    description: state.previewData.site.description,
    includeInFeed: false,
  };
}

async function renderPost(state, post) {
  const currentUrl = post.url;
  let html = await state.engine.render(
    'post',
    {
      menus: state.previewData.menus,
      widgets: state.widgets,
      collections: state.renderData.collections,
      taxonomies: state.renderData.taxonomies,
      post,
      route: buildRouteContext('post', currentUrl),
      meta: buildPageMeta(state.previewData.site, {
        currentUrl,
        title: buildDocumentTitle(post.title, state.previewData.site.title),
        description: post.excerpt,
        ogType: 'article',
        image: post.featured_image,
        publishedTime: post.published_at_iso,
        modifiedTime: post.updated_at_iso,
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state);
  await writeOutput(state.writer, state.summaries, routePathToOutputPath(post.url, state.previewData.site.permalinks.output_style), html, 'text/html');
  state.emitted.posts.push({
    url: currentUrl,
    title: post.title,
    description: post.excerpt,
    publishedAt: post.published_at_iso,
    updatedAt: post.updated_at_iso,
    status: post.status,
  });
}

async function renderPage(state, page) {
  const currentUrl = page.url;
  const outputPath = pageToOutputPath(page, state.previewData.site.permalinks.output_style);
  const canonicalUrl = normalizeOptionalString(page.canonical_url) || currentUrl;
  let html = await state.engine.render(
    'page',
    {
      menus: state.previewData.menus,
      widgets: state.widgets,
      collections: state.renderData.collections,
      taxonomies: state.renderData.taxonomies,
      page,
      route: buildRouteContext('page', currentUrl),
      meta: buildPageMeta(state.previewData.site, {
        currentUrl,
        canonicalUrl,
        title: buildDocumentTitle(page.title, state.previewData.site.title),
        description: page.excerpt,
        ogType: 'website',
        image: page.featured_image,
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state);
  await writeOutput(state.writer, state.summaries, outputPath, html, 'text/html');
  state.emitted.pages.push({
    url: currentUrl,
    title: page.title,
    description: page.excerpt,
    status: page.status,
    includeInSitemap: page.omit_from_sitemap !== true,
  });
}

async function maybeRenderNotFoundPage(state) {
  if (!state.engine.themePackage?.templates?.has('404')) {
    return;
  }

  let html = await state.engine.render(
    '404',
    {
      menus: state.previewData.menus,
      widgets: state.widgets,
      collections: state.renderData.collections,
      taxonomies: state.renderData.taxonomies,
      route: buildRouteContext('not_found', '/404.html'),
      meta: buildPageMeta(state.previewData.site, {
        currentUrl: '/404.html',
        title: state.previewData.site.title,
        description: state.previewData.site.description,
        ogType: 'website',
      }),
    },
    createRenderContext(state.previewData.site, '/404.html'),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state);
  await writeOutput(state.writer, state.summaries, '404.html', html, 'text/html');
}

function normalizePreviewData(previewData) {
  const normalizedSite = {
    ...previewData.site,
    mediaBaseUrl: normalizeOptionalString(previewData.site.mediaBaseUrl),
    postsPerPage: Number.isInteger(previewData.site.postsPerPage) && previewData.site.postsPerPage > 0
      ? previewData.site.postsPerPage
      : DEFAULT_POSTS_PER_PAGE,
    dateFormat: normalizeNonEmptyString(previewData.site.dateFormat, DEFAULT_DATE_FORMAT),
    timeFormat: typeof previewData.site.timeFormat === 'string' ? previewData.site.timeFormat : DEFAULT_TIME_FORMAT,
    timezone: normalizeNonEmptyString(previewData.site.timezone, DEFAULT_TIMEZONE),
    locale: normalizeLocale(previewData.site.locale || DEFAULT_LOCALE),
    disallowComments: previewData.site.disallowComments === true,
    indexing: previewData.site.indexing !== false,
    permalinks: normalizePermalinks(previewData.site.permalinks),
    front_page: normalizeFrontPage(previewData.site.front_page),
    post_index: normalizePostIndex(previewData.site.post_index),
    footer: normalizeSiteFooter(previewData.site.footer),
  };

  return {
    ...previewData,
    site: normalizedSite,
    menus: normalizeRecordMap(previewData.menus),
    collections: normalizeCollections(previewData.collections),
    widgets: normalizeWidgetAreas(previewData.widgets, normalizedSite.mediaBaseUrl),
    custom_css: normalizeCustomCss(previewData.custom_css),
    custom_html: normalizeCustomHtml(previewData.custom_html),
    content: {
      ...previewData.content,
      authors: previewData.content.authors.map((author) => ({
        ...author,
        avatar: normalizeMediaField(author.avatar, normalizedSite.mediaBaseUrl),
      })),
      posts: previewData.content.posts
        .map((post) => ({
          ...post,
          published_at_iso: normalizeIsoTimestamp(post.published_at_iso),
          updated_at_iso: normalizeIsoTimestamp(post.updated_at_iso),
          featured_image: normalizeMediaField(post.featured_image, normalizedSite.mediaBaseUrl),
        }))
        .sort((left, right) => toDate(right.published_at_iso).getTime() - toDate(left.published_at_iso).getTime()),
      pages: previewData.content.pages.map((page) => ({
        ...page,
        featured_image: normalizeMediaField(page.featured_image, normalizedSite.mediaBaseUrl),
      })),
      categories: [...previewData.content.categories],
      tags: [...previewData.content.tags],
    },
  };
}

function normalizeRecordMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function normalizeCollections(collections) {
  if (!collections || typeof collections !== 'object' || Array.isArray(collections)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(collections).map(([collectionId, collection]) => [
      collectionId,
      {
        ...collection,
        title: normalizeOptionalString(collection?.title),
        description: normalizeOptionalString(collection?.description),
        items: Array.isArray(collection?.items) ? collection.items.map((item) => ({ ...item })) : [],
      },
    ]),
  );
}

function normalizeWidgetAreas(widgetAreas, mediaBaseUrl) {
  if (!widgetAreas || typeof widgetAreas !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(widgetAreas).map(([widgetAreaId, widgetArea]) => [
      widgetAreaId,
      {
        ...widgetArea,
        name: normalizeNonEmptyString(widgetArea?.name, widgetAreaId),
        items: Array.isArray(widgetArea?.items)
          ? widgetArea.items.map((item) => normalizeWidgetItem(item, mediaBaseUrl))
          : [],
      },
    ]),
  );
}

function normalizeSiteFooter(footer) {
  const source = footer && typeof footer === 'object' && !Array.isArray(footer) ? footer : {};
  const attribution = source.attribution && typeof source.attribution === 'object' && !Array.isArray(source.attribution)
    ? source.attribution
    : {};

  return {
    ...source,
    copyright_text: normalizeOptionalString(source.copyright_text),
    attribution: {
      ...attribution,
      enabled: attribution.enabled !== false,
    },
  };
}

function normalizeWidgetItem(item, mediaBaseUrl) {
  const normalizedItem = {
    ...item,
    title: typeof item?.title === 'string' ? item.title.trim() : '',
  };

  if (item?.type === 'profile' && item?.settings && typeof item.settings === 'object') {
    return {
      ...normalizedItem,
      settings: {
        ...item.settings,
        avatar: normalizeMediaField(item.settings.avatar, mediaBaseUrl),
      },
    };
  }

  return normalizedItem;
}

function normalizeCustomCss(customCss) {
  const content = normalizeOptionalString(customCss?.content);
  return content ? { content } : undefined;
}

function normalizeCustomHtml(customHtml) {
  if (!customHtml || typeof customHtml !== 'object') {
    return undefined;
  }

  const headEnd = normalizeOptionalRawString(customHtml.head_end?.content);
  const bodyEnd = normalizeOptionalRawString(customHtml.body_end?.content);
  if (!headEnd && !bodyEnd) {
    return undefined;
  }

  return {
    ...(headEnd ? { head_end: { content: headEnd } } : {}),
    ...(bodyEnd ? { body_end: { content: bodyEnd } } : {}),
  };
}

function normalizePermalinks(permalinks) {
  const source = permalinks && typeof permalinks === 'object' ? permalinks : {};
  const outputStyle = typeof source.output_style === 'string' && PERMALINK_OUTPUT_STYLES.has(source.output_style)
    ? source.output_style
    : DEFAULT_PERMALINKS.output_style;

  return {
    output_style: outputStyle,
    posts: normalizeNonEmptyString(source.posts, DEFAULT_PERMALINKS.posts),
    pages: normalizeNonEmptyString(source.pages, DEFAULT_PERMALINKS.pages),
    categories: normalizeNonEmptyString(source.categories, DEFAULT_PERMALINKS.categories),
    tags: normalizeNonEmptyString(source.tags, DEFAULT_PERMALINKS.tags),
  };
}

function normalizeFrontPage(frontPage) {
  if (!frontPage || typeof frontPage !== 'object') {
    return { ...DEFAULT_FRONT_PAGE };
  }

  const type = ['theme_index', 'page', 'standalone_html'].includes(frontPage.type)
    ? frontPage.type
    : DEFAULT_FRONT_PAGE.type;

  return {
    type,
    ...(type === 'page' ? { page_slug: normalizeOptionalString(frontPage.page_slug) } : {}),
    ...(type === 'standalone_html' ? { html: normalizeOptionalRawString(frontPage.html) } : {}),
  };
}

function normalizePostIndex(postIndex) {
  if (!postIndex || typeof postIndex !== 'object') {
    return { ...DEFAULT_POST_INDEX };
  }

  return {
    enabled: postIndex.enabled !== false,
    path: normalizeNonEmptyString(postIndex.path, DEFAULT_POST_INDEX.path),
    paginate: postIndex.paginate !== false,
  };
}

function createRenderData(previewData, themeMetadata = {}) {
  const themeSupportsComments = themeMetadata?.features?.comments === true;
  const themeSupportsPostIndex = themeMetadata?.features?.postIndex !== false;
  const authorsById = new Map(previewData.content.authors.map((author) => [author.id, author]));
  const categoriesBySlug = new Map(previewData.content.categories.map((category) => [category.slug, category]));
  const tagsBySlug = new Map(previewData.content.tags.map((tag) => [tag.slug, tag]));
  const categoryPostsBySlug = new Map();
  const tagPostsBySlug = new Map();
  const categoryCountBySlug = new Map();
  const tagCountBySlug = new Map();

  for (const post of previewData.content.posts) {
    for (const slug of post.category_slugs) {
      pushToSlugMap(categoryPostsBySlug, slug, post);
      categoryCountBySlug.set(slug, (categoryCountBySlug.get(slug) || 0) + 1);
    }

    for (const slug of post.tag_slugs) {
      pushToSlugMap(tagPostsBySlug, slug, post);
      tagCountBySlug.set(slug, (tagCountBySlug.get(slug) || 0) + 1);
    }
  }

  const preparedPosts = previewData.content.posts.map((post) => preparePost(post, previewData.site, authorsById, categoriesBySlug, tagsBySlug, themeSupportsComments));
  const posts = preparedPosts.map((post, index) => ({
    ...post,
    prev: index > 0 ? buildAdjacentPostSummary(preparedPosts[index - 1]) : null,
    next: index < preparedPosts.length - 1 ? buildAdjacentPostSummary(preparedPosts[index + 1]) : null,
  }));
  const pages = previewData.content.pages.map((page) => preparePage(page, previewData.site));
  const postBySlug = new Map(posts.map((post) => [post.slug, post]));
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const frontPage = previewData.site.front_page;
  const postIndex = previewData.site.post_index;
  const effectivePostIndexEnabled = postIndex.enabled !== false && themeSupportsPostIndex;
  const effectivePostIndexPaginate = effectivePostIndexEnabled && postIndex.paginate !== false;
  const postIndexBasePath = normalizeRoutePath(postIndex.path || DEFAULT_POST_INDEX.path);

  if (frontPage.type !== 'theme_index' && effectivePostIndexEnabled && postIndexBasePath === '/') {
    throw new Error('Invalid front page configuration: site.front_page occupies "/" so site.post_index.path must not be "/". Set site.post_index.path to a non-root path or disable site.post_index.');
  }

  const frontPageRoute = buildFrontPageRoute(frontPage, pages, effectivePostIndexEnabled, postIndexBasePath);
  const pageFrontPageSlug = frontPage.type === 'page' ? frontPage.page_slug : '';
  const preparedPages = pageFrontPageSlug
    ? pages.filter((page) => page.slug !== pageFrontPageSlug)
    : pages;

  return {
    posts,
    pages: preparedPages,
    postBySlug,
    collections: resolveCollections(previewData.collections, postBySlug, pageBySlug, frontPage),
    taxonomies: buildGlobalTaxonomies(previewData, categoryCountBySlug, tagCountBySlug),
    frontPageRoute,
    indexRoutes: buildPostIndexRoutes({
      enabled: effectivePostIndexEnabled,
      paginate: effectivePostIndexPaginate,
      items: previewData.content.posts,
      postsPerPage: previewData.site.postsPerPage,
      basePath: postIndexBasePath,
      outputStyle: previewData.site.permalinks.output_style,
      postBySlug,
      frontPage,
    }),
    archiveRoutes: buildPaginatedCollection({
      items: previewData.content.posts,
      postsPerPage: previewData.site.postsPerPage,
      basePath: '/archive/',
      outputStyle: previewData.site.permalinks.output_style,
    }).map((entry) => ({
      path: entry.path,
      page: entry.page,
      totalPages: entry.totalPages,
      archive: {
        groups: buildArchiveGroups(entry.items, postBySlug),
      },
      pagination: buildStructuredPagination(entry.paginationData),
    })),
    categoryRoutes: buildTaxonomyRoutes({
      items: previewData.content.categories,
      postsBySlug: categoryPostsBySlug,
      postBySlug,
      postsPerPage: previewData.site.postsPerPage,
      outputStyle: previewData.site.permalinks.output_style,
      buildBasePath: (category) => resolvePermalink(previewData.site, 'categories', category).path,
      renderExtras: (category) => ({
        taxonomy: buildTaxonomyRouteData('category', category, categoryCountBySlug),
      }),
    }),
    tagRoutes: buildTaxonomyRoutes({
      items: previewData.content.tags,
      postsBySlug: tagPostsBySlug,
      postBySlug,
      postsPerPage: previewData.site.postsPerPage,
      outputStyle: previewData.site.permalinks.output_style,
      buildBasePath: (tag) => resolvePermalink(previewData.site, 'tags', tag).path,
      renderExtras: (tag) => ({
        taxonomy: buildTaxonomyRouteData('tag', tag, tagCountBySlug),
      }),
    }),
  };
}

function buildGlobalTaxonomies(previewData, categoryCountBySlug, tagCountBySlug) {
  return {
    categories: buildGlobalTaxonomyItems(previewData.site, 'categories', previewData.content.categories, categoryCountBySlug),
    tags: buildGlobalTaxonomyItems(previewData.site, 'tags', previewData.content.tags, tagCountBySlug),
  };
}

function resolveCollections(collections, postBySlug, pageBySlug, frontPage) {
  if (!collections || typeof collections !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(collections).map(([collectionId, collection]) => [
      collectionId,
      {
        id: collectionId,
        title: normalizeOptionalString(collection?.title),
        description: normalizeOptionalString(collection?.description),
        items: resolveCollectionItems(collectionId, collection?.items, postBySlug, pageBySlug, frontPage),
      },
    ]),
  );
}

function resolveCollectionItems(collectionId, items, postBySlug, pageBySlug, frontPage) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => resolveCollectionItem(collectionId, item, index, postBySlug, pageBySlug, frontPage));
}

function resolveCollectionItem(collectionId, item, index, postBySlug, pageBySlug, frontPage) {
  if (item?.type === 'post') {
    const post = postBySlug.get(item.slug);
    if (!post) {
      throw new Error(`Invalid collection "${collectionId}": item ${index + 1} references missing post slug "${item.slug}".`);
    }
    return {
      type: 'post',
      meta: post.meta,
      ...buildStructuredPostSummary(post),
    };
  }

  if (item?.type === 'page') {
    const page = pageBySlug.get(item.slug);
    if (!page) {
      throw new Error(`Invalid collection "${collectionId}": item ${index + 1} references missing page slug "${item.slug}".`);
    }
    return buildCollectionPageSummary(page, frontPage);
  }

  throw new Error(`Invalid collection "${collectionId}": item ${index + 1} has unsupported type "${item?.type}".`);
}

function buildCollectionPageSummary(page, frontPage) {
  return {
    type: 'page',
    title: page.title,
    slug: page.slug,
    url: frontPage?.type === 'page' && frontPage.page_slug === page.slug ? '/' : page.url,
    excerpt: page.excerpt || '',
    featured_image: page.featured_image || '',
    meta: page.meta,
  };
}

function buildFrontPageRoute(frontPage, pages, effectivePostIndexEnabled, postIndexBasePath) {
  if (frontPage.type === 'theme_index') {
    if (effectivePostIndexEnabled && postIndexBasePath === '/') {
      return null;
    }

    return {
      path: '/',
      front_page_type: 'theme_index',
      posts: buildStructuredPostCollection([], new Map()),
      pagination: buildStructuredPagination(buildDisabledPaginationData(0)),
    };
  }

  if (frontPage.type === 'page') {
    const page = pages.find((entry) => entry.slug === frontPage.page_slug);
    if (!page) {
      throw new Error(`Invalid front page configuration: site.front_page.page_slug "${frontPage.page_slug}" does not match a page.`);
    }

    return {
      path: '/',
      front_page_type: 'page',
      page,
    };
  }

  if (frontPage.type === 'standalone_html') {
    if (!normalizeOptionalRawString(frontPage.html)) {
      throw new Error('Invalid front page configuration: site.front_page.html is required for standalone_html.');
    }

    return {
      path: '/',
      front_page_type: 'standalone_html',
      html: frontPage.html,
    };
  }

  return null;
}

function buildPostIndexRoutes(options) {
  if (!options.enabled) {
    return [];
  }

  if (!options.paginate) {
    const items = options.items.slice(0, options.postsPerPage);
    return [{
      path: options.basePath,
      route_type: 'post_index',
      is_front_page: options.basePath === '/' && options.frontPage.type === 'theme_index',
      is_post_index: true,
      page: 1,
      totalPages: 1,
      posts: buildStructuredPostCollection(items, options.postBySlug),
      pagination: buildStructuredPagination(buildDisabledPaginationData(options.items.length)),
    }];
  }

  return buildPaginatedCollection({
    items: options.items,
    postsPerPage: options.postsPerPage,
    basePath: options.basePath,
    outputStyle: options.outputStyle,
  }).map((entry) => ({
    path: entry.path,
    route_type: 'post_index',
    is_front_page: entry.path === '/' && options.frontPage.type === 'theme_index',
    is_post_index: true,
    page: entry.page,
    totalPages: entry.totalPages,
    posts: buildStructuredPostCollection(entry.items, options.postBySlug),
    pagination: buildStructuredPagination(entry.paginationData),
  }));
}

function buildGlobalTaxonomyItems(site, permalinkKind, items, countBySlug) {
  return items.map((item) => ({
    name: item.name,
    slug: item.slug,
    url: resolvePermalink(site, permalinkKind, item).url,
    count: countBySlug.get(item.slug) || 0,
    description: typeof item.description === 'string' ? item.description : '',
  }));
}

function resolveWidgetAreas(previewData, renderData) {
  if (!previewData.widgets || typeof previewData.widgets !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(previewData.widgets).map(([widgetAreaId, widgetArea]) => [
      widgetAreaId,
      resolveWidgetArea(widgetArea, previewData, renderData, widgetAreaId),
    ]),
  );
}

function resolveWidgetArea(widgetArea, previewData, renderData, widgetAreaId) {
  if (!widgetArea || !Array.isArray(widgetArea.items)) {
    return {
      name: normalizeNonEmptyString(widgetArea?.name, widgetAreaId),
      items: [],
    };
  }

  return {
    name: normalizeNonEmptyString(widgetArea?.name, widgetAreaId),
    items: widgetArea.items
      .map((item, index) => resolveWidgetItem(item, previewData, renderData, widgetAreaId, index))
      .filter(Boolean),
  };
}

function resolveWidgetItem(item, previewData, renderData, widgetAreaId, index) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') {
    return null;
  }

  const baseWidget = {
    id: `${widgetAreaId}-${index + 1}`,
    type: item.type,
    title: typeof item.title === 'string' ? item.title : '',
    empty: false,
  };

  switch (item.type) {
    case 'recent-posts':
      return resolveRecentPostsWidget(baseWidget, item.settings, renderData);
    case 'categories':
      return resolveCategoriesWidget(baseWidget, item.settings, previewData);
    case 'tags':
      return resolveTagsWidget(baseWidget, item.settings, previewData);
    case 'archives':
      return resolveArchivesWidget(baseWidget, item.settings, previewData);
    case 'text':
      return resolveTextWidget(baseWidget, item.settings);
    case 'link-list':
      return resolveLinkListWidget(baseWidget, item.settings);
    case 'search':
      return resolveSearchWidget(baseWidget, item.settings, widgetAreaId, index);
    case 'profile':
      return resolveProfileWidget(baseWidget, item.settings);
    default:
      return null;
  }
}

function resolveRecentPostsWidget(baseWidget, settings, renderData) {
  const limit = clampInteger(settings?.limit, 5, 1, 20);
  const items = renderData.posts
    .slice(0, limit)
    .map((post) => ({
      title: post.title,
      url: `/posts/${encodeSlugSegment(post.slug)}/`,
      published_at: post.published_at,
      published_at_iso: post.published_at_iso,
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    ...baseWidget,
    show_date: settings?.show_date !== false,
    items,
  };
}

function resolveCategoriesWidget(baseWidget, settings, previewData) {
  const countBySlug = buildTaxonomyCountMap(previewData.content.posts, 'category_slugs');
  const items = previewData.content.categories
    .map((category) => ({
      name: category.name,
      slug: category.slug,
      url: resolvePermalink(previewData.site, 'categories', category).url,
      count: countBySlug.get(category.slug) || 0,
      depth: 0,
    }))
    .filter((category) => category.count > 0);

  if (items.length === 0) {
    return null;
  }

  return {
    ...baseWidget,
    show_count: settings?.show_count === true,
    hierarchical: settings?.hierarchical === true,
    items,
  };
}

function resolveTagsWidget(baseWidget, settings, previewData) {
  const countBySlug = buildTaxonomyCountMap(previewData.content.posts, 'tag_slugs');
  const limit = clampInteger(settings?.limit, 20, 1, 100);
  const items = previewData.content.tags
    .map((tag) => ({
      name: tag.name,
      slug: tag.slug,
      url: resolvePermalink(previewData.site, 'tags', tag).url,
      count: countBySlug.get(tag.slug) || 0,
    }))
    .filter((tag) => tag.count > 0)
    .slice(0, limit);

  if (items.length === 0) {
    return null;
  }

  return {
    ...baseWidget,
    show_count: settings?.show_count === true,
    items,
  };
}

function resolveArchivesWidget(baseWidget, settings, previewData) {
  const limit = clampInteger(settings?.limit, 12, 1, 120);
  const items = buildArchiveEntries(previewData.content.posts, previewData.site)
    .slice(0, limit)
    .map((entry) => ({
      label: entry.label,
      url: routePathToPublicUrl('/archive/', previewData.site.permalinks.output_style),
      count: entry.count,
      year: entry.year,
      month: entry.month,
      meta: `${entry.count} posts`,
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    ...baseWidget,
    items,
  };
}

function resolveTextWidget(baseWidget, settings) {
  const content = typeof settings?.content === 'string' ? settings.content : '';
  const html = renderDocumentContent(content, normalizeDocumentType(settings?.document_type));

  if (!normalizeOptionalString(html)) {
    return null;
  }

  return {
    ...baseWidget,
    html,
  };
}

function resolveLinkListWidget(baseWidget, settings) {
  const items = (Array.isArray(settings?.links) ? settings.links : [])
    .map((link) => {
      const label = normalizeOptionalString(link?.label);
      const url = normalizeThemeLinkUrl(link?.url);
      if (!label || !url) {
        return null;
      }

      const target = normalizeLinkTarget(link?.target);
      return {
        label,
        url,
        target,
        rel: target === '_blank' ? 'noreferrer noopener' : '',
      };
    })
    .filter(Boolean);

  if (items.length === 0) {
    return null;
  }

  return {
    ...baseWidget,
    items,
  };
}

function resolveSearchWidget(baseWidget, settings, widgetAreaId, index) {
  return {
    ...baseWidget,
    placeholder: normalizeNonEmptyString(settings?.placeholder, 'Search...'),
    button_label: normalizeNonEmptyString(settings?.button_label, 'Search'),
    dom_id: `widget-search-${widgetAreaId}-${index + 1}`,
  };
}

function resolveProfileWidget(baseWidget, settings) {
  const displayName = normalizeOptionalString(settings?.display_name);
  const affiliation = normalizeOptionalString(settings?.affiliation);
  const bioText = normalizeOptionalString(settings?.bio_short);
  const avatarUrl = normalizeMediaField(settings?.avatar);

  if (!displayName && !affiliation && !bioText && !avatarUrl) {
    return null;
  }

  return {
    ...baseWidget,
    display_name: displayName,
    affiliation,
    avatar_url: avatarUrl,
    bio_text: bioText,
  };
}

function preparePage(page, site) {
  const documentType = normalizeDocumentType(page.document_type);
  const renderedDocument = renderDocument(page.content, documentType);
  const permalink = resolvePagePermalink(site, page);

  return {
    ...page,
    url: permalink.url,
    document_type: documentType,
    html: renderedDocument.html,
    toc: renderedDocument.toc,
  };
}

function preparePost(post, site, authorsById, categoriesBySlug, tagsBySlug, themeSupportsComments) {
  const documentType = normalizeDocumentType(post.document_type);
  const renderedDocument = renderDocument(post.content, documentType);
  const author = authorsById.get(post.author_id);
  const permalink = resolvePermalink(site, 'posts', post);
  const categories = post.category_slugs
    .map((slug) => categoriesBySlug.get(slug))
    .filter(Boolean)
    .map((category) => ({
      name: category.name,
      slug: category.slug,
      url: resolvePermalink(site, 'categories', category).url,
    }));
  const tags = post.tag_slugs
    .map((slug) => tagsBySlug.get(slug))
    .filter(Boolean)
    .map((tag) => ({
      name: tag.name,
      slug: tag.slug,
      url: resolvePermalink(site, 'tags', tag).url,
    }));

  return {
    public_id: post.public_id,
    title: post.title,
    slug: post.slug,
    url: permalink.url,
    content: post.content,
    document_type: documentType,
    excerpt: post.excerpt,
    published_at_iso: post.published_at_iso,
    updated_at_iso: post.updated_at_iso,
    author_id: post.author_id,
    featured_image: post.featured_image,
    meta: post.meta,
    status: post.status,
    allow_comments: post.allow_comments,
    category_slugs: post.category_slugs,
    tag_slugs: post.tag_slugs,
    author: {
      id: post.author_id,
      display_name: normalizeNonEmptyString(author?.display_name, post.author_id),
      avatar: author?.avatar || '',
    },
    categories,
    tags,
    html: renderedDocument.html,
    toc: renderedDocument.toc,
    published_at: formatTimestamp(post.published_at_iso, site),
    updated_at: formatTimestamp(post.updated_at_iso, site),
    reading_time: calculateReadingTime(renderedDocument.html),
    comments_enabled: themeSupportsComments && site.disallowComments !== true && post.allow_comments === true,
  };
}

function buildCommentPolicyManifest(posts) {
  const commentablePosts = posts
    .filter((post) => post.status === 'published' && post.comments_enabled === true)
    .map((post) => post.public_id)
    .filter((value) => Number.isInteger(value) && value > 0);

  return JSON.stringify({
    version: 1,
    commentable_posts: commentablePosts,
  }, null, 2);
}

function buildTaxonomyRoutes(options) {
  const routes = [];

  for (const item of options.items) {
    const matchedPosts = options.postsBySlug.get(item.slug) || [];
    if (matchedPosts.length === 0) {
      continue;
    }

    const paginated = buildPaginatedCollection({
      items: matchedPosts,
      postsPerPage: options.postsPerPage,
      basePath: options.buildBasePath(item),
      outputStyle: options.outputStyle,
    });

    for (const entry of paginated) {
      routes.push({
        path: entry.path,
        slug: item.slug,
        page: entry.page,
        totalPages: entry.totalPages,
        posts: buildStructuredPostCollection(entry.items, options.postBySlug),
        pagination: buildStructuredPagination(entry.paginationData),
        ...options.renderExtras(item),
      });
    }
  }

  return routes;
}

function buildPaginatedCollection(options) {
  const basePath = normalizePaginationBasePath(options.basePath);
  const outputStyle = PERMALINK_OUTPUT_STYLES.has(options.outputStyle) ? options.outputStyle : DEFAULT_PERMALINKS.output_style;
  const postsPerPage = Number.isInteger(options.postsPerPage) && options.postsPerPage > 0 ? options.postsPerPage : DEFAULT_POSTS_PER_PAGE;
  const totalPosts = options.items.length;
  const totalPages = Math.max(1, Math.ceil(totalPosts / postsPerPage));
  const pages = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * postsPerPage;
    const end = start + postsPerPage;

    pages.push({
      path: buildPaginatedPath(basePath, page),
      page,
      totalPages,
      items: options.items.slice(start, end),
      paginationData: buildPaginationData(page, totalPages, totalPosts, basePath, outputStyle),
    });
  }

  return pages;
}

function buildStructuredPostCollection(posts, postBySlug) {
  return {
    items: buildStructuredPostItems(posts, postBySlug),
  };
}

function buildPaginatedPath(basePath, page) {
  const normalizedBasePath = normalizePaginationBasePath(basePath);
  if (page <= 1) {
    return normalizedBasePath;
  }
  if (normalizedBasePath === '/') {
    return `/page/${page}/`;
  }
  return `${normalizedBasePath}page/${page}/`;
}

function normalizePaginationBasePath(basePath) {
  if (!basePath || basePath === '/') {
    return '/';
  }

  const normalized = decodeRoutePath(String(basePath)).replace(/^\/+|\/+$/g, '');
  return `/${normalized}/`;
}

function buildPaginationData(currentPage, totalPages, totalPosts, basePath, outputStyle = DEFAULT_PERMALINKS.output_style) {
  const buildPageUrl = (page) => routePathToPublicUrl(buildPaginatedPath(basePath, page), outputStyle);

  return {
    enabled: true,
    currentPage,
    totalPages,
    totalPosts,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    nextUrl: currentPage < totalPages ? buildPageUrl(currentPage + 1) : undefined,
    prevUrl: currentPage > 1 ? buildPageUrl(currentPage - 1) : undefined,
    pages: Array.from({ length: totalPages }, (_, index) => {
      const page = index + 1;
      return {
        number: page,
        url: buildPageUrl(page),
        current: page === currentPage,
      };
    }),
  };
}

function buildDisabledPaginationData(totalPosts) {
  return {
    enabled: false,
    currentPage: 1,
    totalPages: 1,
    totalPosts,
    hasNext: false,
    hasPrev: false,
    nextUrl: undefined,
    prevUrl: undefined,
    pages: [],
  };
}

function buildStructuredPagination(paginationData) {
  return {
    enabled: paginationData.enabled !== false,
    current_page: paginationData.currentPage,
    total_pages: paginationData.totalPages,
    total_items: paginationData.totalPosts,
    has_prev: paginationData.hasPrev,
    has_next: paginationData.hasNext,
    has_multiple_pages: paginationData.totalPages > 1,
    prev_url: paginationData.prevUrl || '',
    next_url: paginationData.nextUrl || '',
    pages: paginationData.pages.map((page) => ({
      number: page.number,
      url: page.url,
      current: page.current,
    })),
    window: buildPaginationWindow(paginationData),
  };
}

function buildPaginationWindow(paginationData) {
  const totalPages = paginationData.totalPages;
  if (!Number.isInteger(totalPages) || totalPages <= 0) {
    return [];
  }

  const currentPage = paginationData.currentPage;
  const pageMap = new Map(
    paginationData.pages.map((page) => [page.number, {
      kind: 'page',
      number: page.number,
      url: page.url,
      current: page.current,
    }]),
  );

  if (totalPages <= 7) {
    return paginationData.pages.map((page) => ({
      kind: 'page',
      number: page.number,
      url: page.url,
      current: page.current,
    }));
  }

  const pageNumbers = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

  if (currentPage <= 4) {
    for (let number = 1; number <= 5; number += 1) {
      pageNumbers.add(number);
    }
  }

  if (currentPage >= totalPages - 3) {
    for (let number = totalPages - 4; number <= totalPages; number += 1) {
      pageNumbers.add(number);
    }
  }

  const orderedNumbers = Array.from(pageNumbers)
    .filter((number) => Number.isInteger(number) && number >= 1 && number <= totalPages)
    .sort((left, right) => left - right);

  const windowItems = [];
  let previousNumber = null;

  for (const number of orderedNumbers) {
    if (previousNumber != null && number - previousNumber > 1) {
      windowItems.push({ kind: 'gap' });
    }

    const pageItem = pageMap.get(number);
    if (pageItem) {
      windowItems.push(pageItem);
    }
    previousNumber = number;
  }

  return windowItems;
}

function buildStructuredPostItems(posts, postBySlug) {
  return posts
    .map((post) => postBySlug.get(post.slug))
    .filter(Boolean)
    .map((post) => buildStructuredPostSummary(post));
}

function buildStructuredPostSummary(post) {
  return {
    title: post.title,
    slug: post.slug,
    url: post.url,
    excerpt: post.excerpt,
    published_at: post.published_at,
    published_at_iso: post.published_at_iso,
    reading_time: post.reading_time,
    featured_image: post.featured_image,
    author: {
      display_name: post.author?.display_name || '',
      avatar: post.author?.avatar || '',
    },
    categories: Array.isArray(post.categories) ? post.categories.map((category) => ({ ...category })) : [],
    tags: Array.isArray(post.tags) ? post.tags.map((tag) => ({ ...tag })) : [],
  };
}

function buildAdjacentPostSummary(post) {
  if (!post) {
    return null;
  }

  return {
    title: post.title,
    slug: post.slug,
    url: post.url,
    excerpt: post.excerpt,
    published_at: post.published_at,
    published_at_iso: post.published_at_iso,
  };
}

function buildArchiveGroups(posts, postBySlug) {
  const groups = new Map();

  for (const post of posts) {
    const prepared = postBySlug.get(post.slug);
    if (!prepared?.published_at_iso) {
      continue;
    }

    const date = toDate(prepared.published_at_iso);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const label = `${year}-${String(month).padStart(2, '0')}`;
    const current = groups.get(label) || {
      label,
      year,
      month,
      items: [],
    };

    current.items.push(buildStructuredPostSummary(prepared));
    groups.set(label, current);
  }

  return Array.from(groups.values());
}

function buildTaxonomyRouteData(kind, item, countBySlug) {
  return {
    kind,
    slug: item.slug,
    name: item.name,
    count: countBySlug.get(item.slug) || 0,
  };
}

function buildTaxonomyCountMap(posts, fieldName) {
  const counts = new Map();

  for (const post of posts) {
    const values = Array.isArray(post?.[fieldName]) ? post[fieldName] : [];
    for (const value of values) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }

  return counts;
}

function buildArchiveEntries(posts, site) {
  const entries = new Map();

  for (const post of posts) {
    const publishedAt = normalizeIsoTimestamp(post?.published_at_iso);
    if (!publishedAt) {
      continue;
    }

    const date = toDate(publishedAt);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const current = entries.get(key) || { date, count: 0 };
    current.count += 1;
    entries.set(key, current);
  }

  return Array.from(entries.values())
    .sort((left, right) => right.date.getTime() - left.date.getTime())
    .map((entry) => ({
      label: formatArchiveLabel(entry.date, site),
      count: entry.count,
      year: entry.date.getUTCFullYear(),
      month: entry.date.getUTCMonth() + 1,
    }));
}

function formatArchiveLabel(date, site) {
  return new Intl.DateTimeFormat(normalizeLocale(site.locale || DEFAULT_LOCALE), {
    timeZone: normalizeNonEmptyString(site.timezone, DEFAULT_TIMEZONE),
    year: 'numeric',
    month: 'long',
  }).format(date);
}

function formatTimestamp(value, site) {
  const date = toDate(value);
  const locale = normalizeLocale(site.locale || DEFAULT_LOCALE);
  const dateFormat = normalizeNonEmptyString(site.dateFormat, DEFAULT_DATE_FORMAT);
  const timeFormat = typeof site.timeFormat === 'string' ? site.timeFormat : DEFAULT_TIME_FORMAT;
  const siteTimezone = normalizeNonEmptyString(site.timezone, DEFAULT_TIMEZONE);

  const dateParts = new Intl.DateTimeFormat(locale, {
    timeZone: siteTimezone,
    year: 'numeric',
    month: dateFormat === 'MMMM D, YYYY' ? 'long' : '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = dateParts.find((part) => part.type === 'year')?.value || '';
  const month = dateParts.find((part) => part.type === 'month')?.value || '';
  const day = dateParts.find((part) => part.type === 'day')?.value || '';

  let formattedDate = `${year}-${month}-${day}`;
  if (dateFormat === 'DD/MM/YYYY') {
    formattedDate = `${day}/${month}/${year}`;
  } else if (dateFormat === 'MM/DD/YYYY') {
    formattedDate = `${month}/${day}/${year}`;
  } else if (dateFormat === 'MMMM D, YYYY') {
    formattedDate = `${month} ${String(Number(day))}, ${year}`;
  }

  if (!timeFormat) {
    return formattedDate;
  }

  const timeParts = new Intl.DateTimeFormat(locale, {
    timeZone: siteTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: timeFormat === 'hh:mm A',
  }).formatToParts(date);

  const hour = timeParts.find((part) => part.type === 'hour')?.value || '';
  const minute = timeParts.find((part) => part.type === 'minute')?.value || '';
  const dayPeriod = (timeParts.find((part) => part.type === 'dayPeriod')?.value || '').toUpperCase();

  const formattedTime = timeFormat === 'hh:mm A'
    ? `${hour}:${minute}${dayPeriod ? ` ${dayPeriod}` : ''}`
    : `${hour}:${minute}`;

  return `${formattedDate} ${formattedTime}`.trim();
}

function calculateReadingTime(html) {
  const plainText = String(html || '').replace(/<[^>]*>/g, ' ');
  const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(wordCount / 200));
  return minutes === 1 ? '1 min read' : `${minutes} min read`;
}

function pushToSlugMap(target, slug, value) {
  const items = target.get(slug) || [];
  items.push(value);
  target.set(slug, items);
}

function normalizeNonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOptionalRawString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function normalizeLocale(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return DEFAULT_LOCALE;
  }

  const parts = value.trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (parts.length === 0) {
    return DEFAULT_LOCALE;
  }

  return parts.map((part, index) => {
    if (index === 0) {
      return part.toLowerCase();
    }
    if (part.length === 2 || part.length === 3) {
      return part.toUpperCase();
    }
    if (part.length === 4) {
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }
    return part.toLowerCase();
  }).join('-');
}

function normalizeDocumentType(value) {
  return value === 'plaintext' || value === 'html' ? value : 'markdown';
}

function hasTemplate(state, templateName) {
  return state.engine.themePackage?.templates?.has(templateName) === true;
}

function recordRouteEmission(state, templateName, route, currentUrl) {
  const targetMap = {
    index: state.emitted.indexRoutes,
    archive: state.emitted.archiveRoutes,
    category: state.emitted.categoryRoutes,
    tag: state.emitted.tagRoutes,
  }[templateName];

  if (!targetMap) {
    return;
  }

  targetMap.push({
    url: currentUrl,
    page: route.page,
    totalPages: route.totalPages,
    slug: route.slug,
  });
}

async function normalizeAndValidateThemePackage(themePackage) {
  if (!themePackage?.templates || !themePackage?.partials || !themePackage?.assets || !themePackage?.metadata) {
    throw new Error('Invalid themePackage: expected metadata, templates, partials, and assets');
  }

  const fileMap = new Map();
  fileMap.set('theme.json', JSON.stringify({
    name: themePackage.metadata.name,
    namespace: themePackage.metadata.namespace,
    slug: themePackage.metadata.slug,
    version: themePackage.metadata.version,
    license: themePackage.metadata.license,
    runtime: themePackage.metadata.runtime,
    ...(themePackage.metadata.author ? { author: themePackage.metadata.author } : {}),
    ...(themePackage.metadata.description ? { description: themePackage.metadata.description } : {}),
    ...(themePackage.metadata.thumbnail ? { thumbnail: themePackage.metadata.thumbnail } : {}),
    ...(themePackage.metadata.features ? { features: themePackage.metadata.features } : {}),
    ...(themePackage.metadata.menuSlots ? { menuSlots: themePackage.metadata.menuSlots } : {}),
    ...(themePackage.metadata.widgetAreas ? { widgetAreas: themePackage.metadata.widgetAreas } : {}),
    ...(themePackage.metadata.siteMeta ? { siteMeta: themePackage.metadata.siteMeta } : {}),
    ...(themePackage.metadata.collectionSlots ? { collectionSlots: themePackage.metadata.collectionSlots } : {}),
  }));

  for (const [templateName, templateContent] of themePackage.templates.entries()) {
    fileMap.set(`${templateName}.html`, templateContent);
  }

  for (const [partialName, partialContent] of themePackage.partials.entries()) {
    fileMap.set(`partials/${partialName}.html`, partialContent);
  }

  for (const [assetPath, assetContent] of themePackage.assets.entries()) {
    fileMap.set(`assets/${assetPath}`, assetContent);
  }

  const validation = await validateThemeFiles(fileMap);
  if (!validation.ok) {
    throw new Error(`Theme validation failed: ${validation.errors[0]?.message || 'Unknown error'}`);
  }

  if (!validation.manifest) {
    throw new Error('Theme validation failed: normalized manifest not available');
  }

  return {
    metadata: normalizeThemePackageMetadata(themePackage.metadata, validation.manifest),
    templates: themePackage.templates,
    partials: themePackage.partials,
    assets: themePackage.assets,
  };
}

function normalizeThemePackageMetadata(sourceMetadata, manifest) {
  return {
    ...manifest,
    ...(sourceMetadata?.thumbnail ? { thumbnail: sourceMetadata.thumbnail } : {}),
  };
}

async function buildAssetOutputs(assets, assetProcessor, options) {
  const outputs = [];

  for (const [assetPath, content] of assets.entries()) {
    const ext = assetPath.split('.').pop()?.toLowerCase();
    let processedContent = content;
    let contentType = getContentType(assetPath);

    if (ext === 'css') {
      processedContent = await assetProcessor.processCSS(new TextDecoder().decode(content));
      contentType = 'text/css';
    } else if (ext === 'js') {
      processedContent = await assetProcessor.processJavaScript(new TextDecoder().decode(content));
      contentType = 'application/javascript';
    }

    const hash = options.assetHashing ? `.${assetProcessor.generateAssetHash(content)}` : '';
    const targetPath = `assets/${assetPath.replace(/(\.[^.]+)$/, `${hash}$1`)}`;

    outputs.push({
      originalPath: assetPath,
      path: targetPath,
      content: processedContent,
      contentType,
    });
  }

  return outputs;
}

async function buildCustomCssAsset(customCss, assetProcessor, options) {
  const content = normalizeOptionalString(customCss?.content);
  if (!content) {
    return null;
  }

  const sourceBuffer = new TextEncoder().encode(content);
  const processedContent = await assetProcessor.processCSS(content);
  const hash = options.assetHashing ? `.${assetProcessor.generateAssetHash(sourceBuffer)}` : '';

  return {
    originalPath: '__zeropress_custom.css',
    path: `assets/zeropress-custom${hash}.css`,
    content: processedContent,
    contentType: 'text/css',
  };
}

function createRenderContext(site, currentUrl) {
  return {
    site,
    currentUrl,
    language: site.locale,
  };
}

function buildRouteContext(type, url, options = {}) {
  return {
    type,
    is_front_page: options.isFrontPage === true,
    is_post_index: options.isPostIndex === true,
    path: url,
    url,
  };
}

function buildPageMeta(site, options = {}) {
  const resolvedTitle = normalizeNonEmptyString(options.title, site.title);
  const resolvedDescription = normalizeOptionalString(options.description);
  const canonicalUrl = resolveMetaCanonicalUrl(site, options.canonicalUrl || options.currentUrl);
  const ogImage = resolveMetaImageUrl(options.image);
  const ogType = normalizeNonEmptyString(options.ogType, 'website');
  const publishedTime = normalizeOptionalString(options.publishedTime);
  const modifiedTime = normalizeOptionalString(options.modifiedTime);

  const meta = {
    title: escapeHtml(resolvedTitle),
    description: resolvedDescription ? escapeHtml(resolvedDescription) : '',
    canonical_url: canonicalUrl ? escapeHtml(canonicalUrl) : '',
    og_title: escapeHtml(resolvedTitle),
    og_description: resolvedDescription ? escapeHtml(resolvedDescription) : '',
    og_type: escapeHtml(ogType),
    og_url: canonicalUrl ? escapeHtml(canonicalUrl) : '',
    og_site_name: escapeHtml(site.title),
    og_image: ogImage ? escapeHtml(ogImage) : '',
    article_published_time: publishedTime ? escapeHtml(publishedTime) : '',
    article_modified_time: modifiedTime ? escapeHtml(modifiedTime) : '',
  };

  return {
    ...meta,
    head_tags: buildMetaHeadTags(meta),
  };
}

function buildDocumentTitle(contentTitle, siteTitle) {
  const resolvedContentTitle = normalizeNonEmptyString(contentTitle, siteTitle);
  const resolvedSiteTitle = normalizeNonEmptyString(siteTitle, resolvedContentTitle);
  return `${resolvedContentTitle} - ${resolvedSiteTitle}`;
}

function buildMetaHeadTags(meta) {
  const tags = [];

  if (meta.description) {
    tags.push(`<meta name="description" content="${meta.description}">`);
  }
  if (meta.canonical_url) {
    tags.push(`<link rel="canonical" href="${meta.canonical_url}">`);
  }

  tags.push(`<meta property="og:title" content="${meta.og_title}">`);
  if (meta.og_description) {
    tags.push(`<meta property="og:description" content="${meta.og_description}">`);
  }
  tags.push(`<meta property="og:type" content="${meta.og_type}">`);
  if (meta.og_url) {
    tags.push(`<meta property="og:url" content="${meta.og_url}">`);
  }
  tags.push(`<meta property="og:site_name" content="${meta.og_site_name}">`);
  if (meta.og_image) {
    tags.push(`<meta property="og:image" content="${meta.og_image}">`);
  }
  if (meta.article_published_time) {
    tags.push(`<meta property="article:published_time" content="${meta.article_published_time}">`);
  }
  if (meta.article_modified_time) {
    tags.push(`<meta property="article:modified_time" content="${meta.article_modified_time}">`);
  }

  return tags.length ? `${tags.join('\n')}\n` : '';
}

function resolveMetaCanonicalUrl(site, currentUrl) {
  if (!hasCanonicalSiteUrl(site.url) || !normalizeOptionalString(currentUrl)) {
    return '';
  }

  return resolveSiteUrl(site.url, currentUrl);
}

function resolveMetaImageUrl(image) {
  const normalizedImage = normalizeOptionalString(image);
  if (!normalizedImage) {
    return '';
  }

  if (isAbsoluteUrl(normalizedImage)) {
    return normalizeAbsoluteUrl(normalizedImage, SAFE_MEDIA_PROTOCOLS);
  }

  return '';
}

function normalizeMediaField(value, mediaBaseUrl) {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return '';
  }

  if (isAbsoluteUrl(normalizedValue)) {
    return normalizeAbsoluteUrl(normalizedValue, SAFE_MEDIA_PROTOCOLS);
  }

  const normalizedBaseUrl = normalizeOptionalString(mediaBaseUrl);
  if (!normalizedBaseUrl) {
    return normalizedValue;
  }

  try {
    return decodeURI(new URL(normalizedValue, normalizedBaseUrl).toString());
  } catch {
    return '';
  }
}

function isAbsoluteUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeAbsoluteUrl(value, allowedProtocols) {
  try {
    const url = new URL(value);
    if (!allowedProtocols.has(url.protocol)) {
      return '';
    }
    return decodeURI(url.toString());
  } catch {
    return '';
  }
}

function normalizeThemeLinkUrl(value) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue || normalizedValue.startsWith('//')) {
    return '';
  }

  if (isAbsoluteUrl(normalizedValue)) {
    return normalizeAbsoluteUrl(normalizedValue, SAFE_LINK_PROTOCOLS);
  }

  return normalizedValue;
}

async function writeOutput(writer, summaries, path, content, contentType) {
  const rawPath = String(path || '');
  const normalizedPath = normalizeOutputPath(rawPath);
  assertSafeRelativeOutputPath(rawPath, normalizedPath);
  await writer.write({ path: normalizedPath, content, contentType });
  summaries.push({
    path: normalizedPath,
    contentType,
    size: getContentSize(content),
    sha256: sha256(content),
  });
}

function routePathToOutputPath(routePath, outputStyle = DEFAULT_PERMALINKS.output_style) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (normalizedPath === '/') {
    return 'index.html';
  }
  if (outputStyle === 'html-extension') {
    return `${normalizedPath.replace(/^\/+|\/+$/g, '')}.html`;
  }
  return `${normalizedPath.replace(/^\//, '')}index.html`;
}

function routePathToPublicUrl(routePath, outputStyle = DEFAULT_PERMALINKS.output_style) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (normalizedPath === '/') {
    return '/';
  }
  if (outputStyle === 'html-extension') {
    return normalizedPath.replace(/\/$/, '');
  }
  return normalizedPath;
}

function pagePathToPublicUrl(routePath, outputStyle = DEFAULT_PERMALINKS.output_style) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (outputStyle !== 'html-extension') {
    return routePathToPublicUrl(normalizedPath, outputStyle);
  }

  const withoutTrailingSlash = normalizedPath.replace(/\/$/, '');
  if (withoutTrailingSlash === '/index') {
    return '/';
  }
  if (withoutTrailingSlash.endsWith('/index')) {
    return `${withoutTrailingSlash.slice(0, -'/index'.length)}/`;
  }
  return withoutTrailingSlash;
}

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') {
    return '/';
  }
  const normalized = decodeRoutePath(String(routePath)).replace(/^\/+|\/+$/g, '');
  return `/${normalized}/`;
}

function resolvePagePermalink(site, page) {
  if (normalizeOptionalString(page.path)) {
    return buildRouteInfo(page.path, site.permalinks.output_style, { pagePath: true });
  }
  return resolvePermalink(site, 'pages', page);
}

function resolvePermalink(site, kind, item) {
  const pattern = normalizeNonEmptyString(site.permalinks?.[kind], DEFAULT_PERMALINKS[kind]);
  return buildRouteInfo(applyPermalinkPattern(pattern, kind, item, site), site.permalinks.output_style);
}

function buildRouteInfo(routePath, outputStyle, options = {}) {
  const path = normalizeRoutePath(routePath);
  return {
    path,
    url: options.pagePath ? pagePathToPublicUrl(path, outputStyle) : routePathToPublicUrl(path, outputStyle),
    outputPath: routePathToOutputPath(path, outputStyle),
  };
}

function pageToOutputPath(page, outputStyle) {
  return normalizeOptionalString(page.path)
    ? routePathToOutputPath(page.path, outputStyle)
    : routePathToOutputPath(page.url, outputStyle);
}

function applyPermalinkPattern(pattern, kind, item, site) {
  const tokenValues = buildPermalinkTokenValues(kind, item, site);
  const body = String(pattern || '').replace(/^\/+|\/+$/g, '');
  const segments = body.split('/').filter(Boolean).map((segment) => {
    if (segment.startsWith(':')) {
      return tokenValues[segment.slice(1)] || '';
    }
    return segment;
  });
  return `/${segments.join('/')}/`;
}

function buildPermalinkTokenValues(kind, item, site) {
  const values = {
    slug: encodeSlugSegment(item.slug),
  };

  if (kind === 'posts') {
    const parts = getPermalinkDateParts(item.published_at_iso, site);
    values.public_id = String(item.public_id);
    values.year = parts.year;
    values.month = parts.month;
    values.day = parts.day;
  }

  return values;
}

function getPermalinkDateParts(value, site) {
  const date = toDate(value);
  const timeZone = normalizeNonEmptyString(site.timezone, DEFAULT_TIMEZONE);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: parts.find((part) => part.type === 'year')?.value || String(date.getUTCFullYear()),
    month: parts.find((part) => part.type === 'month')?.value || String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: parts.find((part) => part.type === 'day')?.value || String(date.getUTCDate()).padStart(2, '0'),
  };
}

function normalizeOutputPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}

function assertPlannedOutputPathsSafe(state) {
  const outputStyle = state.previewData.site.permalinks.output_style;
  for (const post of state.renderData.posts) {
    assertSafeSlugDerivedOutputPath(post.slug, routePathToOutputPath(post.url, outputStyle));
  }

  for (const page of state.renderData.pages) {
    assertSafeSlugDerivedOutputPath(page.slug, pageToOutputPath(page, outputStyle));
  }

  for (const category of state.previewData.content.categories) {
    assertSafeSlugDerivedOutputPath(category.slug, resolvePermalink(state.previewData.site, 'categories', category).outputPath);
  }

  for (const tag of state.previewData.content.tags) {
    assertSafeSlugDerivedOutputPath(tag.slug, resolvePermalink(state.previewData.site, 'tags', tag).outputPath);
  }

  const routeEntries = [
    ...(state.renderData.frontPageRoute ? [{
      url: '/',
      outputPath: 'index.html',
    }] : []),
    ...state.renderData.indexRoutes.map((route) => ({
      url: routePathToPublicUrl(route.path, outputStyle),
      outputPath: routePathToOutputPath(route.path, outputStyle),
    })),
    ...state.renderData.archiveRoutes.map((route) => ({
      url: routePathToPublicUrl(route.path, outputStyle),
      outputPath: routePathToOutputPath(route.path, outputStyle),
    })),
    ...state.renderData.categoryRoutes.map((route) => ({
      url: routePathToPublicUrl(route.path, outputStyle),
      outputPath: routePathToOutputPath(route.path, outputStyle),
    })),
    ...state.renderData.tagRoutes.map((route) => ({
      url: routePathToPublicUrl(route.path, outputStyle),
      outputPath: routePathToOutputPath(route.path, outputStyle),
    })),
    ...state.renderData.posts.map((post) => ({
      url: post.url,
      outputPath: routePathToOutputPath(post.url, outputStyle),
    })),
    ...state.renderData.pages.map((page) => ({
      url: page.url,
      outputPath: pageToOutputPath(page, outputStyle),
    })),
  ];
  assertUniqueRoutes(routeEntries);

  const plannedPaths = [
    ...routeEntries.map((entry) => entry.outputPath),
    ...state.assetOutputs.map((assetOutput) => assetOutput.path),
    COMMENT_POLICY_OUTPUT_PATH,
  ];

  if (state.options.generateSpecialFiles) {
    plannedPaths.push('404.html');
    if (shouldGenerateRobotsTxt(state.options)) {
      plannedPaths.push('robots.txt');
    }
    if (hasCanonicalSiteUrl(state.previewData.site.url)) {
      plannedPaths.push('sitemap.xml', 'feed.xml');
    }
  }

  for (const plannedPath of plannedPaths) {
    const rawPath = String(plannedPath || '');
    const normalizedPath = normalizeOutputPath(rawPath);
    assertSafeRelativeOutputPath(rawPath, normalizedPath);
  }

  assertUniqueOutputPaths(plannedPaths);
}

function assertUniqueRoutes(routeEntries) {
  const seenUrls = new Map();
  for (const entry of routeEntries) {
    const normalizedUrl = normalizeRouteCollisionKey(entry.url);
    if (seenUrls.has(normalizedUrl)) {
      throw new Error(`Duplicate public URL detected: ${entry.url}`);
    }
    seenUrls.set(normalizedUrl, entry);
  }
}

function assertUniqueOutputPaths(plannedPaths) {
  const seenPaths = new Set();
  for (const plannedPath of plannedPaths) {
    const normalizedPath = normalizeOutputPath(plannedPath);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate output path detected: ${plannedPath}`);
    }
    seenPaths.add(normalizedPath);
  }
}

function normalizeRouteCollisionKey(url) {
  return String(url || '').replace(/\/+$/, '') || '/';
}

function assertSafeSlugDerivedOutputPath(rawSlug, outputPath) {
  const originalSlug = typeof rawSlug === 'string' ? rawSlug : '';
  const decodedSlug = encodeSlugSegment(rawSlug);

  if (
    !isSafeSlugPathSegment(originalSlug) ||
    !isSafeSlugPathSegment(decodedSlug)
  ) {
    throw new Error(`Unsafe output path detected: ${outputPath}`);
  }
}

function isSafeSlugPathSegment(value) {
  return isSafeSlugSegment(value);
}

function assertSafeRelativeOutputPath(rawPath, normalizedPath = normalizeOutputPath(rawPath)) {
  const originalPath = String(rawPath || '');
  const candidatePath = String(normalizedPath || '');
  const normalizedSeparators = candidatePath.replace(/\\/g, '/');

  if (originalPath.trim() === '' || candidatePath.trim() === '') {
    throw new Error(`Unsafe output path detected: ${originalPath || candidatePath || '<empty>'}`);
  }

  if (OUTPUT_PATH_CONTROL_CHAR_PATTERN.test(originalPath) || OUTPUT_PATH_CONTROL_CHAR_PATTERN.test(candidatePath)) {
    throw new Error(`Unsafe output path detected: ${originalPath}`);
  }

  if (candidatePath.includes('%')) {
    throw new Error(`Unsafe output path detected: ${originalPath}`);
  }

  if (
    originalPath.startsWith('/') ||
    originalPath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(originalPath) ||
    normalizedSeparators.startsWith('//')
  ) {
    throw new Error(`Unsafe output path detected: ${originalPath}`);
  }

  const segments = normalizedSeparators.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe output path detected: ${originalPath}`);
  }
}

function getContentSize(content) {
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
}

function sha256(content) {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

function injectSiteCustomizations(html, state) {
  let next = injectCustomCssAssetLink(html, state.customCssHref);
  next = injectCustomHtml(next, state.customHtml);
  return next;
}

function injectCustomCssAssetLink(html, href) {
  if (!normalizeOptionalString(href)) {
    return html;
  }

  return html.replace('</head>', `  <link rel="stylesheet" href="${escapeHtml(href)}">\n</head>`);
}

function injectCustomHtml(html, customHtml) {
  let next = html;
  const headEnd = normalizeOptionalRawString(customHtml?.head_end?.content);
  const bodyEnd = normalizeOptionalRawString(customHtml?.body_end?.content);

  if (headEnd) {
    next = next.replace('</head>', `${headEnd}\n</head>`);
  }
  if (bodyEnd) {
    next = next.replace('</body>', `${bodyEnd}\n</body>`);
  }

  return next;
}

function buildSitemapXml(site, emitted, generatedAt) {
  const entries = [
    ...(emitted.frontPage
      ? [{
        url: emitted.frontPage.url,
        changefreq: 'daily',
        priority: 1.0,
      }]
      : []),
    ...emitted.indexRoutes
      .filter((route) => route.page === 1)
      .map((route) => ({
        url: route.url,
        changefreq: 'daily',
        priority: route.url === '/' ? 1.0 : 0.7,
      })),
    ...emitted.posts.map((post) => ({
      url: post.url,
      lastmod: toDate(post.updatedAt),
      changefreq: 'weekly',
      priority: 0.8,
    })),
    ...emitted.pages
      .filter((page) => page.includeInSitemap !== false)
      .map((page) => ({
        url: page.url,
        changefreq: 'monthly',
        priority: 0.7,
      })),
  ];

  const body = entries.map((entry) => {
    const loc = escapeXml(resolveSiteUrl(site.url, entry.url));
    const lastmod = entry.lastmod
      ? `\n    <lastmod>${formatUtcIsoSeconds(entry.lastmod)}</lastmod>`
      : '';
    return `  <url>\n    <loc>${loc}</loc>${lastmod}\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority.toFixed(1)}</priority>\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

function buildFeedXml(site, emitted, generatedAt) {
  const channelLink = resolveSiteUrl(site.url, '/');
  const selfLink = resolveSiteUrl(site.url, '/feed.xml');
  const items = [...emitted.posts]
    .sort((a, b) => toDate(b.publishedAt).getTime() - toDate(a.publishedAt).getTime())
    .slice(0, 20)
    .map((post) => {
      const url = resolveSiteUrl(site.url, post.url);
      return `    <item>\n      <title>${escapeXml(post.title)}</title>\n      <link>${escapeXml(url)}</link>\n      <guid>${escapeXml(url)}</guid>\n      <pubDate>${toDate(post.publishedAt).toUTCString()}</pubDate>\n      <description>${escapeXml(post.description)}</description>\n    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(site.title)}</title>\n    <link>${escapeXml(channelLink)}</link>\n    <description>${escapeXml(site.description)}</description>\n    <language>${site.locale}</language>\n    <lastBuildDate>${generatedAt.toUTCString()}</lastBuildDate>\n    <atom:link href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>`;
}

function buildRobotsTxt(site) {
  const lines = ['User-agent: *'];
  if (site.indexing === false) {
    lines.push('Disallow: /');
    return `${lines.join('\n')}\n`;
  }

  lines.push('Allow: /');
  if (site.url) {
    lines.push('', `Sitemap: ${resolveSiteUrl(site.url, '/sitemap.xml')}`);
  }
  return `${lines.join('\n')}\n`;
}

function shouldGenerateRobotsTxt(options) {
  return options.generateSpecialFiles && options.generateRobotsTxt !== false;
}

function getContentType(assetPath) {
  const ext = assetPath.split('.').pop()?.toLowerCase();
  const contentTypes = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
  };
  return contentTypes[ext || ''] || 'application/octet-stream';
}

function encodeSlugSegment(slug) {
  return normalizeStoredSlug(slug);
}

function decodeRoutePath(routePath) {
  try {
    return decodeURI(routePath);
  } catch {
    return routePath;
  }
}

function resolveSiteUrl(siteUrl, relativePath) {
  if (!siteUrl) {
    return normalizeRoutePath(relativePath);
  }

  return decodeURI(new URL(relativePath, siteUrl).toString());
}

function hasCanonicalSiteUrl(siteUrl) {
  return typeof siteUrl === 'string' && siteUrl.trim() !== '';
}

function toDate(value) {
  return value ? new Date(value) : new Date();
}

function formatUtcIsoSeconds(value) {
  return toDate(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeIsoTimestamp(value) {
  return value ? formatUtcIsoSeconds(value) : '';
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clampInteger(value, fallback, min, max) {
  const normalized = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function normalizeLinkTarget(value) {
  return value === '_blank' ? '_blank' : '_self';
}
