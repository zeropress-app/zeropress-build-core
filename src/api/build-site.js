import { createHash } from 'node:crypto';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import { isSafeSlugSegment, normalizeStoredSlug } from '@zeropress/slug-policy';
import { validateThemeFiles } from '@zeropress/theme-validator';
import { AssetProcessor } from '../assets/asset-processor.js';
import { renderDocument, renderDocumentContent } from '../render/content-renderer.js';
import { extractHtmlText } from '../render/html-text.js';
import { createThemeValidationError } from '../theme/format-theme-validation.js';
import { ZeroPressEngine } from '../render/zeropress-engine.js';

const DEFAULT_OPTIONS = {
  assetHashing: true,
  generateFeed: true,
  generateRobotsTxt: true,
};

const DEFAULT_POSTS_PER_PAGE = 10;
const DEFAULT_DATE_STYLE = 'medium';
const DEFAULT_TIME_STYLE = 'none';
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LOCALE = 'en-US';
const DEFAULT_COMMENTS_PROVIDER = 'zeropress';
const DEFAULT_COMMENTS_PER_PAGE = 50;
const DEFAULT_COMMENTS_ORDER = 'desc';
const DEFAULT_COMMENTS_THREADING_ENABLED = true;
const DEFAULT_COMMENTS_THREADING_MAX_DEPTH = 2;
const DATETIME_STYLES = new Set(['none', 'short', 'medium', 'long', 'full']);
const COMMENTS_PROVIDERS = new Set(['zeropress', 'wordpress']);
const COMMENTS_ORDERS = new Set(['asc', 'desc']);
const DISABLED_COMMENTS_CONTEXT = Object.freeze({ enabled: false });
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
const SEARCH_INDEX_OUTPUT_PATH = '_zeropress/search.json';
const SEARCH_ADAPTER_OUTPUT_PATH = '_zeropress/search.js';
const SEARCH_PAGEFIND_ADAPTER_OUTPUT_PATH = '_zeropress/search_pagefind.js';
const OUTPUT_PATH_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const SAFE_MEDIA_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);
const MEDIA_DELIVERY_MODES = new Set(['none', 'media_domain']);
const DISCOVERABILITY_VALUES = new Set(['default', 'noindex', 'delist']);
const CUSTOM_HTML_SLOT_MAX_CODE_POINTS = 65_536;
const GENERATED_SUMMARY_MAX_CODE_POINTS = 160;
const HEAD_CLOSING_TAG_PATTERN = /<\/head\s*>/i;
const BODY_CLOSING_TAG_PATTERN = /<\/body\s*>/i;
const RESPONSIVE_IMAGE_WIDTHS = [320, 480, 768, 1024, 1280, 1600, 1920];
const RESPONSIVE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);
const SEARCH_FIELD_WEIGHTS = Object.freeze({
  title: 5,
  headings: 3,
  tags: 2.5,
  categories: 2,
  excerpt: 1.5,
  content_text: 1,
});
const SEARCH_RECENCY_BOOST_MAX = 0.15;
const RFC3339_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)(60|[0-5]\d)(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
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

  if (shouldGenerateSearchArtifacts(state)) {
    await writeOutput(state.writer, state.summaries, SEARCH_INDEX_OUTPUT_PATH, buildSearchIndexJson(state), 'application/json');
    await writeOutput(state.writer, state.summaries, SEARCH_ADAPTER_OUTPUT_PATH, buildSearchAdapterJs(state.previewData.site.locale), 'application/javascript');
    await writeOutput(state.writer, state.summaries, SEARCH_PAGEFIND_ADAPTER_OUTPUT_PATH, buildSearchPagefindAdapterJs(), 'application/javascript');
  }

  await maybeRenderNotFoundPage(state);
  if (hasCanonicalSiteUrl(state.previewData.site.url)) {
    await writeOutput(
      state.writer,
      state.summaries,
      'sitemap.xml',
      buildSitemapXml(state.previewData.site, state.emitted, options.sitemapStylesheetHref),
      'application/xml',
    );
    if (shouldGenerateFeed(state)) {
      await writeOutput(state.writer, state.summaries, 'feed.xml', buildFeedXml(state.previewData.site, state.emitted, state.feedGeneratedAt), 'application/rss+xml');
    }
  }
  if (shouldGenerateRobotsTxt(options)) {
    await writeOutput(state.writer, state.summaries, 'robots.txt', buildRobotsTxt(state.previewData.site), 'text/plain');
  }

  return {
    files: state.summaries,
  };
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
  const previewData = normalizePreviewData(input.previewData, options);
  const renderData = createRenderData(previewData, themePackage, options);

  engine.initialize(themePackage);

  const assetOutputs = buildAssetOutputs(themePackage.assets, assetProcessor, options);
  const customCssAsset = buildCustomCssAsset(previewData.custom_css, assetProcessor, options);
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
    favicon: previewData.site.favicon,
    exposeGenerator: previewData.site.expose_generator !== false,
    options,
    feedGeneratedAt: toDate(previewData.generated_at),
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

async function renderRoute(state, templateName, route) {
  const currentUrl = routePathToPublicUrl(route.path, state.previewData.site.permalinks.output_style);
  const outputPath = routePathToOutputPath(route.path, state.previewData.site.permalinks.output_style);
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
        title: route.is_front_page === true
          ? buildFrontPageTitle(state.previewData.site)
          : state.previewData.site.title,
        description: state.previewData.site.description,
        ogType: 'website',
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state, {
    route: currentUrl,
    outputPath,
  });
  await writeOutput(state.writer, state.summaries, outputPath, html, 'text/html');
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
    const description = page.summary || state.previewData.site.description;
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
          title: buildFrontPageTitle(state.previewData.site),
          description,
          ogType: 'website',
          image: page.featured_image,
          robotsNoindex: shouldNoindexDocument(page),
        }),
      },
      createRenderContext(
        state.previewData.site,
        currentUrl,
        getTargetCommentsContext(state, 'page', state.renderData.pageReferencePathByPage.get(route.page)),
      ),
    );
    html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
    html = injectSiteCustomizations(html, state, {
      route: currentUrl,
      outputPath: 'index.html',
    });
    await writeOutput(state.writer, state.summaries, 'index.html', html, 'text/html');
    state.emitted.frontPage = {
      url: currentUrl,
      title: page.title,
      description,
      updatedAt: page.updated_at_iso,
      includeInFeed: false,
      includeInSitemap: !isDelistedDocument(page),
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
        title: buildFrontPageTitle(state.previewData.site),
        description: state.previewData.site.description,
        ogType: 'website',
      }),
    },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state, {
    route: currentUrl,
    outputPath: 'index.html',
  });
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
  const outputPath = routePathToOutputPath(post.url, state.previewData.site.permalinks.output_style);
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
        description: post.summary,
        ogType: 'article',
        image: post.featured_image,
        publishedTime: post.published_at_iso,
        modifiedTime: post.updated_at_iso,
        robotsNoindex: shouldNoindexDocument(post),
      }),
    },
    createRenderContext(
      state.previewData.site,
      currentUrl,
      getTargetCommentsContext(state, 'post', post.slug),
    ),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state, {
    route: currentUrl,
    outputPath,
  });
  await writeOutput(state.writer, state.summaries, outputPath, html, 'text/html');
  if (!isDelistedDocument(post)) {
    state.emitted.posts.push({
      url: currentUrl,
      title: post.title,
      description: post.summary,
      publishedAt: post.published_at_iso,
      updatedAt: post.updated_at_iso,
      status: post.status,
    });
  }
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
        description: page.summary,
        ogType: 'website',
        image: page.featured_image,
        robotsNoindex: shouldNoindexDocument(page),
      }),
    },
    createRenderContext(
      state.previewData.site,
      currentUrl,
      getTargetCommentsContext(state, 'page', state.renderData.pageReferencePathByPage.get(page)),
    ),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state, {
    route: currentUrl,
    outputPath,
  });
  await writeOutput(state.writer, state.summaries, outputPath, html, 'text/html');
  state.emitted.pages.push({
    url: currentUrl,
    title: page.title,
    description: page.summary,
    updatedAt: page.updated_at_iso,
    status: page.status,
    includeInSitemap: page.omit_from_sitemap !== true && !isDelistedDocument(page),
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
        title: buildDocumentTitle('Page Not Found', state.previewData.site.title),
        robotsNoindex: true,
        includeRichMetadata: false,
        includeFeedLink: false,
      }),
    },
    createRenderContext(state.previewData.site, '/404.html'),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  html = injectSiteCustomizations(html, state, {
    route: '/404.html',
    outputPath: '404.html',
  });
  await writeOutput(state.writer, state.summaries, '404.html', html, 'text/html');
}

function normalizePreviewData(previewData, options = {}) {
  const media_origin = normalizeMediaOrigin(previewData.site.media_origin);
  const mediaDeliveryMode = MEDIA_DELIVERY_MODES.has(previewData.site.media_delivery_mode)
    ? previewData.site.media_delivery_mode
    : 'none';
  if (mediaDeliveryMode === 'media_domain' && !media_origin) {
    throw new Error('Invalid preview-data: site.media_origin must be a non-empty HTTP(S) origin when site.media_delivery_mode is "media_domain".');
  }
  const {
    search: siteSearch,
    feed: siteFeed,
    archive: siteArchive,
    comments: siteComments,
    robots: siteRobots,
    ...siteFields
  } = previewData.site;
  const normalizedComments = normalizeSiteComments(siteComments);
  const normalizedSite = {
    ...siteFields,
    url: normalizeSiteOrigin(previewData.site.url),
    media_origin,
    media_delivery_mode: mediaDeliveryMode,
    favicon: previewData.site.favicon
      ? normalizeSiteFavicon(previewData.site.favicon, media_origin)
      : normalizeSiteFavicon(options.favicon, ''),
    logo: normalizeSiteLogo(previewData.site.logo, media_origin),
    newsletter: normalizeSiteNewsletter(previewData.site.newsletter),
    posts_per_page: Number.isInteger(previewData.site.posts_per_page) && previewData.site.posts_per_page > 0
      ? previewData.site.posts_per_page
      : DEFAULT_POSTS_PER_PAGE,
    date_style: DATETIME_STYLES.has(previewData.site.date_style)
      ? previewData.site.date_style
      : DEFAULT_DATE_STYLE,
    time_style: DATETIME_STYLES.has(previewData.site.time_style)
      ? previewData.site.time_style
      : DEFAULT_TIME_STYLE,
    timezone: normalizeTimezone(previewData.site.timezone),
    locale: normalizeLocale(previewData.site.locale),
    expose_generator: previewData.site.expose_generator !== false,
    search: normalizeRequestedFeatureState(siteSearch),
    feed: normalizeRequestedFeatureState(siteFeed),
    archive: normalizeRequestedFeatureState(siteArchive),
    robots: {
      allow_indexing: siteRobots?.allow_indexing !== false,
    },
    permalinks: normalizePermalinks(previewData.site.permalinks),
    front_page: normalizeFrontPage(previewData.site.front_page),
    post_index: normalizePostIndex(previewData.site.post_index),
    footer: normalizeSiteFooter(previewData.site.footer),
    ...(normalizedComments ? { comments: normalizedComments } : {}),
  };
  const media = normalizeContentMedia(previewData.content.media, normalizedSite);
  const mediaRegistry = buildMediaRegistry(media);

  return {
    ...previewData,
    site: normalizedSite,
    menus: normalizeMenus(previewData.menus),
    collections: normalizeCollections(previewData.collections),
    widgets: normalizeWidgetAreas(previewData.widgets, normalizedSite.media_origin),
    custom_css: normalizeCustomCss(previewData.custom_css),
    custom_html: normalizeCustomHtml(previewData.custom_html),
    content: {
      ...previewData.content,
      authors: previewData.content.authors.map((author) => {
        const avatar = normalizeMediaField(author.avatar, normalizedSite.media_origin);
        const avatarMedia = deriveManagedMedia(avatar, mediaRegistry, normalizedSite);
        return {
          ...author,
          avatar,
          ...(avatarMedia ? { avatar_media: avatarMedia } : {}),
        };
      }),
      posts: previewData.content.posts
        .map((post) => {
          const { comments, ...postFields } = post;
          const normalizedPostComments = normalizeTargetComments(comments);
          const featuredImage = normalizeMediaField(post.featured_image, normalizedSite.media_origin);
          const featuredMedia = deriveManagedMedia(featuredImage, mediaRegistry, normalizedSite);
          return {
            ...postFields,
            published_at_iso: normalizeIsoTimestamp(post.published_at_iso),
            updated_at_iso: normalizeIsoTimestamp(post.updated_at_iso),
            allow_comments: post.allow_comments === true,
            discoverability: normalizeDiscoverability(post.discoverability),
            featured_image: featuredImage,
            ...(featuredMedia ? { featured_media: featuredMedia } : {}),
            ...(normalizedPostComments ? { comments: normalizedPostComments } : {}),
          };
        })
        .sort((left, right) => toDate(right.published_at_iso).getTime() - toDate(left.published_at_iso).getTime()),
      pages: previewData.content.pages.map((page) => {
        const { comments, ...pageFields } = page;
        const normalizedPageComments = normalizeTargetComments(comments);
        const featuredImage = normalizeMediaField(page.featured_image, normalizedSite.media_origin);
        const featuredMedia = deriveManagedMedia(featuredImage, mediaRegistry, normalizedSite);
        return {
          ...pageFields,
          ...(page.updated_at_iso ? { updated_at_iso: normalizeIsoTimestamp(page.updated_at_iso) } : {}),
          allow_comments: page.allow_comments === true,
          discoverability: normalizeDiscoverability(page.discoverability),
          featured_image: featuredImage,
          ...(featuredMedia ? { featured_media: featuredMedia } : {}),
          ...(normalizedPageComments ? { comments: normalizedPageComments } : {}),
        };
      }),
      categories: [...previewData.content.categories],
      tags: [...previewData.content.tags],
      media,
    },
  };
}

function normalizeRecordMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function normalizeMenus(menus) {
  const normalized = normalizeRecordMap(menus);
  return Object.fromEntries(Object.entries(normalized).map(([menuId, menu]) => [
    menuId,
    {
      ...menu,
      items: Array.isArray(menu?.items)
        ? menu.items.map((item) => ({
            ...item,
            url: normalizeNavigationUrl(item?.url),
          }))
        : [],
    },
  ]));
}

function normalizeDiscoverability(value) {
  return DISCOVERABILITY_VALUES.has(value) ? value : 'default';
}

function isDelistedDocument(document) {
  return document?.discoverability === 'delist';
}

function shouldNoindexDocument(document) {
  return document?.discoverability === 'noindex' || document?.discoverability === 'delist';
}

function normalizeContentMedia(mediaItems, site) {
  if (!Array.isArray(mediaItems)) {
    return [];
  }

  return mediaItems
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const src = normalizeMediaField(item.src, site.media_origin);
      const width = Number.isInteger(item.width) && item.width > 0 ? item.width : 0;
      const height = Number.isInteger(item.height) && item.height > 0 ? item.height : 0;
      if (!src || !width || !height) {
        return null;
      }
      return {
        src,
        width,
        height,
        alt: typeof item.alt === 'string' ? item.alt : '',
      };
    })
    .filter(Boolean);
}

function buildMediaRegistry(mediaItems) {
  const registry = new Map();
  for (const item of mediaItems) {
    if (!registry.has(item.src)) {
      registry.set(item.src, item);
    }
  }
  return registry;
}

function deriveManagedMedia(src, mediaRegistry, site) {
  const normalizedSrc = normalizeOptionalString(src);
  if (!normalizedSrc) {
    return null;
  }
  const media = mediaRegistry.get(normalizedSrc);
  if (!media) {
    return null;
  }
  return {
    ...media,
    srcset: buildResponsiveImageSrcset(media, site),
  };
}

function buildResponsiveImageSrcset(media, site) {
  if (site.media_delivery_mode !== 'media_domain') {
    return '';
  }

  const media_origin = normalizeMediaOrigin(site.media_origin);
  if (!media_origin || !isUrlAtMediaOrigin(media.src, media_origin) || !isResponsiveRasterImage(media.src)) {
    return '';
  }

  const widths = RESPONSIVE_IMAGE_WIDTHS.filter((width) => width <= media.width);
  if (!widths.includes(media.width)) {
    widths.push(media.width);
  }

  return widths
    .filter((width, index, values) => width > 0 && values.indexOf(width) === index)
    .map((width) => `${buildResponsiveImageVariantUrl(media.src, width)} ${width}w`)
    .join(', ');
}

function buildResponsiveImageVariantUrl(src, width) {
  try {
    const url = new URL(src);
    url.searchParams.set('w', String(width));
    url.searchParams.set('fit', 'scale-down');
    url.searchParams.set('format', 'auto');
    return decodeURI(url.toString());
  } catch {
    return src;
  }
}

function isUrlAtMediaOrigin(src, media_origin) {
  try {
    const sourceUrl = new URL(src);
    return sourceUrl.origin === media_origin;
  } catch {
    return false;
  }
}

function isResponsiveRasterImage(src) {
  try {
    const url = new URL(src);
    const lastSegment = url.pathname.split('/').pop() || '';
    const extension = lastSegment.includes('.') ? lastSegment.split('.').pop().toLowerCase() : '';
    return RESPONSIVE_IMAGE_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
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

function normalizeWidgetAreas(widget_areas, media_origin) {
  if (!widget_areas || typeof widget_areas !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(widget_areas).map(([widgetAreaId, widgetArea]) => [
      widgetAreaId,
      {
        ...widgetArea,
        name: normalizeNonEmptyString(widgetArea?.name, widgetAreaId),
        items: Array.isArray(widgetArea?.items)
          ? widgetArea.items.map((item) => normalizeWidgetItem(item, media_origin))
          : [],
      },
    ]),
  );
}

function normalizeSiteFooter(footer) {
  const source = footer && typeof footer === 'object' && !Array.isArray(footer) ? footer : {};

  return {
    ...source,
    copyright_text: normalizeOptionalString(source.copyright_text),
    attribution: source.attribution !== false,
  };
}

function normalizeWidgetItem(item, media_origin) {
  const normalizedItem = {
    ...item,
    title: typeof item?.title === 'string' ? item.title.trim() : '',
  };

  if (item?.type === 'profile' && item?.settings && typeof item.settings === 'object') {
    return {
      ...normalizedItem,
      settings: {
        ...item.settings,
        avatar: normalizeMediaField(item.settings.avatar, media_origin),
      },
    };
  }

  return normalizedItem;
}

function normalizeCustomCss(customCss) {
  const content = customCss?.content;
  return typeof content === 'string' && content.trim() ? { content } : undefined;
}

function normalizeCustomHtml(customHtml) {
  if (!customHtml || typeof customHtml !== 'object' || Array.isArray(customHtml)) {
    return undefined;
  }

  const headEnd = normalizeCustomHtmlSlot(customHtml.head_end);
  const bodyEnd = normalizeCustomHtmlSlot(customHtml.body_end);
  if (!headEnd && !bodyEnd) {
    return undefined;
  }

  return {
    ...(headEnd ? { head_end: headEnd } : {}),
    ...(bodyEnd ? { body_end: bodyEnd } : {}),
  };
}

function normalizeCustomHtmlSlot(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  return [...value].length <= CUSTOM_HTML_SLOT_MAX_CODE_POINTS ? value : '';
}

function normalizeSiteFavicon(favicon, media_origin) {
  if (!favicon || typeof favicon !== 'object') {
    return undefined;
  }

  const normalized = {};
  for (const key of ['icon', 'icon_dark', 'svg', 'png', 'apple_touch_icon']) {
    const value = normalizeOptionalString(favicon[key]);
    if (value) {
      normalized[key] = normalizeMediaField(value, media_origin);
    }
  }

  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeSiteLogo(logo, media_origin) {
  if (!logo || typeof logo !== 'object') {
    return undefined;
  }

  const src = normalizeMediaField(logo.src, media_origin);
  if (!src) {
    return undefined;
  }

  const alt = normalizeOptionalString(logo.alt);
  return {
    src,
    ...(alt ? { alt } : {}),
  };
}

function normalizeSiteNewsletter(newsletter) {
  if (!newsletter || typeof newsletter !== 'object' || Array.isArray(newsletter)) {
    return undefined;
  }

  const title = normalizeOptionalString(newsletter.title);
  const description = normalizeOptionalString(newsletter.description);
  const buttonLabel = normalizeOptionalString(newsletter.button_label);
  const signupUrl = normalizeNavigationUrl(newsletter.signup_url);
  const embedUrl = normalizeNavigationUrl(newsletter.embed_url);

  return {
    enabled: newsletter.enabled === true,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(buttonLabel ? { button_label: buttonLabel } : {}),
    ...(signupUrl ? { signup_url: signupUrl } : {}),
    ...(embedUrl ? { embed_url: embedUrl } : {}),
  };
}

function normalizeSiteComments(comments) {
  if (!comments || typeof comments !== 'object' || Array.isArray(comments)) {
    return undefined;
  }

  const apiBaseUrl = normalizeCommentsApiBaseUrl(comments.api_base_url);
  if (!apiBaseUrl) {
    return undefined;
  }

  const threading = comments.threading && typeof comments.threading === 'object' && !Array.isArray(comments.threading)
    ? comments.threading
    : {};

  return {
    enabled: comments.enabled === true,
    provider: COMMENTS_PROVIDERS.has(comments.provider)
      ? comments.provider
      : DEFAULT_COMMENTS_PROVIDER,
    api_base_url: apiBaseUrl,
    per_page: Number.isInteger(comments.per_page) && comments.per_page >= 1 && comments.per_page <= 100
      ? comments.per_page
      : DEFAULT_COMMENTS_PER_PAGE,
    order: COMMENTS_ORDERS.has(comments.order)
      ? comments.order
      : DEFAULT_COMMENTS_ORDER,
    threading: {
      enabled: typeof threading.enabled === 'boolean'
        ? threading.enabled
        : DEFAULT_COMMENTS_THREADING_ENABLED,
      max_depth: Number.isInteger(threading.max_depth) && threading.max_depth >= 2 && threading.max_depth <= 10
        ? threading.max_depth
        : DEFAULT_COMMENTS_THREADING_MAX_DEPTH,
    },
  };
}

function normalizeRequestedFeatureState(value) {
  return {
    enabled: value?.enabled !== false,
  };
}

function normalizeCommentsApiBaseUrl(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized === '/') {
    return normalized;
  }
  return trimSlashes(normalized, { leading: false });
}

function normalizeTargetComments(comments) {
  if (!comments || typeof comments !== 'object' || Array.isArray(comments)) {
    return undefined;
  }

  const requestToken = preserveOpaqueNonBlankString(comments.request_token);
  return requestToken ? { request_token: requestToken } : undefined;
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
    ...(type === 'page' ? { page_path: normalizePageReferencePath(frontPage.page_path) } : {}),
    ...(type === 'standalone_html' ? { html: normalizeOptionalRawString(frontPage.html) } : {}),
  };
}

function normalizePostIndex(post_index) {
  if (!post_index || typeof post_index !== 'object') {
    return { ...DEFAULT_POST_INDEX };
  }

  return {
    enabled: post_index.enabled !== false,
    path: normalizeNonEmptyString(post_index.path, DEFAULT_POST_INDEX.path),
    paginate: post_index.paginate !== false,
  };
}

function createRenderData(previewData, themePackage = {}, options = {}) {
  const themeMetadata = themePackage.metadata || {};
  const themeSupportsComments = themeMetadata?.features?.comments === true;
  const themeSupportsPostIndex = themeMetadata?.features?.post_index !== false;
  const themeSupportsSearch = themeMetadata?.features?.search === true;
  const outputStyle = previewData.site.permalinks.output_style;
  const requestedComments = previewData.site.comments;
  previewData.site.search = {
    enabled: previewData.site.search.enabled === true && themeSupportsSearch,
  };
  previewData.site.feed = previewData.site.feed.enabled === true
    && hasCanonicalSiteUrl(previewData.site.url)
    && options.generateFeed !== false
    ? { enabled: true, url: '/feed.xml' }
    : { enabled: false };
  previewData.site.archive = previewData.site.archive.enabled === true
    && themePackage.templates?.has('archive') === true
    ? {
        enabled: true,
        url: outputStyle === 'html-extension' ? '/archive' : '/archive/',
      }
    : { enabled: false };
  previewData.site.comments = requestedComments?.enabled === true && themeSupportsComments
    ? { ...requestedComments, enabled: true }
    : { enabled: false };
  const authorsById = new Map(previewData.content.authors.map((author) => [author.id, author]));
  const categoriesBySlug = new Map(previewData.content.categories.map((category) => [category.slug, category]));
  const tagsBySlug = new Map(previewData.content.tags.map((tag) => [tag.slug, tag]));
  const categoryPostsBySlug = new Map();
  const tagPostsBySlug = new Map();
  const categoryCountBySlug = new Map();
  const tagCountBySlug = new Map();
  const discoverableSourcePosts = previewData.content.posts.filter((post) => !isDelistedDocument(post));

  for (const post of discoverableSourcePosts) {
    for (const slug of post.category_slugs) {
      pushToSlugMap(categoryPostsBySlug, slug, post);
      categoryCountBySlug.set(slug, (categoryCountBySlug.get(slug) || 0) + 1);
    }

    for (const slug of post.tag_slugs) {
      pushToSlugMap(tagPostsBySlug, slug, post);
      tagCountBySlug.set(slug, (tagCountBySlug.get(slug) || 0) + 1);
    }
  }

  const rawPageReferencePaths = new Map(previewData.content.pages.map((page) => [
    page,
    resolveEffectivePageReferencePath(previewData.site, page),
  ]));
  assertUniquePageReferencePaths(rawPageReferencePaths);
  const commentsByTarget = {
    posts: new Map(previewData.content.posts.map((post) => [
      post.slug,
      buildTargetCommentsContext({
        site: previewData.site,
        target: post,
        targetType: 'post',
        themeSupportsComments,
      }),
    ])),
    pages: new Map(previewData.content.pages.map((page) => [
      rawPageReferencePaths.get(page),
      buildTargetCommentsContext({
        site: previewData.site,
        target: page,
        targetType: 'page',
        themeSupportsComments,
      }),
    ])),
  };
  for (const target of previewData.content.posts) {
    delete target.comments;
  }
  for (const target of previewData.content.pages) {
    delete target.comments;
  }
  const preparedPosts = previewData.content.posts.map((post) => preparePost(post, previewData.site, authorsById, categoriesBySlug, tagsBySlug));
  const discoverablePreparedPosts = preparedPosts.filter((post) => !isDelistedDocument(post));
  const adjacentPostsBySlug = new Map(
    discoverablePreparedPosts.map((post, index) => [post.slug, {
      prev: index > 0 ? buildAdjacentPostSummary(discoverablePreparedPosts[index - 1]) : null,
      next: index < discoverablePreparedPosts.length - 1 ? buildAdjacentPostSummary(discoverablePreparedPosts[index + 1]) : null,
    }]),
  );
  const posts = preparedPosts.map((post) => ({
    ...post,
    prev: adjacentPostsBySlug.get(post.slug)?.prev || null,
    next: adjacentPostsBySlug.get(post.slug)?.next || null,
  }));
  const pages = previewData.content.pages.map((page) => preparePage(page, previewData.site));
  const pageReferencePathByPage = new Map(pages.map((page, index) => [
    page,
    rawPageReferencePaths.get(previewData.content.pages[index]),
  ]));
  const postBySlug = new Map(posts.map((post) => [post.slug, post]));
  const pageByPath = new Map(pages.map((page) => [pageReferencePathByPage.get(page), page]));
  const frontPage = previewData.site.front_page;
  const collectionTargetByItem = new WeakMap();
  const collections = resolveCollections(
    previewData.collections,
    postBySlug,
    pageByPath,
    frontPage,
    pageReferencePathByPage,
    collectionTargetByItem,
  );
  attachCollectionCursors(collections, collectionTargetByItem);
  const post_index = previewData.site.post_index;
  const effectivePostIndexEnabled = post_index.enabled !== false && themeSupportsPostIndex;
  const effectivePostIndexPaginate = effectivePostIndexEnabled && post_index.paginate !== false;
  const post_indexBasePath = normalizeRoutePath(post_index.path || DEFAULT_POST_INDEX.path);
  previewData.site.post_index = {
    ...post_index,
    enabled: effectivePostIndexEnabled,
    paginate: effectivePostIndexPaginate,
  };

  if (frontPage.type !== 'theme_index' && effectivePostIndexEnabled && post_indexBasePath === '/') {
    throw new Error('Invalid front page configuration: site.front_page occupies "/" so site.post_index.path must not be "/". Set site.post_index.path to a non-root path or disable site.post_index.');
  }

  const frontPageRoute = buildFrontPageRoute(frontPage, pageByPath, effectivePostIndexEnabled, post_indexBasePath);
  const frontPagePage = frontPageRoute?.front_page_type === 'page' ? frontPageRoute.page : null;
  const preparedPages = frontPagePage
    ? pages.filter((page) => page !== frontPagePage)
    : pages;

  return {
    posts,
    pages: preparedPages,
    postBySlug,
    pageByPath,
    pageReferencePathByPage,
    commentsByTarget,
    collections,
    taxonomies: buildGlobalTaxonomies(previewData, categoryCountBySlug, tagCountBySlug),
    frontPageRoute,
    indexRoutes: buildPostIndexRoutes({
      enabled: effectivePostIndexEnabled,
      paginate: effectivePostIndexPaginate,
      items: discoverableSourcePosts,
      posts_per_page: previewData.site.posts_per_page,
      basePath: post_indexBasePath,
      outputStyle: previewData.site.permalinks.output_style,
      postBySlug,
      frontPage,
    }),
    archiveRoutes: previewData.site.archive.enabled
      ? buildPaginatedCollection({
          items: discoverableSourcePosts,
          posts_per_page: previewData.site.posts_per_page,
          basePath: '/archive/',
          outputStyle: previewData.site.permalinks.output_style,
        }).map((entry) => ({
          path: entry.path,
          page: entry.page,
          totalPages: entry.totalPages,
          archive: {
            groups: buildArchiveGroups(entry.items, postBySlug, previewData.site),
          },
          pagination: buildStructuredPagination(entry.paginationData),
        }))
      : [],
    categoryRoutes: buildTaxonomyRoutes({
      items: previewData.content.categories,
      postsBySlug: categoryPostsBySlug,
      postBySlug,
      posts_per_page: previewData.site.posts_per_page,
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
      posts_per_page: previewData.site.posts_per_page,
      outputStyle: previewData.site.permalinks.output_style,
      buildBasePath: (tag) => resolvePermalink(previewData.site, 'tags', tag).path,
      renderExtras: (tag) => ({
        taxonomy: buildTaxonomyRouteData('tag', tag, tagCountBySlug),
      }),
    }),
  };
}

export function buildTargetCommentsContext({ site, target, targetType, themeSupportsComments }) {
  const targetPublicId = target?.public_id;
  const comments = site?.comments;

  if (
    themeSupportsComments !== true ||
    comments?.enabled !== true ||
    target?.allow_comments !== true ||
    !Number.isInteger(targetPublicId) ||
    targetPublicId <= 0
  ) {
    return DISABLED_COMMENTS_CONTEXT;
  }

  const common = {
    enabled: true,
    target_type: targetType,
    target_public_id: targetPublicId,
    provider: comments.provider,
    api_base_url: comments.api_base_url,
    per_page: comments.per_page,
    order: comments.order,
    threading: {
      enabled: comments.threading.enabled,
      max_depth: comments.threading.max_depth,
    },
  };

  if (comments.provider === 'wordpress') {
    return common;
  }

  if (comments.provider !== 'zeropress') {
    return DISABLED_COMMENTS_CONTEXT;
  }

  const requestToken = preserveOpaqueNonBlankString(target?.comments?.request_token);
  return requestToken
    ? { ...common, request_token: requestToken }
    : DISABLED_COMMENTS_CONTEXT;
}

function getTargetCommentsContext(state, targetType, slug) {
  const targetMap = targetType === 'post'
    ? state.renderData.commentsByTarget.posts
    : state.renderData.commentsByTarget.pages;
  return targetMap.get(slug) || DISABLED_COMMENTS_CONTEXT;
}

function buildGlobalTaxonomies(previewData, categoryCountBySlug, tagCountBySlug) {
  return {
    categories: buildGlobalTaxonomyItems(previewData.site, 'categories', previewData.content.categories, categoryCountBySlug),
    tags: buildGlobalTaxonomyItems(previewData.site, 'tags', previewData.content.tags, tagCountBySlug),
  };
}

function resolveCollections(collections, postBySlug, pageByPath, frontPage, pageReferencePathByPage, collectionTargetByItem) {
  if (!collections || typeof collections !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(collections).map(([collectionId, collection]) => {
      const items = resolveCollectionItems(
        collectionId,
        collection?.items,
        postBySlug,
        pageByPath,
        frontPage,
        pageReferencePathByPage,
        collectionTargetByItem,
      );
      return [
        collectionId,
        {
          id: collectionId,
          title: normalizeOptionalString(collection?.title),
          description: normalizeOptionalString(collection?.description),
          count: items.length,
          items,
        },
      ];
    }),
  );
}

function resolveCollectionItems(collectionId, items, postBySlug, pageByPath, frontPage, pageReferencePathByPage, collectionTargetByItem) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => resolveCollectionItem(
    collectionId,
    item,
    index,
    postBySlug,
    pageByPath,
    frontPage,
    pageReferencePathByPage,
    collectionTargetByItem,
  ));
}

function resolveCollectionItem(collectionId, item, index, postBySlug, pageByPath, frontPage, pageReferencePathByPage, collectionTargetByItem) {
  if (item?.type === 'post') {
    const post = postBySlug.get(item.slug);
    if (!post) {
      throw new Error(`Invalid collection "${collectionId}": item ${index + 1} references missing post slug "${item.slug}".`);
    }
    const resolved = {
      type: 'post',
      meta: post.meta,
      ...buildStructuredPostSummary(post),
    };
    collectionTargetByItem.set(resolved, post);
    return resolved;
  }

  if (item?.type === 'page') {
    const pagePath = normalizePageReferencePath(item.path);
    const page = pageByPath.get(pagePath);
    if (!page) {
      throw new Error(`Invalid collection "${collectionId}": item ${index + 1} references missing page path "${item.path}".`);
    }
    const resolved = buildCollectionPageSummary(page, frontPage, pageReferencePathByPage.get(page));
    collectionTargetByItem.set(resolved, page);
    return resolved;
  }

  throw new Error(`Invalid collection "${collectionId}": item ${index + 1} has unsupported type "${item?.type}".`);
}

function buildCollectionPageSummary(page, frontPage, pageReferencePath) {
  return {
    type: 'page',
    title: page.title,
    slug: page.slug,
    url: frontPage?.type === 'page' && frontPage.page_path === pageReferencePath ? '/' : page.url,
    excerpt: page.excerpt || '',
    summary: page.summary || '',
    featured_image: page.featured_image || '',
    updated_at: page.updated_at || '',
    updated_at_iso: page.updated_at_iso || '',
    ...(page.featured_media ? { featured_media: { ...page.featured_media } } : {}),
    meta: page.meta,
    data: page.data,
  };
}

function attachCollectionCursors(collections, collectionTargetByItem) {
  for (const [collectionId, collection] of Object.entries(collections || {})) {
    const items = Array.isArray(collection.items) ? collection.items : [];

    items.forEach((item, index) => {
      const target = collectionTargetByItem.get(item);

      if (!target) {
        return;
      }

      const cursor = buildCollectionCursor(collectionId, collection, items, index);
      target.collection_cursors = target.collection_cursors || {};
      target.collection_cursors[collectionId] = cursor;
      if (!target.collection_cursor) {
        target.collection_cursor = cursor;
      }
    });
  }
}

function buildCollectionCursor(collectionId, collection, items, index) {
  const count = items.length;

  return {
    collection_id: collectionId,
    collection_title: collection.title || '',
    index,
    position: index + 1,
    count,
    first: index === 0,
    last: index === count - 1,
    prev: index > 0 ? buildCollectionCursorItemSummary(items[index - 1]) : null,
    next: index < count - 1 ? buildCollectionCursorItemSummary(items[index + 1]) : null,
  };
}

function buildCollectionCursorItemSummary(item) {
  if (!item) {
    return null;
  }

  return {
    type: item.type,
    title: item.title,
    slug: item.slug,
    url: item.url,
    excerpt: item.excerpt || '',
    summary: item.summary || '',
    featured_image: item.featured_image || '',
    updated_at: item.updated_at || '',
    updated_at_iso: item.updated_at_iso || '',
    meta: item.meta,
    data: item.data,
  };
}

function buildFrontPageRoute(frontPage, pageByPath, effectivePostIndexEnabled, post_indexBasePath) {
  if (frontPage.type === 'theme_index') {
    if (effectivePostIndexEnabled && post_indexBasePath === '/') {
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
    const page = pageByPath.get(frontPage.page_path);
    if (!page) {
      throw new Error(`Invalid front page configuration: site.front_page.page_path "${frontPage.page_path}" does not match a page.`);
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
    const items = options.items.slice(0, options.posts_per_page);
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
    posts_per_page: options.posts_per_page,
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
      return previewData.site.archive.enabled === true
        ? resolveArchivesWidget(baseWidget, item.settings, previewData)
        : null;
    case 'text':
      return resolveTextWidget(baseWidget, item.settings);
    case 'link-list':
      return resolveLinkListWidget(baseWidget, item.settings);
    case 'search':
      return previewData.site.search.enabled === true
        ? resolveSearchWidget(baseWidget, item.settings, widgetAreaId, index)
        : null;
    case 'profile':
      return resolveProfileWidget(baseWidget, item.settings);
    default:
      return null;
  }
}

function resolveRecentPostsWidget(baseWidget, settings, renderData) {
  const limit = clampInteger(settings?.limit, 5, 1, 20);
  const items = renderData.posts
    .filter((post) => post.status === 'published' && !isDelistedDocument(post))
    .slice(0, limit)
    .map((post) => ({
      title: post.title,
      url: post.url,
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
      url: previewData.site.archive.url,
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
  const pageFields = { ...page };
  const excerpt = typeof page.excerpt === 'string' ? page.excerpt : '';
  delete pageFields.comments;

  return {
    ...pageFields,
    url: permalink.url,
    document_type: documentType,
    excerpt,
    summary: buildDocumentSummary(excerpt, renderedDocument.html, page.title),
    html: renderedDocument.html,
    toc: renderedDocument.toc,
    updated_at: page.updated_at_iso ? formatTimestamp(page.updated_at_iso, site) : '',
  };
}

function preparePost(post, site, authorsById, categoriesBySlug, tagsBySlug) {
  const documentType = normalizeDocumentType(post.document_type);
  const renderedDocument = renderDocument(post.content, documentType);
  const excerpt = typeof post.excerpt === 'string' ? post.excerpt : '';
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
    excerpt,
    summary: buildDocumentSummary(excerpt, renderedDocument.html, post.title),
    published_at_iso: post.published_at_iso,
    updated_at_iso: post.updated_at_iso,
    author_id: post.author_id,
    featured_image: post.featured_image,
    ...(post.featured_media ? { featured_media: { ...post.featured_media } } : {}),
    meta: post.meta,
    data: post.data,
    status: post.status,
    discoverability: post.discoverability,
    allow_comments: post.allow_comments,
    category_slugs: post.category_slugs,
    tag_slugs: post.tag_slugs,
    author: {
      id: post.author_id,
      display_name: normalizeNonEmptyString(author?.display_name, post.author_id),
      avatar: author?.avatar || '',
      ...(author?.avatar_media ? { avatar_media: { ...author.avatar_media } } : {}),
    },
    categories,
    tags,
    html: renderedDocument.html,
    toc: renderedDocument.toc,
    published_at: formatTimestamp(post.published_at_iso, site),
    updated_at: formatTimestamp(post.updated_at_iso, site),
    reading_time: calculateReadingTime(renderedDocument.html),
  };
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
      posts_per_page: options.posts_per_page,
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
  const posts_per_page = Number.isInteger(options.posts_per_page) && options.posts_per_page > 0 ? options.posts_per_page : DEFAULT_POSTS_PER_PAGE;
  const totalPosts = options.items.length;
  const totalPages = Math.max(1, Math.ceil(totalPosts / posts_per_page));
  const pages = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * posts_per_page;
    const end = start + posts_per_page;

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

  const normalized = trimSlashes(decodeRoutePath(String(basePath)));
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
    summary: post.summary,
    published_at: post.published_at,
    published_at_iso: post.published_at_iso,
    reading_time: post.reading_time,
    featured_image: post.featured_image,
    ...(post.featured_media ? { featured_media: { ...post.featured_media } } : {}),
    meta: post.meta,
    data: post.data,
    author: {
      display_name: post.author?.display_name || '',
      avatar: post.author?.avatar || '',
      ...(post.author?.avatar_media ? { avatar_media: { ...post.author.avatar_media } } : {}),
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
    summary: post.summary,
    published_at: post.published_at,
    published_at_iso: post.published_at_iso,
    data: post.data,
  };
}

function buildArchiveGroups(posts, postBySlug, site) {
  const groups = new Map();

  for (const post of posts) {
    const prepared = postBySlug.get(post.slug);
    if (!prepared?.published_at_iso) {
      continue;
    }

    const parts = getZonedDateParts(prepared.published_at_iso, site);
    const label = `${parts.year}-${padDatePart(parts.month)}`;
    const current = groups.get(label) || {
      label,
      year: parts.year,
      month: parts.month,
      items: [],
    };

    current.items.push(buildStructuredPostSummary(prepared));
    groups.set(label, current);
  }

  return Array.from(groups.values())
    .sort((left, right) => right.year - left.year || right.month - left.month);
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
    const parts = getZonedDateParts(date, site);
    const key = `${parts.year}-${padDatePart(parts.month)}`;
    const current = entries.get(key) || {
      date,
      year: parts.year,
      month: parts.month,
      count: 0,
    };
    current.count += 1;
    entries.set(key, current);
  }

  return Array.from(entries.values())
    .sort((left, right) => right.year - left.year || right.month - left.month)
    .map((entry) => ({
      label: formatArchiveLabel(entry.date, site),
      count: entry.count,
      year: entry.year,
      month: entry.month,
    }));
}

function formatArchiveLabel(date, site) {
  return new Intl.DateTimeFormat(normalizeLocale(site.locale || DEFAULT_LOCALE), {
    timeZone: normalizeTimezone(site.timezone),
    year: 'numeric',
    month: 'long',
  }).format(date);
}

function formatTimestamp(value, site) {
  const date = toDate(value);
  const locale = normalizeLocale(site.locale || DEFAULT_LOCALE);
  const dateStyle = DATETIME_STYLES.has(site.date_style) ? site.date_style : DEFAULT_DATE_STYLE;
  const timeStyle = DATETIME_STYLES.has(site.time_style) ? site.time_style : DEFAULT_TIME_STYLE;
  const siteTimezone = normalizeTimezone(site.timezone);

  if (dateStyle === 'none' && timeStyle === 'none') {
    return '';
  }

  const options = {
    timeZone: siteTimezone,
  };
  if (dateStyle !== 'none') {
    options.dateStyle = dateStyle;
  }
  if (timeStyle !== 'none') {
    options.timeStyle = timeStyle;
  }

  return new Intl.DateTimeFormat(locale, options).format(date);
}

function calculateReadingTime(html) {
  const plainText = extractHtmlText(html);
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

function preserveOpaqueNonBlankString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function normalizeOptionalRawString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function normalizeLocale(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LOCALE;
  try {
    return Intl.getCanonicalLocales(candidate)[0] || DEFAULT_LOCALE;
  } catch {
    throw new Error(`Invalid preview-data: site.locale "${candidate}" is not a valid BCP 47 language tag.`);
  }
}

function normalizeTimezone(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TIMEZONE;
  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/u.exec(candidate);
  if (offsetMatch) {
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) {
      throw new Error(`Invalid preview-data: site.timezone "${candidate}" is outside the supported fixed-offset range.`);
    }
    if (hours === 0 && minutes === 0) {
      return DEFAULT_TIMEZONE;
    }
    return `${offsetMatch[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid preview-data: site.timezone "${candidate}" is not UTC, an IANA time zone, or a valid fixed offset.`);
  }
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
    ...(themePackage.metadata.links ? { links: themePackage.metadata.links } : {}),
    ...(themePackage.metadata.features ? { features: themePackage.metadata.features } : {}),
    ...(themePackage.metadata.menu_slots ? { menu_slots: themePackage.metadata.menu_slots } : {}),
    ...(themePackage.metadata.widget_areas ? { widget_areas: themePackage.metadata.widget_areas } : {}),
    ...(themePackage.metadata.site_meta ? { site_meta: themePackage.metadata.site_meta } : {}),
    ...(themePackage.metadata.collection_slots ? { collection_slots: themePackage.metadata.collection_slots } : {}),
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
    throw createThemeValidationError(validation);
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

function buildAssetOutputs(assets, assetProcessor, options) {
  const outputs = [];

  for (const [assetPath, content] of assets.entries()) {
    const hash = options.assetHashing ? `.${assetProcessor.generateAssetHash(content)}` : '';
    const targetPath = `assets/${assetPath.replace(/(\.[^.]+)$/, `${hash}$1`)}`;

    outputs.push({
      originalPath: assetPath,
      path: targetPath,
      content,
      contentType: getContentType(assetPath),
    });
  }

  return outputs;
}

function buildCustomCssAsset(customCss, assetProcessor, options) {
  const content = customCss?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }

  const sourceBuffer = new TextEncoder().encode(content);
  const hash = options.assetHashing ? `.${assetProcessor.generateAssetHash(sourceBuffer)}` : '';

  return {
    originalPath: '__zeropress_custom.css',
    path: `assets/zeropress-custom${hash}.css`,
    content,
    contentType: 'text/css',
  };
}

function createRenderContext(site, currentUrl, comments = DISABLED_COMMENTS_CONTEXT) {
  return {
    site,
    currentUrl,
    language: site.locale,
    comments,
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
  const includeRichMetadata = options.includeRichMetadata !== false;
  const resolvedDescription = includeRichMetadata ? normalizeOptionalString(options.description) : '';
  const canonicalUrl = includeRichMetadata
    ? resolveMetaCanonicalUrl(site, options.canonicalUrl || options.currentUrl)
    : '';
  const ogImage = includeRichMetadata ? resolveMetaImageUrl(options.image) : '';
  const ogType = includeRichMetadata ? normalizeNonEmptyString(options.ogType, 'website') : '';
  const publishedTime = includeRichMetadata ? normalizeOptionalString(options.publishedTime) : '';
  const modifiedTime = includeRichMetadata ? normalizeOptionalString(options.modifiedTime) : '';
  const robotsNoindex = options.robotsNoindex === true;

  const meta = {
    title: escapeHtml(resolvedTitle),
    description: resolvedDescription ? escapeHtml(resolvedDescription) : '',
    canonical_url: canonicalUrl ? escapeHtml(canonicalUrl) : '',
    og_title: includeRichMetadata ? escapeHtml(resolvedTitle) : '',
    og_description: includeRichMetadata && resolvedDescription ? escapeHtml(resolvedDescription) : '',
    og_type: escapeHtml(ogType),
    og_url: includeRichMetadata && canonicalUrl ? escapeHtml(canonicalUrl) : '',
    og_site_name: includeRichMetadata ? escapeHtml(site.title) : '',
    og_image: ogImage ? escapeHtml(ogImage) : '',
    article_published_time: publishedTime ? escapeHtml(publishedTime) : '',
    article_modified_time: modifiedTime ? escapeHtml(modifiedTime) : '',
    robots_noindex: robotsNoindex,
  };

  return {
    ...meta,
    head_tags: buildMetaHeadTags(meta, site, options),
  };
}

function buildDocumentTitle(contentTitle, siteTitle) {
  const resolvedContentTitle = normalizeNonEmptyString(contentTitle, siteTitle);
  const resolvedSiteTitle = normalizeNonEmptyString(siteTitle, resolvedContentTitle);
  return `${resolvedContentTitle} - ${resolvedSiteTitle}`;
}

function buildFrontPageTitle(site) {
  const resolvedSiteTitle = normalizeNonEmptyString(site.title, '');
  const resolvedDescription = normalizeOptionalString(site.description);
  return resolvedDescription ? `${resolvedSiteTitle} - ${resolvedDescription}` : resolvedSiteTitle;
}

function buildMetaHeadTags(meta, site, options = {}) {
  const tags = [];

  if (meta.description) {
    tags.push(`<meta name="description" content="${meta.description}">`);
  }
  if (meta.robots_noindex) {
    tags.push('<meta name="robots" content="noindex">');
  }
  if (meta.canonical_url) {
    tags.push(`<link rel="canonical" href="${meta.canonical_url}">`);
  }
  if (options.includeFeedLink !== false && site.feed?.enabled === true) {
    tags.push(`<link rel="alternate" type="application/rss+xml" title="${escapeHtml(site.title)} Feed" href="${escapeHtml(site.feed.url)}">`);
  }

  if (meta.og_title) {
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

function normalizeMediaField(value, media_origin) {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return '';
  }

  const normalizedMediaUrl = normalizeMediaUrl(normalizedValue);
  if (!normalizedMediaUrl) {
    return '';
  }

  if (isAbsoluteUrl(normalizedMediaUrl)) {
    return normalizedMediaUrl;
  }

  const normalizedOrigin = normalizeMediaOrigin(media_origin);
  if (!normalizedOrigin) {
    return normalizedMediaUrl;
  }

  try {
    return decodeURI(new URL(normalizedMediaUrl, `${normalizedOrigin}/`).toString());
  } catch {
    return '';
  }
}

function normalizeMediaOrigin(value) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return '';
  }

  try {
    const url = new URL(normalizedValue);
    if (
      !SAFE_MEDIA_PROTOCOLS.has(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== '/'
      || !isSafeUrlText(normalizedValue)
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeSiteOrigin(value) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue) {
    return '';
  }

  try {
    const url = new URL(normalizedValue);
    if (
      !SAFE_LINK_PROTOCOLS.has(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== '/'
      || !isSafeUrlText(normalizedValue)
    ) {
      throw new Error('site.url must be an HTTP(S) origin without credentials, path, query, or fragment');
    }
    return url.origin;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid preview-data: site.url is not a safe HTTP(S) origin: ${reason}`);
  }
}

function normalizeNavigationUrl(value) {
  return normalizeSafeResourceUrl(value, { allowRoot: true });
}

function normalizeMediaUrl(value) {
  return normalizeSafeResourceUrl(value, { allowRoot: false });
}

function normalizeSafeResourceUrl(value, options) {
  const normalizedValue = normalizeOptionalString(value);
  if (!normalizedValue || !isSafeUrlText(normalizedValue)) {
    return '';
  }

  if (normalizedValue.startsWith('/')) {
    if (normalizedValue.startsWith('//')) {
      return '';
    }
    const pathname = normalizedValue.split(/[?#]/u, 1)[0];
    if ((!options.allowRoot && pathname === '/') || hasDotPathSegment(pathname)) {
      return '';
    }
    return normalizedValue;
  }

  if (!isAbsoluteUrl(normalizedValue)) {
    return '';
  }

  const rawPath = extractAbsoluteUrlPath(normalizedValue);
  if ((!options.allowRoot && (!rawPath || rawPath === '/')) || hasDotPathSegment(rawPath || '/')) {
    return '';
  }
  return normalizeAbsoluteUrl(normalizedValue, SAFE_LINK_PROTOCOLS);
}

function isSafeUrlText(value) {
  if (/[\s\\\u0000-\u001F\u007F]/u.test(value)) {
    return false;
  }
  try {
    decodeURI(value);
    return true;
  } catch {
    return false;
  }
}

function extractAbsoluteUrlPath(value) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?<path>[^?#]*)/u.exec(value);
  return match?.groups?.path || '/';
}

function hasDotPathSegment(pathname) {
  return String(pathname || '').split('/').some((segment) => {
    if (!segment) {
      return false;
    }
    try {
      const decoded = decodeURIComponent(segment).normalize('NFC');
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
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
    if (!allowedProtocols.has(url.protocol) || url.username || url.password || !isSafeUrlText(value)) {
      return '';
    }
    return decodeURI(url.toString());
  } catch {
    return '';
  }
}

function normalizeThemeLinkUrl(value) {
  return normalizeNavigationUrl(value);
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
    return `${trimSlashes(normalizedPath)}.html`;
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

function trimSlashes(value, { leading = true } = {}) {
  let start = 0;
  let end = value.length;
  if (leading) {
    while (start < end && value[start] === '/') start += 1;
  }
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') {
    return '/';
  }
  const normalized = trimSlashes(decodeRoutePath(String(routePath)));
  return `/${normalized}/`;
}

function resolvePagePermalink(site, page) {
  if (normalizeOptionalString(page.path)) {
    return buildRouteInfo(page.path, site.permalinks.output_style, { pagePath: true });
  }
  return resolvePermalink(site, 'pages', page);
}

function resolveEffectivePageReferencePath(site, page) {
  return normalizePageReferencePath(resolvePagePermalink(site, page).path);
}

function normalizePageReferencePath(value) {
  const normalized = trimSlashes(decodeRoutePath(normalizeOptionalString(value)))
    .normalize('NFC');
  return normalized;
}

function assertUniquePageReferencePaths(pageReferencePaths) {
  const seen = new Map();
  for (const [page, pagePath] of pageReferencePaths.entries()) {
    if (!pagePath) {
      throw new Error(`Invalid preview-data: Page "${page?.slug || ''}" resolves to an empty effective path.`);
    }
    const existing = seen.get(pagePath);
    if (existing) {
      throw new Error(`Invalid preview-data: Pages "${existing.slug}" and "${page.slug}" resolve to the same effective path "${pagePath}".`);
    }
    seen.set(pagePath, page);
  }
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
  const body = trimSlashes(String(pattern || ''));
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
    const parts = getZonedDateParts(item.published_at_iso, site);
    values.public_id = String(item.public_id);
    values.year = String(parts.year);
    values.month = padDatePart(parts.month);
    values.day = padDatePart(parts.day);
  }

  return values;
}

function getZonedDateParts(value, site) {
  const date = toDate(value);
  const timeZone = normalizeTimezone(site.timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === 'year')?.value) || date.getUTCFullYear(),
    month: Number(parts.find((part) => part.type === 'month')?.value) || date.getUTCMonth() + 1,
    day: Number(parts.find((part) => part.type === 'day')?.value) || date.getUTCDate(),
  };
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
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
  const nonRoutePaths = [
    ...state.assetOutputs.map((assetOutput) => assetOutput.path),
  ];

  if (shouldGenerateSearchArtifacts(state)) {
    nonRoutePaths.push(SEARCH_INDEX_OUTPUT_PATH, SEARCH_ADAPTER_OUTPUT_PATH, SEARCH_PAGEFIND_ADAPTER_OUTPUT_PATH);
  }

  if (hasTemplate(state, '404')) {
    nonRoutePaths.push('404.html');
  }
  if (shouldGenerateRobotsTxt(state.options)) {
    nonRoutePaths.push('robots.txt');
  }
  if (hasCanonicalSiteUrl(state.previewData.site.url)) {
    nonRoutePaths.push('sitemap.xml');
    if (shouldGenerateFeed(state)) {
      nonRoutePaths.push('feed.xml');
    }
  }
  nonRoutePaths.push(...normalizeReservedOutputPaths(state.options.reservedOutputPaths));
  const plannedPaths = [
    ...routeEntries.map((entry) => entry.outputPath),
    ...nonRoutePaths,
  ];

  for (const plannedPath of plannedPaths) {
    const rawPath = String(plannedPath || '');
    const normalizedPath = normalizeOutputPath(rawPath);
    assertSafeRelativeOutputPath(rawPath, normalizedPath);
  }

  const publicUrlClaims = [
    ...routeEntries.flatMap((entry, index) => {
      const owner = `route:${index}`;
      return [entry.url, ...buildOutputPublicUrlAliases(entry.outputPath)]
        .map((url) => ({ url, owner }));
    }),
    ...nonRoutePaths.flatMap((outputPath, index) => {
      const owner = `file:${index}`;
      return buildOutputPublicUrlAliases(outputPath)
        .map((url) => ({ url, owner }));
    }),
  ];
  assertUniquePublicUrlClaims(publicUrlClaims);
  assertUniqueOutputPaths(plannedPaths);
}

function normalizeReservedOutputPaths(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('reservedOutputPaths must be an array of relative output file paths');
  }
  return value.map((outputPath) => {
    if (typeof outputPath !== 'string') {
      throw new Error('reservedOutputPaths must contain only relative output file paths');
    }
    return outputPath;
  });
}

function buildOutputPublicUrlAliases(outputPath) {
  const normalizedPath = normalizeOutputPath(outputPath);
  const aliases = new Set([`/${normalizedPath}`]);

  if (normalizedPath.endsWith('.html')) {
    aliases.add(`/${normalizedPath.slice(0, -'.html'.length)}`);
  }
  if (normalizedPath === 'index.html') {
    aliases.add('/');
  } else if (normalizedPath.endsWith('/index.html')) {
    aliases.add(`/${normalizedPath.slice(0, -'index.html'.length)}`);
  }

  return [...aliases];
}

function assertUniquePublicUrlClaims(claims) {
  const seenUrls = new Map();
  for (const claim of claims) {
    const normalizedUrl = normalizeRouteCollisionKey(claim.url);
    const existingOwner = seenUrls.get(normalizedUrl);
    if (existingOwner !== undefined && existingOwner !== claim.owner) {
      throw new Error(`Duplicate public URL detected: ${claim.url}`);
    }
    seenUrls.set(normalizedUrl, claim.owner);
  }
}

function assertUniqueOutputPaths(plannedPaths) {
  const normalizedPaths = plannedPaths.map((plannedPath) => normalizeOutputPath(plannedPath));
  const seenPaths = new Set();
  for (const [index, normalizedPath] of normalizedPaths.entries()) {
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate output path detected: ${plannedPaths[index]}`);
    }
    seenPaths.add(normalizedPath);
  }

  const shallowestFirst = [...seenPaths]
    .map((outputPath) => ({ outputPath, segments: outputPath.split('/') }))
    .sort((left, right) => (
      left.segments.length - right.segments.length
      || left.outputPath.localeCompare(right.outputPath)
    ));
  const processedPaths = new Set();
  for (const { outputPath, segments } of shallowestFirst) {
    let ancestorPath = '';
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      if (processedPaths.has(ancestorPath)) {
        throw new Error(`Conflicting output path hierarchy detected: ${ancestorPath} and ${outputPath}`);
      }
    }
    processedPaths.add(outputPath);
  }
}

function normalizeRouteCollisionKey(url) {
  return trimSlashes(String(url || ''), { leading: false }) || '/';
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
    originalPath.includes('\\') ||
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

function injectSiteCustomizations(html, state, target) {
  let next = injectFaviconLinks(html, state.favicon);
  next = injectGeneratorMeta(next, state.exposeGenerator);
  next = injectCustomCssAssetLink(next, state.customCssHref);
  next = injectCustomHtml(next, state.customHtml, target);
  return next;
}

function injectFaviconLinks(html, favicon) {
  const links = buildFaviconLinks(favicon);
  if (!links) {
    return html;
  }

  return insertBeforeClosingTag(html, HEAD_CLOSING_TAG_PATTERN, `${links}\n`);
}

function buildFaviconLinks(favicon) {
  if (!favicon || typeof favicon !== 'object') {
    return '';
  }

  const lines = [];
  const icon = normalizeOptionalString(favicon.icon);
  const iconDark = normalizeOptionalString(favicon.icon_dark);
  const svg = normalizeOptionalString(favicon.svg);
  const png = normalizeOptionalString(favicon.png);
  const hasDefaultIcon = Boolean(icon || svg || png);
  const hasBothColorSchemes = Boolean(iconDark && hasDefaultIcon);

  if (iconDark) {
    lines.push(buildFaviconLink(
      iconDark,
      undefined,
      hasBothColorSchemes ? '(prefers-color-scheme: dark)' : undefined,
    ));
  }
  if (icon) {
    lines.push(buildFaviconLink(icon, undefined, hasBothColorSchemes ? '(prefers-color-scheme: light)' : undefined));
  }
  if (svg) {
    lines.push(buildFaviconLink(
      svg,
      'image/svg+xml',
      hasBothColorSchemes ? '(prefers-color-scheme: light)' : undefined,
    ));
  }
  if (png) {
    lines.push(buildFaviconLink(
      png,
      'image/png',
      hasBothColorSchemes ? '(prefers-color-scheme: light)' : undefined,
    ));
  }
  if (normalizeOptionalString(favicon.apple_touch_icon)) {
    lines.push(`  <link rel="apple-touch-icon" href="${escapeHtml(favicon.apple_touch_icon)}">`);
  }

  return lines.join('\n');
}

function buildFaviconLink(href, type, media) {
  return `  <link rel="icon" href="${escapeHtml(href)}"${type ? ` type="${type}"` : ''}${media ? ` media="${media}"` : ''}>`;
}

function injectGeneratorMeta(html, exposeGenerator) {
  if (exposeGenerator === false) {
    return html;
  }

  return insertBeforeClosingTag(
    html,
    HEAD_CLOSING_TAG_PATTERN,
    '  <meta name="generator" content="ZeroPress">\n',
  );
}

function injectCustomCssAssetLink(html, href) {
  if (!normalizeOptionalString(href)) {
    return html;
  }

  return insertBeforeClosingTag(
    html,
    HEAD_CLOSING_TAG_PATTERN,
    `  <link rel="stylesheet" href="${escapeHtml(href)}">\n`,
  );
}

function injectCustomHtml(html, customHtml, target) {
  let next = html;
  const headEnd = normalizeCustomHtmlSlot(customHtml?.head_end);
  const bodyEnd = normalizeCustomHtmlSlot(customHtml?.body_end);

  if (headEnd) {
    next = injectRequiredCustomHtmlSlot(
      next,
      'head_end',
      headEnd,
      'head',
      HEAD_CLOSING_TAG_PATTERN,
      target,
    );
  }
  if (bodyEnd) {
    next = injectRequiredCustomHtmlSlot(
      next,
      'body_end',
      bodyEnd,
      'body',
      BODY_CLOSING_TAG_PATTERN,
      target,
    );
  }

  return next;
}

function injectRequiredCustomHtmlSlot(html, slot, content, tagName, closingTagPattern, target) {
  let injected = false;
  const next = String(html).replace(closingTagPattern, (closingTag) => {
    injected = true;
    return `${content}\n${closingTag}`;
  });

  if (injected) {
    return next;
  }

  const route = normalizeOptionalString(target?.route) || '<unknown>';
  const outputPath = normalizeOptionalString(target?.outputPath) || '<unknown>';
  throw new Error(
    `Unable to inject custom_html.${slot} for route "${route}" into output "${outputPath}": `
    + `rendered theme HTML is missing a closing </${tagName}> tag. `
    + `Add </${tagName}> to the rendered theme layout or remove custom_html.${slot}.`,
  );
}

function insertBeforeClosingTag(html, closingTagPattern, content) {
  return String(html).replace(closingTagPattern, (closingTag) => `${content}${closingTag}`);
}

function buildSearchIndexJson(state) {
  return `${JSON.stringify(buildSearchIndexItems(state), null, 2)}\n`;
}

function buildSearchIndexItems(state) {
  const posts = state.renderData.posts
    .filter((post) => post.status === 'published' && !isDelistedDocument(post))
    .map((post) => ({
      id: `post:${post.slug}`,
      type: 'post',
      title: post.title,
      url: post.url,
      excerpt: normalizeSearchText(post.excerpt),
      headings: buildSearchHeadings(post.toc),
      categories: Array.isArray(post.categories) ? post.categories.map((category) => category.name).filter(Boolean) : [],
      tags: Array.isArray(post.tags) ? post.tags.map((tag) => tag.name).filter(Boolean) : [],
      published_at_iso: normalizeIsoTimestamp(post.published_at_iso),
      updated_at_iso: normalizeIsoTimestamp(post.updated_at_iso),
      content_text: extractHtmlText(post.html),
    }));

  const frontPagePage = state.renderData.frontPageRoute?.front_page_type === 'page'
    ? state.renderData.frontPageRoute.page
    : null;
  const frontPageItems = frontPagePage && frontPagePage.status === 'published' && !isDelistedDocument(frontPagePage)
    ? [buildSearchPageItem(
        frontPagePage,
        '/',
        state.renderData.pageReferencePathByPage.get(frontPagePage),
      )]
    : [];
  const pageItems = state.renderData.pages
    .filter((page) => page.status === 'published' && !isDelistedDocument(page))
    .map((page) => buildSearchPageItem(
      page,
      page.url,
      state.renderData.pageReferencePathByPage.get(page),
    ));

  return [...posts, ...frontPageItems, ...pageItems];
}

function buildSearchPageItem(page, url, pageReferencePath) {
  return {
    id: `page:${pageReferencePath}`,
    type: 'page',
    title: page.title,
    url,
    excerpt: normalizeSearchText(page.excerpt),
    headings: buildSearchHeadings(page.toc),
    categories: [],
    tags: [],
    published_at_iso: '',
    updated_at_iso: normalizeIsoTimestamp(page.updated_at_iso),
    content_text: extractHtmlText(page.html),
  };
}

function buildDocumentSummary(excerpt, html, title) {
  const authoredExcerpt = String(excerpt || '').trim();
  if (authoredExcerpt) {
    return authoredExcerpt;
  }

  const visibleText = extractHtmlText(html, { omitLeadingHeading: title });
  const codePoints = [...visibleText];
  if (codePoints.length <= GENERATED_SUMMARY_MAX_CODE_POINTS) {
    return visibleText;
  }

  const truncated = codePoints
    .slice(0, GENERATED_SUMMARY_MAX_CODE_POINTS - 1)
    .join('')
    .trimEnd();
  return `${truncated}…`;
}

function buildSearchHeadings(toc) {
  return Array.isArray(toc)
    ? toc.map((item) => normalizeSearchText(item?.title)).filter(Boolean)
    : [];
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildSearchAdapterJs(locale) {
  const fieldWeightsJson = JSON.stringify(SEARCH_FIELD_WEIGHTS, null, 2);
  const localeJson = JSON.stringify(locale);
  return `const FIELD_WEIGHTS = ${fieldWeightsJson};
const FIELD_NAMES = Object.keys(FIELD_WEIGHTS);
const RECENCY_BOOST_MAX = ${SEARCH_RECENCY_BOOST_MAX};
const SEGMENTER_LOCALE = ${localeJson};
const DEFAULT_LIMIT = 20;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

let preparedIndexPromise;

export async function preload() {
  await loadPreparedIndex();
}

export async function search(query, options = {}) {
  const prepared = await loadPreparedIndex();
  const terms = tokenize(query);
  const phrase = normalizeText(query);
  if (terms.length === 0 && !phrase) {
    return { results: [] };
  }

  const hits = [];
  for (const document of prepared.documents) {
    const score = scoreDocument(document, terms, phrase, prepared);
    if (score > 0) {
      hits.push({ document, score });
    }
  }

  const limit = normalizeLimit(options.limit);
  hits.sort((left, right) => right.score - left.score || left.document.raw.title.localeCompare(right.document.raw.title));

  return {
    results: hits.slice(0, limit).map((hit) => ({
      id: hit.document.raw.id,
      score: Number(hit.score.toFixed(6)),
      data: async () => buildResultData(hit.document.raw, query),
    })),
  };
}

async function loadPreparedIndex() {
  if (!preparedIndexPromise) {
    preparedIndexPromise = fetch(new URL('./search.json', import.meta.url))
      .then((response) => {
        if (!response.ok) {
          throw new Error('ZeroPress search index not found');
        }
        return response.json();
      })
      .then((items) => prepareIndex(Array.isArray(items) ? items : []));
  }

  return preparedIndexPromise;
}

function prepareIndex(items) {
  const documents = items.map((item) => prepareDocument(item));
  const documentFrequencies = new Map();
  const averageLengths = Object.fromEntries(FIELD_NAMES.map((fieldName) => [fieldName, 1]));
  const newestPostTime = documents.reduce((newest, document) => {
    if (document.raw.type !== 'post') {
      return newest;
    }
    return Math.max(newest, document.publishedTime || 0);
  }, 0);

  for (const document of documents) {
    const seenTerms = new Set();
    for (const fieldName of FIELD_NAMES) {
      for (const term of document.fieldTokens[fieldName]) {
        seenTerms.add(term);
      }
    }
    for (const term of seenTerms) {
      documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
    }
  }

  for (const fieldName of FIELD_NAMES) {
    const total = documents.reduce((sum, document) => sum + document.fieldLengths[fieldName], 0);
    averageLengths[fieldName] = documents.length > 0 ? Math.max(1, total / documents.length) : 1;
  }

  return {
    documents,
    documentFrequencies,
    averageLengths,
    documentCount: documents.length,
    newestPostTime,
  };
}

function prepareDocument(item) {
  const raw = normalizeItem(item);
  const fields = {
    title: raw.title,
    headings: raw.headings.join(' '),
    tags: raw.tags.join(' '),
    categories: raw.categories.join(' '),
    excerpt: raw.excerpt,
    content_text: raw.content_text,
  };
  const fieldTexts = {};
  const fieldTokens = {};
  const fieldTermCounts = {};
  const fieldLengths = {};

  for (const [fieldName, value] of Object.entries(fields)) {
    const normalizedText = normalizeText(value);
    const tokens = tokenize(normalizedText);
    fieldTexts[fieldName] = normalizedText;
    fieldTokens[fieldName] = tokens;
    fieldTermCounts[fieldName] = countTerms(tokens);
    fieldLengths[fieldName] = Math.max(1, tokens.length);
  }

  return {
    raw,
    fieldTexts,
    fieldTokens,
    fieldTermCounts,
    fieldLengths,
    publishedTime: Date.parse(raw.published_at_iso) || 0,
  };
}

function normalizeItem(item) {
  return {
    id: String(item && item.id || ''),
    type: item && item.type === 'page' ? 'page' : 'post',
    title: String(item && item.title || ''),
    url: String(item && item.url || ''),
    excerpt: String(item && item.excerpt || ''),
    headings: Array.isArray(item && item.headings) ? item.headings.map(String) : [],
    categories: Array.isArray(item && item.categories) ? item.categories.map(String) : [],
    tags: Array.isArray(item && item.tags) ? item.tags.map(String) : [],
    published_at_iso: String(item && item.published_at_iso || ''),
    updated_at_iso: String(item && item.updated_at_iso || ''),
    content_text: String(item && item.content_text || ''),
  };
}

function scoreDocument(document, terms, phrase, prepared) {
  let score = 0;
  const uniqueTerms = Array.from(new Set(terms));

  for (const term of uniqueTerms) {
    const documentFrequency = prepared.documentFrequencies.get(term) || 0;
    const idf = Math.log(1 + (prepared.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

    for (const fieldName of FIELD_NAMES) {
      const termFrequency = document.fieldTermCounts[fieldName].get(term) || 0;
      if (termFrequency === 0) {
        continue;
      }

      const fieldLength = document.fieldLengths[fieldName];
      const averageLength = prepared.averageLengths[fieldName];
      const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLength / averageLength));
      score += FIELD_WEIGHTS[fieldName] * idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
    }
  }

  if (phrase && phrase.length > 1) {
    for (const fieldName of FIELD_NAMES) {
      if (document.fieldTexts[fieldName].includes(phrase)) {
        score += FIELD_WEIGHTS[fieldName] * 0.6;
      }
    }
  }

  if (score <= 0) {
    return 0;
  }

  return score * (1 + recencyBoost(document, prepared.newestPostTime));
}

function recencyBoost(document, newestPostTime) {
  if (document.raw.type !== 'post' || !document.publishedTime || !newestPostTime) {
    return 0;
  }
  const ageMs = Math.max(0, newestPostTime - document.publishedTime);
  const halfLifeMs = 180 * 24 * 60 * 60 * 1000;
  return RECENCY_BOOST_MAX * Math.exp(-ageMs / halfLifeMs);
}

function buildResultData(item, query) {
  const excerpt = buildExcerpt(item, query);
  return {
    url: item.url,
    excerpt,
    plain_excerpt: excerpt,
    meta: {
      title: item.title,
      type: item.type,
      published_at_iso: item.published_at_iso,
      updated_at_iso: item.updated_at_iso,
      categories: item.categories,
      tags: item.tags,
    },
    sub_results: [],
  };
}

function buildExcerpt(item, query) {
  const explicitExcerpt = String(item.excerpt || '').trim();
  if (explicitExcerpt) {
    return explicitExcerpt;
  }

  const text = String(item.content_text || '').replace(/\\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  const normalizedText = normalizeText(text);
  const terms = tokenize(query);
  const firstMatch = terms.map((term) => normalizedText.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const start = Math.max(0, (firstMatch || 0) - 80);
  const end = Math.min(text.length, start + 180);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

function countTerms(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function tokenize(value) {
  const text = normalizeText(value);
  if (!text) {
    return [];
  }

  const tokens = [];
  const cjkRuns = Array.from(
    text.matchAll(/[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+/gu),
    (match) => match[0],
  );
  const nonCjkText = text.replace(
    /[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+/gu,
    ' ',
  );
  let segmented = false;

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: 'word' });
      for (const part of segmenter.segment(nonCjkText)) {
        if (part.isWordLike && isUsefulToken(part.segment)) {
          tokens.push(part.segment);
        }
      }
      segmented = true;
    } catch {
      // Fall through to regex tokenization.
    }
  }

  if (!segmented) {
    for (const match of nonCjkText.matchAll(/[\\p{Letter}\\p{Number}]+/gu)) {
      if (isUsefulToken(match[0])) {
        tokens.push(match[0]);
      }
    }
  }

  for (const run of cjkRuns) {
    tokens.push(...buildCjkTokens(run));
  }

  return tokens;
}

function buildCjkTokens(value) {
  const characters = Array.from(value);
  const tokens = new Set();
  if (isUsefulToken(value)) {
    tokens.add(value);
  }

  if (characters.length > 2) {
    for (let index = 0; index <= characters.length - 2; index += 1) {
      tokens.add(characters.slice(index, index + 2).join(''));
    }
  }

  return Array.from(tokens);
}

function isUsefulToken(value) {
  const token = String(value || '').trim();
  return token.length > 1 || /^\\d$/.test(token);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\u2018\\u2019]/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function normalizeLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT;
}
`;
}

function buildSearchPagefindAdapterJs() {
  return `let pagefindPromise;

export async function preload() {
  if (!pagefindPromise) {
    pagefindPromise = import(new URL('./pagefind/pagefind.js', import.meta.url).href).then(async (pagefind) => {
      if (typeof pagefind.options === 'function') {
        await pagefind.options({ baseUrl: '/' });
      }
      return pagefind;
    });
  }

  return pagefindPromise;
}

export async function search(query, options = {}) {
  const pagefind = await preload();
  const result = await pagefind.search(query, options);
  const limit = normalizeLimit(options.limit);
  if (!Array.isArray(result?.results)) {
    return result;
  }

  const results = result.results.map(normalizeResult);
  return {
    ...result,
    results: limit ? results.slice(0, limit) : results,
  };
}

function normalizeResult(result) {
  if (!result || typeof result.data !== 'function') {
    return result;
  }

  return {
    ...result,
    data: async () => normalizeResultData(await result.data()),
  };
}

function normalizeResultData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  return {
    ...data,
    url: normalizeUrl(data.url),
    sub_results: Array.isArray(data.sub_results)
      ? data.sub_results.map((item) => ({ ...item, url: normalizeUrl(item.url) }))
      : data.sub_results,
  };
}

function normalizeUrl(value) {
  const url = String(value || '');
  if (url.startsWith('/_zeropress/') && !url.startsWith('/_zeropress/pagefind/')) {
    return url.replace(/^\\/_zeropress/, '') || '/';
  }
  if (url.startsWith('_zeropress/') && !url.startsWith('_zeropress/pagefind/')) {
    return url.replace(/^_zeropress/, '') || '/';
  }
  return url;
}

function normalizeLimit(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }

  return Math.floor(limit);
}
`;
}

function buildSitemapXml(site, emitted, stylesheetHref = '') {
  const entries = [
    ...(emitted.frontPage && emitted.frontPage.includeInSitemap !== false
      ? [{
        url: emitted.frontPage.url,
        ...(emitted.frontPage.updatedAt ? { lastmod: toDate(emitted.frontPage.updatedAt) } : {}),
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
        ...(page.updatedAt ? { lastmod: toDate(page.updatedAt) } : {}),
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

  const normalizedStylesheetHref = normalizeOptionalString(stylesheetHref);
  const stylesheet = normalizedStylesheetHref
    ? `\n<?xml-stylesheet type="text/xsl" href="${escapeXml(normalizedStylesheetHref)}"?>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>${stylesheet}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

function buildFeedXml(site, emitted, feedGeneratedAt) {
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

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(site.title)}</title>\n    <link>${escapeXml(channelLink)}</link>\n    <description>${escapeXml(site.description)}</description>\n    <language>${site.locale}</language>\n    <lastBuildDate>${feedGeneratedAt.toUTCString()}</lastBuildDate>\n    <atom:link href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>`;
}

function buildRobotsTxt(site) {
  const lines = ['User-agent: *'];
  if (site.robots?.allow_indexing === false) {
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
  return options.generateRobotsTxt !== false;
}

function shouldGenerateFeed(state) {
  return state.previewData.site.feed.enabled === true;
}

function shouldGenerateSearchArtifacts(state) {
  return state.previewData.site.search.enabled === true;
}

function getContentType(assetPath) {
  const ext = assetPath.split('.').pop()?.toLowerCase();
  const contentTypes = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
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
  if (typeof siteUrl !== 'string' || !siteUrl.trim()) {
    return false;
  }
  try {
    return normalizeSiteOrigin(siteUrl) === siteUrl;
  } catch {
    return false;
  }
}

function toDate(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error('Invalid RFC 3339 timestamp');
    }
    return new Date(timestamp);
  }

  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid RFC 3339 timestamp: ${String(value)}`);
  }

  const timestampMatch = value.match(RFC3339_TIMESTAMP_PATTERN);
  if (!timestampMatch) {
    throw new Error(`Invalid RFC 3339 timestamp: ${value}`);
  }

  const isLeapSecond = timestampMatch[2] === '60';
  const parseValue = isLeapSecond
    ? `${timestampMatch[1]}59${timestampMatch[3] || ''}${timestampMatch[4]}`
    : value;
  const timestamp = Date.parse(parseValue);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid RFC 3339 timestamp: ${value}`);
  }

  return new Date(timestamp + (isLeapSecond ? 1000 : 0));
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
