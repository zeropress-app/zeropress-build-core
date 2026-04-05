import { createHash } from 'node:crypto';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import { validateThemeFiles } from '@zeropress/theme-validator';
import { AssetProcessor } from '../assets/asset-processor.js';
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
const COMMENTS_HTML = '<section id="comments"></section>';

export async function buildSite(input) {
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const state = await createBuildState(input, options);

  for (const route of state.renderData.indexRoutes) {
    await renderRoute(state, 'index', route);
  }

  for (const post of state.renderData.posts) {
    await renderPost(state, post);
  }

  for (const page of state.previewData.content.pages) {
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
    await writeOutput(state.writer, state.summaries, 'sitemap.xml', buildSitemapXml(state.previewData.site, state.emitted, state.generatedAt), 'application/xml');
    await writeOutput(state.writer, state.summaries, 'feed.xml', buildFeedXml(state.previewData.site, state.emitted, state.generatedAt), 'application/rss+xml');
    await writeOutput(state.writer, state.summaries, 'robots.txt', buildRobotsTxt(state.previewData.site), 'text/plain');
    await writeOutput(state.writer, state.summaries, 'meta.json', buildMetaJson(state.previewData.site, state.emitted, state.generatedAt), 'application/json');
  }

  return finalizeBuildResult(state.writer, state.summaries, options);
}

export async function buildSelectedRoutes(input) {
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  validateSelection(input.selection);

  const state = await createBuildState(input, options);
  const selectedPostSlugs = new Set((input.selection.posts || []).map((slug) => String(slug)));
  const selectedIndexRoutes = new Set((input.selection.indexRoutes || []).map((route) => normalizeRoutePath(route)));
  const selectedArchiveRoutes = new Set((input.selection.archiveRoutes || []).map((route) => normalizeRoutePath(route)));
  const selectedCategoryRoutes = new Set((input.selection.categoryRoutes || []).map((route) => normalizeRoutePath(route)));
  const selectedTagRoutes = new Set((input.selection.tagRoutes || []).map((route) => normalizeRoutePath(route)));

  for (const post of state.renderData.posts) {
    if (selectedPostSlugs.has(post.slug)) {
      await renderPost(state, post);
    }
  }

  for (const route of state.renderData.indexRoutes) {
    if (selectedIndexRoutes.has(normalizeRoutePath(route.path))) {
      await renderRoute(state, 'index', route);
    }
  }

  if (hasTemplate(state, 'archive')) {
    for (const route of state.renderData.archiveRoutes) {
      if (selectedArchiveRoutes.has(normalizeRoutePath(route.path))) {
        await renderRoute(state, 'archive', route);
      }
    }
  }

  if (hasTemplate(state, 'category')) {
    for (const route of state.renderData.categoryRoutes) {
      if (selectedCategoryRoutes.has(normalizeRoutePath(route.path))) {
        await renderRoute(state, 'category', route);
      }
    }
  }

  if (hasTemplate(state, 'tag')) {
    for (const route of state.renderData.tagRoutes) {
      if (selectedTagRoutes.has(normalizeRoutePath(route.path))) {
        await renderRoute(state, 'tag', route);
      }
    }
  }

  if (input.selection.includeAssets) {
    for (const assetOutput of state.assetOutputs) {
      await writeOutput(state.writer, state.summaries, assetOutput.path, assetOutput.content, assetOutput.contentType);
    }
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

  engine.initialize(themePackage);

  const assetOutputs = await buildAssetOutputs(themePackage.assets, assetProcessor, options);
  const assetMap = new Map(
    assetOutputs.map((asset) => [`/assets/${asset.originalPath}`, `/${asset.path}`]),
  );

  return {
    writer: input.writer,
    previewData,
    renderData: createRenderData(previewData),
    engine,
    assetProcessor,
    summaries,
    assetOutputs,
    assetMap,
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
      generatedAt: new Date().toISOString(),
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
    { ...route },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  await writeOutput(state.writer, state.summaries, routePathToOutputPath(route.path), html, 'text/html');
  recordRouteEmission(state, templateName, route, currentUrl);
}

async function renderPost(state, post) {
  const currentUrl = `/posts/${encodeSlugSegment(post.slug)}/`;
  let html = await state.engine.render(
    'post',
    { post },
    createRenderContext(state.previewData.site, currentUrl),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
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
  let html = await state.engine.render(
    'page',
    { page },
    createRenderContext(state.previewData.site, `/${encodeSlugSegment(page.slug)}/`),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  await writeOutput(state.writer, state.summaries, `${encodeSlugSegment(page.slug)}/index.html`, html, 'text/html');
  state.emitted.pages.push({
    url: `/${encodeSlugSegment(page.slug)}/`,
    title: page.title,
    status: page.status,
  });
}

async function maybeRenderNotFoundPage(state) {
  if (!state.engine.themePackage?.templates?.has('404')) {
    return;
  }

  let html = await state.engine.render(
    '404',
    {},
    createRenderContext(state.previewData.site, '/404.html'),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  await writeOutput(state.writer, state.summaries, '404.html', html, 'text/html');
}

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    throw new Error('buildSelectedRoutes requires a selection object');
  }

  const keys = ['posts', 'indexRoutes', 'archiveRoutes', 'categoryRoutes', 'tagRoutes'];
  for (const key of keys) {
    if (!Array.isArray(selection[key])) {
      throw new Error(`buildSelectedRoutes selection.${key} must be an array`);
    }
  }

  if (typeof selection.includeAssets !== 'boolean') {
    throw new Error('buildSelectedRoutes selection.includeAssets must be a boolean');
  }
}

function normalizePreviewData(previewData) {
  return {
    ...previewData,
    site: {
      ...previewData.site,
      postsPerPage: Number.isInteger(previewData.site.postsPerPage) && previewData.site.postsPerPage > 0
        ? previewData.site.postsPerPage
        : DEFAULT_POSTS_PER_PAGE,
      dateFormat: normalizeNonEmptyString(previewData.site.dateFormat, DEFAULT_DATE_FORMAT),
      timeFormat: typeof previewData.site.timeFormat === 'string' ? previewData.site.timeFormat : DEFAULT_TIME_FORMAT,
      siteTimezone: normalizeNonEmptyString(previewData.site.siteTimezone, DEFAULT_TIMEZONE),
      siteLocale: normalizeLocale(previewData.site.siteLocale || previewData.site.language || DEFAULT_LOCALE),
    },
    content: {
      ...previewData.content,
      posts: [...previewData.content.posts].sort((left, right) => toDate(right.published_at_iso).getTime() - toDate(left.published_at_iso).getTime()),
      pages: [...previewData.content.pages],
      categories: [...previewData.content.categories],
      tags: [...previewData.content.tags],
    },
  };
}

function createRenderData(previewData) {
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

  const posts = previewData.content.posts.map((post) => preparePost(post, previewData.site, categoriesBySlug, tagsBySlug));
  const postBySlug = new Map(posts.map((post) => [post.slug, post]));
  const categoryLinks = renderCategoryLinks(previewData.content.categories, categoryCountBySlug);
  const tagLinks = renderTagLinks(previewData.content.tags, tagCountBySlug);

  return {
    posts,
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

function preparePost(post, site, categoriesBySlug, tagsBySlug) {
  return {
    ...post,
    published_at: formatTimestamp(post.published_at_iso, site),
    updated_at: formatTimestamp(post.updated_at_iso, site),
    reading_time: calculateReadingTime(post.html),
    categories_html: renderInlineTaxonomyLinks(post.category_slugs, categoriesBySlug, 'category'),
    tags_html: renderInlineTaxonomyLinks(post.tag_slugs, tagsBySlug, 'tag'),
    comments_html: COMMENTS_HTML,
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

function formatTimestamp(value, site) {
  const date = toDate(value);
  const locale = normalizeLocale(site.siteLocale || site.language || DEFAULT_LOCALE);
  const dateFormat = normalizeNonEmptyString(site.dateFormat, DEFAULT_DATE_FORMAT);
  const timeFormat = typeof site.timeFormat === 'string' ? site.timeFormat : DEFAULT_TIME_FORMAT;
  const siteTimezone = normalizeNonEmptyString(site.siteTimezone, DEFAULT_TIMEZONE);

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

function createRenderContext(site, currentUrl) {
  return {
    site,
    currentUrl,
    language: site.language,
  };
}

async function writeOutput(writer, summaries, path, content, contentType) {
  const normalizedPath = normalizeOutputPath(path);
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

function buildSitemapXml(site, emitted, generatedAt) {
  const entries = [
    ...emitted.indexRoutes
      .filter((route) => route.url === '/')
      .map((route) => ({
        url: route.url,
        lastmod: generatedAt,
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
      lastmod: generatedAt,
      changefreq: 'monthly',
      priority: 0.7,
    })),
    ...emitted.categoryRoutes.filter((route) => route.page === 1).map((route) => ({
      url: route.url,
      lastmod: generatedAt,
      changefreq: 'weekly',
      priority: 0.6,
    })),
    ...emitted.tagRoutes.filter((route) => route.page === 1).map((route) => ({
      url: route.url,
      lastmod: generatedAt,
      changefreq: 'weekly',
      priority: 0.5,
    })),
  ];

  const body = entries.map((entry) => {
    const loc = escapeXml(resolveSiteUrl(site.url, entry.url));
    const lastmod = entry.lastmod.toISOString().split('T')[0];
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority.toFixed(1)}</priority>\n  </url>`;
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

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(site.title)}</title>\n    <link>${escapeXml(channelLink)}</link>\n    <description>${escapeXml(site.description)}</description>\n    <language>${site.language}</language>\n    <lastBuildDate>${generatedAt.toUTCString()}</lastBuildDate>\n    <atom:link href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>`;
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
      type: 'page',
      metadata: { status: page.status },
    })),
  ];

  return JSON.stringify({
    generated: generatedAt.toISOString(),
    site: {
      title: site.title,
      description: site.description,
      url: site.url,
      language: site.language,
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

function normalizeStoredSlug(slug) {
  if (typeof slug !== 'string') {
    return '';
  }

  const trimmed = slug.trim();
  if (!trimmed.includes('%')) {
    return trimmed;
  }

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
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

function toDate(value) {
  return value ? new Date(value) : new Date();
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
