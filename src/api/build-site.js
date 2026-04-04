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

export async function buildSite(input) {
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const state = await createBuildState(input, options);

  for (const route of input.previewData.routes.index) {
    await renderRoute(state, 'index', route);
  }

  for (const post of input.previewData.content.posts) {
    await renderPost(state, post);
  }

  for (const page of input.previewData.content.pages) {
    await renderPage(state, page);
  }

  for (const route of input.previewData.routes.categories) {
    await renderRoute(state, 'category', route);
  }

  for (const route of input.previewData.routes.tags) {
    await renderRoute(state, 'tag', route);
  }

  for (const route of input.previewData.routes.archive) {
    await renderRoute(state, 'archive', route);
  }

  for (const assetOutput of state.assetOutputs) {
    await writeOutput(state.writer, state.summaries, assetOutput.path, assetOutput.content, assetOutput.contentType);
  }

  if (options.generateSpecialFiles) {
    await maybeRenderNotFoundPage(state);
    await writeOutput(state.writer, state.summaries, 'sitemap.xml', buildSitemapXml(input.previewData), 'application/xml');
    await writeOutput(state.writer, state.summaries, 'feed.xml', buildFeedXml(input.previewData), 'application/rss+xml');
    await writeOutput(state.writer, state.summaries, 'robots.txt', buildRobotsTxt(input.previewData), 'text/plain');
    await writeOutput(state.writer, state.summaries, 'meta.json', buildMetaJson(input.previewData), 'application/json');
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

  for (const post of input.previewData.content.posts) {
    if (selectedPostSlugs.has(post.slug)) {
      await renderPost(state, post);
    }
  }

  for (const route of input.previewData.routes.index) {
    if (selectedIndexRoutes.has(normalizeRoutePath(route.path))) {
      await renderRoute(state, 'index', route);
    }
  }

  for (const route of input.previewData.routes.archive) {
    if (selectedArchiveRoutes.has(normalizeRoutePath(route.path))) {
      await renderRoute(state, 'archive', route);
    }
  }

  for (const route of input.previewData.routes.categories) {
    if (selectedCategoryRoutes.has(normalizeRoutePath(route.path))) {
      await renderRoute(state, 'category', route);
    }
  }

  for (const route of input.previewData.routes.tags) {
    if (selectedTagRoutes.has(normalizeRoutePath(route.path))) {
      await renderRoute(state, 'tag', route);
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

  engine.initialize(themePackage);

  const assetOutputs = await buildAssetOutputs(themePackage.assets, assetProcessor, options);
  const assetMap = new Map(
    assetOutputs.map((asset) => [`/assets/${asset.originalPath}`, `/${asset.path}`]),
  );

  return {
    writer: input.writer,
    previewData: input.previewData,
    engine,
    assetProcessor,
    summaries,
    assetOutputs,
    assetMap,
    options,
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
}

async function renderPost(state, post) {
  let html = await state.engine.render(
    'post',
    { post },
    createRenderContext(state.previewData.site, `/posts/${encodeSlugSegment(post.slug)}/`),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  if (state.options.injectHtmx) {
    html = injectHtmxScript(html);
  }
  await writeOutput(state.writer, state.summaries, `posts/${encodeSlugSegment(post.slug)}/index.html`, html, 'text/html');
}

async function renderPage(state, page) {
  let html = await state.engine.render(
    'page',
    { page },
    createRenderContext(state.previewData.site, `/${encodeSlugSegment(page.slug)}/`),
  );
  html = state.assetProcessor.updateAssetReferences(html, state.assetMap);
  await writeOutput(state.writer, state.summaries, `${encodeSlugSegment(page.slug)}/index.html`, html, 'text/html');
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

function buildSitemapXml(previewData) {
  const entries = [
    { url: '/', lastmod: new Date(), changefreq: 'daily', priority: 1.0 },
    ...previewData.content.posts.map((post) => ({
      url: `/posts/${encodeSlugSegment(post.slug)}/`,
      lastmod: toDate(post.updated_at_iso),
      changefreq: 'weekly',
      priority: 0.8,
    })),
    ...previewData.content.pages.map((page) => ({
      url: `/${encodeSlugSegment(page.slug)}/`,
      lastmod: new Date(),
      changefreq: 'monthly',
      priority: 0.7,
    })),
    ...previewData.content.categories.filter((category) => category.postCount > 0).map((category) => ({
      url: `/categories/${encodeSlugSegment(category.slug)}/`,
      lastmod: new Date(),
      changefreq: 'weekly',
      priority: 0.6,
    })),
    ...previewData.content.tags.filter((tag) => tag.postCount > 0).map((tag) => ({
      url: `/tags/${encodeSlugSegment(tag.slug)}/`,
      lastmod: new Date(),
      changefreq: 'weekly',
      priority: 0.5,
    })),
  ];

  const body = entries.map((entry) => {
    const loc = escapeXml(resolveSiteUrl(previewData.site.url, entry.url));
    const lastmod = entry.lastmod.toISOString().split('T')[0];
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority.toFixed(1)}</priority>\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

function buildFeedXml(previewData) {
  const items = [...previewData.content.posts]
    .sort((a, b) => toDate(b.published_at_iso).getTime() - toDate(a.published_at_iso).getTime())
    .slice(0, 20)
    .map((post) => {
      const url = resolveSiteUrl(previewData.site.url, `/posts/${encodeSlugSegment(post.slug)}/`);
      return `    <item>\n      <title>${escapeXml(post.title)}</title>\n      <link>${escapeXml(url)}</link>\n      <guid>${escapeXml(url)}</guid>\n      <pubDate>${toDate(post.published_at_iso).toUTCString()}</pubDate>\n      <description>${escapeXml(post.excerpt)}</description>\n    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(previewData.site.title)}</title>\n    <link>${escapeXml(previewData.site.url)}</link>\n    <description>${escapeXml(previewData.site.description)}</description>\n    <language>${previewData.site.language}</language>\n    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n    <atom:link href="${escapeXml(new URL('/feed.xml', previewData.site.url).toString())}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>`;
}

function buildRobotsTxt(previewData) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${previewData.site.url}/sitemap.xml\n`;
}

function buildMetaJson(previewData) {
  const pages = [
    ...previewData.content.posts.map((post) => ({
      url: `/posts/${encodeSlugSegment(post.slug)}/`,
      title: post.title,
      description: post.excerpt,
      publishedAt: post.published_at_iso,
      updatedAt: post.updated_at_iso,
      type: 'post',
      metadata: { status: post.status },
    })),
    ...previewData.content.pages.map((page) => ({
      url: `/${encodeSlugSegment(page.slug)}/`,
      title: page.title,
      type: 'page',
      metadata: { status: page.status },
    })),
  ];

  return JSON.stringify({
    generated: new Date().toISOString(),
    site: {
      title: previewData.site.title,
      description: previewData.site.description,
      url: previewData.site.url,
      language: previewData.site.language,
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
