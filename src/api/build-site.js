import { createHash } from 'node:crypto';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import { isSafeSlugSegment, normalizeStoredSlug } from '@zeropress/slug-policy';
import { validateThemeFiles } from '@zeropress/theme-validator';
import { AssetProcessor } from '../assets/asset-processor.js';
import { renderDocumentContent } from '../render/content-renderer.js';
import { ZeroPressEngine } from '../render/zeropress-engine.js';

const DEFAULT_OPTIONS = {
  assetHashing: true,
  generateSpecialFiles: true,
  injectHtmx: true,
  writeManifest: false,
};

const DEFAULT_POSTS_PER_PAGE = 10;
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
const DEFAULT_TIME_FORMAT = 'HH:mm';
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LOCALE = 'en-US';
const OUTPUT_PATH_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
export async function buildSite(input) {
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const state = await createBuildState(input, options);
  assertPlannedOutputPathsSafe(state);

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

  if (options.generateSpecialFiles) {
    await maybeRenderNotFoundPage(state);
    if (hasCanonicalSiteUrl(state.previewData.site.url)) {
      await writeOutput(state.writer, state.summaries, 'sitemap.xml', buildSitemapXml(state.previewData.site, state.emitted, state.generatedAt), 'application/xml');
      await writeOutput(state.writer, state.summaries, 'feed.xml', buildFeedXml(state.previewData.site, state.emitted, state.generatedAt), 'application/rss+xml');
    }
    await writeOutput(state.writer, state.summaries, 'robots.txt', buildRobotsTxt(state.previewData.site), 'text/plain');
    await writeOutput(state.writer, state.summaries, 'meta.json', buildMetaJson(state.previewData.site, state.emitted, state.generatedAt), 'application/json');
  }

  return finalizeBuildResult(state.writer, state.summaries, options);
}

async function createBuildState(input, options) {
  if (!input?.writer || typeof input.writer.write !== 'function') {
    throw new Error('buildSite requires a writer with an async write(file) method');
  }

  assertPreviewData(input.previewData);
  await assertValidThemePackage(input.themePackage);

  const engine = new ZeroPressEngine();
  const assetProcessor = new AssetProcessor();
  const summaries = [];
  const themePackage = input.themePackage;
  const previewData = normalizePreviewData(input.previewData);
  const renderData = createRenderData(previewData);

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
    renderedWidgets: renderWidgetAreas(previewData, renderData),
    engine,
    assetProcessor,
    summaries,
    assetOutputs,
    assetMap,
    customCssHref: customCssAsset ? `/${customCssAsset.path}` : '',
    options,
    generatedAt: new Date(),
    emitted: {
      indexRoutes: [],
      archiveRoutes: [],
      categoryRoutes: [],
      tagRoutes: [],
      posts: [],
      pages: [],
    },
  };
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
  const currentUrl = normalizeRoutePath(route.path);
  let html = await state.engine.render(
    templateName,
    {
      menus: state.previewData.menus,
      widgets: state.renderedWidgets,
      ...route,
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
  html = injectCustomCssAssetLink(html, state.customCssHref);
  await writeOutput(state.writer, state.summaries, routePathToOutputPath(route.path), html, 'text/html');
  recordRouteEmission(state, templateName, route, currentUrl);
}

async function renderPost(state, post) {
  const currentUrl = `/posts/${encodeSlugSegment(post.slug)}/`;
  let html = await state.engine.render(
    'post',
    {
      menus: state.previewData.menus,
      widgets: state.renderedWidgets,
      post,
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
  html = injectCustomCssAssetLink(html, state.customCssHref);
  if (state.options.injectHtmx) {
    html = injectHtmxScript(html);
  }
  await writeOutput(state.writer, state.summaries, `posts/${encodeSlugSegment(post.slug)}/index.html`, html, 'text/html');
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
  const currentUrl = `/${encodeSlugSegment(page.slug)}/`;
  let html = await state.engine.render(
    'page',
    {
      menus: state.previewData.menus,
      widgets: state.renderedWidgets,
      page,
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
  html = injectCustomCssAssetLink(html, state.customCssHref);
  await writeOutput(state.writer, state.summaries, `${encodeSlugSegment(page.slug)}/index.html`, html, 'text/html');
  state.emitted.pages.push({
    url: currentUrl,
    title: page.title,
    description: page.excerpt,
    status: page.status,
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
      widgets: state.renderedWidgets,
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
  html = injectCustomCssAssetLink(html, state.customCssHref);
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
  };

  return {
    ...previewData,
    site: normalizedSite,
    widgets: normalizeWidgetAreas(previewData.widgets),
    custom_css: normalizeCustomCss(previewData.custom_css),
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

function normalizeWidgetAreas(widgetAreas) {
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
          ? widgetArea.items.map((item) => ({
            ...item,
            title: normalizeNonEmptyString(item?.title, 'Widget'),
          }))
          : [],
      },
    ]),
  );
}

function normalizeCustomCss(customCss) {
  const content = normalizeOptionalString(customCss?.content);
  return content ? { content } : undefined;
}

function createRenderData(previewData) {
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

  const posts = previewData.content.posts.map((post) => preparePost(post, previewData.site, authorsById, categoriesBySlug, tagsBySlug));
  const pages = previewData.content.pages.map((page) => preparePage(page));
  const postBySlug = new Map(posts.map((post) => [post.slug, post]));
  const categoryLinks = renderCategoryLinks(previewData.content.categories, categoryCountBySlug);
  const tagLinks = renderTagLinks(previewData.content.tags, tagCountBySlug);

  return {
    posts,
    pages,
    postBySlug,
    indexRoutes: buildPaginatedCollection({
      items: previewData.content.posts,
      postsPerPage: previewData.site.postsPerPage,
      basePath: '/',
    }).map((entry) => ({
      path: entry.path,
      page: entry.page,
      totalPages: entry.totalPages,
      posts: renderPostList(entry.items, postBySlug),
      categories: categoryLinks,
      tags: tagLinks,
      pagination: renderPagination(entry.paginationData),
    })),
    archiveRoutes: buildPaginatedCollection({
      items: previewData.content.posts,
      postsPerPage: previewData.site.postsPerPage,
      basePath: '/archive/',
    }).map((entry) => ({
      path: entry.path,
      page: entry.page,
      totalPages: entry.totalPages,
      posts: renderArchive(entry.items, postBySlug),
      pagination: renderPagination(entry.paginationData),
    })),
    categoryRoutes: buildTaxonomyRoutes({
      items: previewData.content.categories,
      postsBySlug: categoryPostsBySlug,
      postsPerPage: previewData.site.postsPerPage,
      buildBasePath: (category) => `/categories/${encodeSlugSegment(category.slug)}/`,
      renderList: (postsForRoute) => renderPostList(postsForRoute, postBySlug),
      renderExtras: () => ({ categories: categoryLinks }),
    }),
    tagRoutes: buildTaxonomyRoutes({
      items: previewData.content.tags,
      postsBySlug: tagPostsBySlug,
      postsPerPage: previewData.site.postsPerPage,
      buildBasePath: (tag) => `/tags/${encodeSlugSegment(tag.slug)}/`,
      renderList: (postsForRoute) => renderPostList(postsForRoute, postBySlug),
      renderExtras: () => ({ tags: tagLinks }),
    }),
  };
}

function renderWidgetAreas(previewData, renderData) {
  if (!previewData.widgets || typeof previewData.widgets !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(previewData.widgets).map(([widgetAreaId, widgetArea]) => [
      widgetAreaId,
      renderWidgetArea(widgetArea, previewData, renderData, widgetAreaId),
    ]),
  );
}

function renderWidgetArea(widgetArea, previewData, renderData, widgetAreaId) {
  if (!widgetArea || !Array.isArray(widgetArea.items) || widgetArea.items.length === 0) {
    return '';
  }

  return widgetArea.items
    .map((item, index) => renderWidgetItem(item, previewData, renderData, widgetAreaId, index))
    .filter(Boolean)
    .join('\n');
}

function renderWidgetItem(item, previewData, renderData, widgetAreaId, index) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const title = normalizeNonEmptyString(item.title, 'Widget');

  switch (item.type) {
    case 'recent-posts':
      return renderRecentPostsWidget(title, item.settings, renderData);
    case 'categories':
      return renderCategoriesWidget(title, item.settings, previewData);
    case 'tags':
      return renderTagsWidget(title, item.settings, previewData);
    case 'archives':
      return renderArchivesWidget(title, item.settings, previewData);
    case 'image':
      return renderImageWidget(title, item.settings);
    case 'text':
      return renderTextWidget(title, item.settings);
    case 'link-list':
      return renderLinkListWidget(title, item.settings);
    case 'search':
      return renderSearchWidget(title, item.settings, widgetAreaId, index);
    case 'profile':
      return renderProfileWidget(title, item.settings);
    default:
      return '';
  }
}

function renderRecentPostsWidget(title, settings, renderData) {
  const limit = clampInteger(settings?.limit, 5, 1, 20);
  const showDate = settings?.show_date !== false;
  const items = renderData.posts
    .slice(0, limit)
    .map((post) => {
      const dateMeta = showDate
        ? `<span class="widget-list__meta">${escapeHtml(post.published_at)}</span>`
        : '';

      return `<li class="widget-list__item"><a href="/posts/${escapeHtml(encodeSlugSegment(post.slug))}/">${escapeHtml(post.title)}</a>${dateMeta}</li>`;
    })
    .join('');

  if (!items) {
    return '';
  }

  return renderWidgetCard(title, 'recent-posts', `<ul class="widget-list">${items}</ul>`);
}

function renderCategoriesWidget(title, settings, previewData) {
  const countBySlug = buildTaxonomyCountMap(previewData.content.posts, 'category_slugs');
  const items = previewData.content.categories
    .map((category) => {
      const count = countBySlug.get(category.slug) || 0;
      if (count === 0) {
        return '';
      }

      const suffix = settings?.show_count === true ? ` <span class="widget-taxonomy__count">(${count})</span>` : '';
      return `<a href="/categories/${escapeHtml(encodeSlugSegment(category.slug))}/" class="category-link">${escapeHtml(category.name)}${suffix}</a>`;
    })
    .filter(Boolean)
    .join('');

  if (!items) {
    return '';
  }

  return renderWidgetCard(title, 'categories', `<div class="taxonomy-list taxonomy-list--stack widget-taxonomy">${items}</div>`);
}

function renderTagsWidget(title, settings, previewData) {
  const countBySlug = buildTaxonomyCountMap(previewData.content.posts, 'tag_slugs');
  const limit = clampInteger(settings?.limit, 20, 1, 100);
  const items = previewData.content.tags
    .map((tag) => ({
      ...tag,
      count: countBySlug.get(tag.slug) || 0,
    }))
    .filter((tag) => tag.count > 0)
    .slice(0, limit)
    .map((tag) => {
      const suffix = settings?.show_count === true ? ` <span class="widget-taxonomy__count">(${tag.count})</span>` : '';
      return `<a href="/tags/${escapeHtml(encodeSlugSegment(tag.slug))}/" class="tag-link">${escapeHtml(tag.name)}${suffix}</a>`;
    })
    .join('');

  if (!items) {
    return '';
  }

  return renderWidgetCard(title, 'tags', `<div class="taxonomy-list widget-taxonomy">${items}</div>`);
}

function renderArchivesWidget(title, settings, previewData) {
  const limit = clampInteger(settings?.limit, 12, 1, 120);
  const archiveEntries = buildArchiveEntries(previewData.content.posts, previewData.site).slice(0, limit);
  const items = archiveEntries
    .map((entry) => `<li class="widget-list__item"><a href="/archive/">${escapeHtml(entry.label)}</a><span class="widget-list__meta">${entry.count} posts</span></li>`)
    .join('');

  if (!items) {
    return '';
  }

  return renderWidgetCard(title, 'archives', `<ul class="widget-list">${items}</ul>`);
}

function renderImageWidget(title, settings) {
  const src = normalizeOptionalString(settings?.src);
  if (!src) {
    return '';
  }

  const alt = escapeHtml(normalizeOptionalString(settings?.alt));
  const caption = normalizeOptionalString(settings?.caption);
  const href = normalizeOptionalString(settings?.href);
  const target = normalizeLinkTarget(settings?.target);
  const rel = target === '_blank' ? ' rel="noreferrer noopener"' : '';
  const image = `<img class="widget-image__media" src="${escapeHtml(src)}" alt="${alt}">`;
  const linkedImage = href ? `<a href="${escapeHtml(href)}" target="${target}"${rel}>${image}</a>` : image;
  const captionHtml = caption ? `<figcaption class="widget-image__caption">${escapeHtml(caption)}</figcaption>` : '';

  return renderWidgetCard(title, 'image', `<figure class="widget-image">${linkedImage}${captionHtml}</figure>`);
}

function renderTextWidget(title, settings) {
  const content = typeof settings?.content === 'string' ? settings.content : '';
  const html = renderDocumentContent(content, normalizeDocumentType(settings?.document_type));
  if (!normalizeOptionalString(html)) {
    return '';
  }

  return renderWidgetCard(title, 'text', `<div class="widget-copy">${html}</div>`);
}

function renderLinkListWidget(title, settings) {
  const links = Array.isArray(settings?.links) ? settings.links : [];
  const items = links
    .map((link) => {
      const label = normalizeOptionalString(link?.label);
      const url = normalizeOptionalString(link?.url);
      if (!label || !url) {
        return '';
      }

      const target = normalizeLinkTarget(link?.target);
      const rel = target === '_blank' ? ' rel="noreferrer noopener"' : '';
      return `<a href="${escapeHtml(url)}" target="${target}"${rel}>${escapeHtml(label)}</a>`;
    })
    .filter(Boolean)
    .join('');

  if (!items) {
    return '';
  }

  return renderWidgetCard(title, 'link-list', `<div class="taxonomy-list taxonomy-list--stack widget-link-list">${items}</div>`);
}

function renderSearchWidget(title, settings, widgetAreaId, index) {
  const placeholder = escapeHtml(normalizeNonEmptyString(settings?.placeholder, 'Search...'));
  const buttonLabel = escapeHtml(normalizeNonEmptyString(settings?.button_label, 'Search'));
  const searchId = `widget-search-${widgetAreaId}-${index + 1}`;

  return renderWidgetCard(title, 'search', [
    '<div class="widget-search" data-search-root>',
    `  <label class="sr-only" for="${escapeHtml(searchId)}">${escapeHtml(title)}</label>`,
    '  <form class="search-theme-wrapper" data-search-form>',
    `    <input id="${escapeHtml(searchId)}" class="search-input" data-theme-search type="search" placeholder="${placeholder}" autocomplete="off" enterkeyhint="search">`,
    `    <button class="widget-search-button" type="submit">${buttonLabel}</button>`,
    '  </form>',
    '  <div class="search-results" data-search-results hidden></div>',
    '  <p class="search-feedback search-feedback--sidebar" data-search-feedback aria-live="polite"></p>',
    '</div>',
  ].join('\n'));
}

function renderProfileWidget(title, settings) {
  const displayName = normalizeOptionalString(settings?.display_name);
  const affiliation = normalizeOptionalString(settings?.affiliation);
  const bioShort = normalizeOptionalString(settings?.bio_short);
  const avatar = normalizeOptionalString(settings?.avatar);

  if (!displayName && !bioShort && !avatar) {
    return '';
  }

  const avatarHtml = avatar
    ? `<img class="widget-profile__avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(displayName || title)}">`
    : '';
  const affiliationHtml = affiliation ? `<p class="widget-profile__affiliation">${escapeHtml(affiliation)}</p>` : '';
  const bioHtml = bioShort ? `<p class="sidebar-copy">${escapeHtml(bioShort)}</p>` : '';

  return renderWidgetCard(title, 'profile', [
    '<div class="widget-profile">',
    avatarHtml,
    '  <div class="widget-profile__body">',
    displayName ? `    <p class="widget-profile__name">${escapeHtml(displayName)}</p>` : '',
    affiliationHtml ? `    ${affiliationHtml}` : '',
    bioHtml ? `    ${bioHtml}` : '',
    '  </div>',
    '</div>',
  ].filter(Boolean).join('\n'));
}

function renderWidgetCard(title, modifier, body) {
  if (!normalizeOptionalString(body)) {
    return '';
  }

  return [
    `<section class="content-card sidebar-card widget-card widget-card--${escapeHtml(modifier)}">`,
    '  <p class="section-kicker">Widget</p>',
    `  <h2>${escapeHtml(title)}</h2>`,
    `  ${body}`,
    '</section>',
  ].join('\n');
}

function preparePage(page) {
  const documentType = normalizeDocumentType(page.document_type);

  return {
    ...page,
    document_type: documentType,
    html: renderDocumentContent(page.content, documentType),
  };
}

function preparePost(post, site, authorsById, categoriesBySlug, tagsBySlug) {
  const documentType = normalizeDocumentType(post.document_type);
  const html = renderDocumentContent(post.content, documentType);
  const author = authorsById.get(post.author_id);

  return {
    ...post,
    document_type: documentType,
    html,
    author_name: normalizeNonEmptyString(author?.display_name, post.author_id),
    author_avatar: author?.avatar,
    published_at: formatTimestamp(post.published_at_iso, site),
    updated_at: formatTimestamp(post.updated_at_iso, site),
    reading_time: calculateReadingTime(html),
    categories_html: renderInlineTaxonomyLinks(post.category_slugs, categoriesBySlug, 'category'),
    tags_html: renderInlineTaxonomyLinks(post.tag_slugs, tagsBySlug, 'tag'),
    comments_html: renderCommentsContainer(site, post),
  };
}

function renderCommentsContainer(site, post) {
  if (site.disallowComments === true || post.allow_comments !== true) {
    return '';
  }

  const safePostId = encodeURIComponent(post.id);
  return `<section id="comments" class="zp-comments">
  <h2>댓글</h2>
  <div id="comment-list"
       hx-get="/api/comments/${safePostId}"
       hx-trigger="load"
       hx-swap="innerHTML">
    <p class="zp-comments-loading">댓글을 불러오는 중...</p>
  </div>
  <form id="comment-form"
        hx-post="/api/comments/${safePostId}"
        hx-target="#comment-form-result"
        hx-swap="innerHTML">
    <div id="comment-form-result"></div>
    <div>
      <label for="author_name">이름</label>
      <input type="text" id="author_name" name="author_name" required>
    </div>
    <div>
      <label for="author_email">이메일</label>
      <input type="email" id="author_email" name="author_email" required>
    </div>
    <div>
      <label for="content">댓글</label>
      <textarea id="content" name="content" required minlength="1" maxlength="5000"></textarea>
    </div>
    <div style="position:absolute;left:-9999px;" aria-hidden="true">
      <input type="text" name="website" tabindex="-1" autocomplete="off">
    </div>
    <button type="submit">댓글 작성</button>
  </form>
  <noscript>
    <p>댓글 기능을 사용하려면 JavaScript를 활성화해 주세요.</p>
  </noscript>
</section>`;
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
    });

    for (const entry of paginated) {
      routes.push({
        path: entry.path,
        slug: item.slug,
        page: entry.page,
        totalPages: entry.totalPages,
        posts: options.renderList(entry.items),
        pagination: renderPagination(entry.paginationData),
        ...options.renderExtras(item),
      });
    }
  }

  return routes;
}

function buildPaginatedCollection(options) {
  const basePath = normalizePaginationBasePath(options.basePath);
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
      paginationData: buildPaginationData(page, totalPages, totalPosts, basePath),
    });
  }

  return pages;
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

function buildPaginationData(currentPage, totalPages, totalPosts, basePath) {
  return {
    currentPage,
    totalPages,
    totalPosts,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    nextUrl: currentPage < totalPages ? buildPaginatedPath(basePath, currentPage + 1) : undefined,
    prevUrl: currentPage > 1 ? buildPaginatedPath(basePath, currentPage - 1) : undefined,
    pages: Array.from({ length: totalPages }, (_, index) => {
      const page = index + 1;
      return {
        number: page,
        url: buildPaginatedPath(basePath, page),
        current: page === currentPage,
      };
    }),
  };
}

function renderPostList(posts, postBySlug) {
  if (posts.length === 0) {
    return '<p>No posts</p>';
  }

  return posts
    .map((post) => {
      const prepared = postBySlug.get(post.slug);
      if (!prepared) {
        return '';
      }

      return [
        '<article class="post-list-item">',
        `  <h2><a href="/posts/${escapeHtml(encodeSlugSegment(post.slug))}/">${escapeHtml(post.title)}</a></h2>`,
        `  <div class="post-meta"><time datetime="${escapeHtml(prepared.published_at_iso)}">${escapeHtml(prepared.published_at)}</time> • ${escapeHtml(prepared.reading_time)}</div>`,
        `  <div class="post-excerpt">${escapeHtml(prepared.excerpt)}</div>`,
        '</article>',
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function renderArchive(posts, postBySlug) {
  if (posts.length === 0) {
    return '<p>No posts</p>';
  }

  const groups = new Map();

  for (const post of posts) {
    const key = `${toDate(post.published_at_iso).getUTCFullYear()}-${String(toDate(post.published_at_iso).getUTCMonth() + 1).padStart(2, '0')}`;
    const items = groups.get(key) || [];
    items.push(post);
    groups.set(key, items);
  }

  return Array.from(groups.entries())
    .map(([key, groupPosts]) => {
      const items = groupPosts
        .map((post) => {
          const prepared = postBySlug.get(post.slug);
          if (!prepared) {
            return '';
          }

          return `<li><a href="/posts/${escapeHtml(encodeSlugSegment(post.slug))}/">${escapeHtml(post.title)}</a> <time datetime="${escapeHtml(prepared.published_at_iso)}">${escapeHtml(prepared.published_at)}</time></li>`;
        })
        .filter(Boolean)
        .join('\n');

      return `<section class="archive-group"><h2>${escapeHtml(key)}</h2><ul>${items}</ul></section>`;
    })
    .join('\n');
}

function renderCategoryLinks(categories, countBySlug) {
  return categories
    .map((category) => {
      const count = countBySlug.get(category.slug) || 0;
      if (count === 0) {
        return null;
      }

      return `<a href="/categories/${escapeHtml(encodeSlugSegment(category.slug))}/" class="category-link">${escapeHtml(category.name)} (${count})</a>`;
    })
    .filter(Boolean)
    .join('\n');
}

function renderTagLinks(tags, countBySlug) {
  return tags
    .map((tag) => {
      const count = countBySlug.get(tag.slug) || 0;
      if (count === 0) {
        return null;
      }

      return `<a href="/tags/${escapeHtml(encodeSlugSegment(tag.slug))}/" class="tag-link">${escapeHtml(tag.name)} (${count})</a>`;
    })
    .filter(Boolean)
    .join('\n');
}

function renderInlineTaxonomyLinks(slugs, taxonomyBySlug, kind) {
  const links = slugs
    .map((slug) => taxonomyBySlug.get(slug))
    .filter(Boolean)
    .map((item) => {
      const base = kind === 'category' ? '/categories/' : '/tags/';
      const className = kind === 'category' ? 'category-link' : 'tag-link';
      return `<a href="${base}${escapeHtml(encodeSlugSegment(item.slug))}/" class="${className}">${escapeHtml(item.name)}</a>`;
    });

  if (links.length === 0) {
    return '';
  }

  return kind === 'category' ? links.join(', ') : links.join(' ');
}

function renderPagination(paginationData) {
  if (paginationData.totalPages <= 1) {
    return '';
  }

  const prevLink = paginationData.hasPrev && paginationData.prevUrl
    ? `<a href="${paginationData.prevUrl}" class="prev">Previous</a>`
    : '';
  const nextLink = paginationData.hasNext && paginationData.nextUrl
    ? `<a href="${paginationData.nextUrl}" class="next">Next</a>`
    : '';
  const pageLinks = paginationData.pages
    .map((page) => `<a href="${page.url}" class="page-link ${page.current ? 'current' : ''}">${page.number}</a>`)
    .join(' ');

  return `<nav class="pagination">\n  ${prevLink}\n  <span class="pages">${pageLinks}</span>\n  ${nextLink}\n</nav>`;
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

async function assertValidThemePackage(themePackage) {
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
    ...(themePackage.metadata.menuSlots ? { menuSlots: themePackage.metadata.menuSlots } : {}),
    ...(themePackage.metadata.widgetAreas ? { widgetAreas: themePackage.metadata.widgetAreas } : {}),
    settings: themePackage.metadata.settings || {},
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

function buildPageMeta(site, options = {}) {
  const resolvedTitle = normalizeNonEmptyString(options.title, site.title);
  const resolvedDescription = normalizeOptionalString(options.description);
  const canonicalUrl = resolveMetaCanonicalUrl(site, options.currentUrl);
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
    return normalizedImage;
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
    return normalizedValue;
  }

  const normalizedBaseUrl = normalizeOptionalString(mediaBaseUrl);
  if (!normalizedBaseUrl) {
    return '';
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

function routePathToOutputPath(routePath) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (normalizedPath === '/') {
    return 'index.html';
  }
  return `${normalizedPath.replace(/^\//, '')}index.html`;
}

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') {
    return '/';
  }
  const normalized = decodeRoutePath(String(routePath)).replace(/^\/+|\/+$/g, '');
  return `/${normalized}/`;
}

function normalizeOutputPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}

function assertPlannedOutputPathsSafe(state) {
  for (const post of state.renderData.posts) {
    assertSafeSlugDerivedOutputPath(post.slug, `posts/${encodeSlugSegment(post.slug)}/index.html`);
  }

  for (const page of state.renderData.pages) {
    assertSafeSlugDerivedOutputPath(page.slug, `${encodeSlugSegment(page.slug)}/index.html`);
  }

  for (const category of state.previewData.content.categories) {
    assertSafeSlugDerivedOutputPath(category.slug, `categories/${encodeSlugSegment(category.slug)}/index.html`);
  }

  for (const tag of state.previewData.content.tags) {
    assertSafeSlugDerivedOutputPath(tag.slug, `tags/${encodeSlugSegment(tag.slug)}/index.html`);
  }

  const plannedPaths = [
    ...state.renderData.indexRoutes.map((route) => routePathToOutputPath(route.path)),
    ...state.renderData.archiveRoutes.map((route) => routePathToOutputPath(route.path)),
    ...state.renderData.categoryRoutes.map((route) => routePathToOutputPath(route.path)),
    ...state.renderData.tagRoutes.map((route) => routePathToOutputPath(route.path)),
    ...state.renderData.posts.map((post) => `posts/${encodeSlugSegment(post.slug)}/index.html`),
    ...state.renderData.pages.map((page) => `${encodeSlugSegment(page.slug)}/index.html`),
    ...state.assetOutputs.map((assetOutput) => assetOutput.path),
  ];

  if (state.options.generateSpecialFiles) {
    plannedPaths.push('404.html', 'robots.txt', 'meta.json');
    if (hasCanonicalSiteUrl(state.previewData.site.url)) {
      plannedPaths.push('sitemap.xml', 'feed.xml');
    }
  }

  for (const plannedPath of plannedPaths) {
    const rawPath = String(plannedPath || '');
    const normalizedPath = normalizeOutputPath(rawPath);
    assertSafeRelativeOutputPath(rawPath, normalizedPath);
  }
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

function injectHtmxScript(html) {
  return html.replace('</body>', '<script src="https://unpkg.com/htmx.org@2.0.4" crossorigin="anonymous"></script>\n</body>');
}

function injectCustomCssAssetLink(html, href) {
  if (!normalizeOptionalString(href)) {
    return html;
  }

  return html.replace('</head>', `  <link rel="stylesheet" href="${escapeHtml(href)}">\n</head>`);
}

function buildSitemapXml(site, emitted, generatedAt) {
  const entries = [
    ...emitted.indexRoutes
      .filter((route) => route.url === '/')
      .map((route) => ({
        url: route.url,
        changefreq: 'daily',
        priority: 1.0,
      })),
    ...emitted.posts.map((post) => ({
      url: post.url,
      lastmod: toDate(post.updatedAt),
      changefreq: 'weekly',
      priority: 0.8,
    })),
    ...emitted.pages.map((page) => ({
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
  const lines = ['User-agent: *', 'Allow: /'];
  if (site.url) {
    lines.push('', `Sitemap: ${resolveSiteUrl(site.url, '/sitemap.xml')}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildMetaJson(site, emitted, generatedAt) {
  const pages = [
    ...emitted.posts.map((post) => ({
      url: post.url,
      title: post.title,
      description: post.description,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
      type: 'post',
      metadata: { status: post.status },
    })),
    ...emitted.pages.map((page) => ({
      url: page.url,
      title: page.title,
      description: page.description,
      type: 'page',
      metadata: { status: page.status },
    })),
  ];

  return JSON.stringify({
    generated: formatUtcIsoSeconds(generatedAt),
    site: {
      title: site.title,
      description: site.description,
      url: site.url,
      locale: site.locale,
    },
    pages,
  }, null, 2);
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
