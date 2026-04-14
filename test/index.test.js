import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, buildSiteFromThemeDir, FilesystemWriter, MemoryWriter } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const goldenDir = path.join(__dirname, 'golden', 'default-preview');
const goldenThemeDir = path.join(fixturesDir, 'golden-theme');

async function loadDefaultPreviewData() {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, 'default-preview-data.v0.3.json'), 'utf8'));
}

async function loadMediumPreviewData() {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, 'medium-preview-data.v0.3.json'), 'utf8'));
}

async function loadGoldenThemePackage() {
  const templateNames = ['layout', 'index', 'archive', 'category', 'tag', 'post', 'page', '404'];
  const partialNames = ['header', 'footer'];
  const templates = new Map();
  const partials = new Map();
  const assets = new Map();
  const metadata = JSON.parse(await fs.readFile(path.join(goldenThemeDir, 'theme.json'), 'utf8'));

  for (const name of templateNames) {
    templates.set(name, await fs.readFile(path.join(goldenThemeDir, `${name}.html`), 'utf8'));
  }

  for (const name of partialNames) {
    partials.set(name, await fs.readFile(path.join(goldenThemeDir, 'partials', `${name}.html`), 'utf8'));
  }

  assets.set('style.css', await fs.readFile(path.join(goldenThemeDir, 'assets', 'style.css')));

  return {
    metadata: {
      ...metadata,
      settings: metadata.settings || {},
    },
    templates,
    partials,
    assets,
  };
}

function cloneThemePackage(themePackage) {
  return {
    metadata: { ...themePackage.metadata },
    templates: new Map(themePackage.templates),
    partials: new Map(themePackage.partials),
    assets: new Map(themePackage.assets),
  };
}

function withoutTemplates(themePackage, templateNames) {
  const next = cloneThemePackage(themePackage);
  for (const templateName of templateNames) {
    next.templates.delete(templateName);
  }
  return next;
}

function getFileContent(files, outputPath) {
  const file = files.find((entry) => entry.path === outputPath);
  assert.ok(file, `Expected output file ${outputPath} to exist`);
  return typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('utf8');
}

function normalizeFeedXml(xml) {
  return xml.replace(
    /<lastBuildDate>[^<]+<\/lastBuildDate>/,
    '<lastBuildDate>__LAST_BUILD_DATE__</lastBuildDate>',
  );
}

function normalizeMetaJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  parsed.generated = '__GENERATED_AT__';
  return JSON.stringify(parsed, null, 2);
}

function normalizeManifestSummary(jsonText) {
  const parsed = JSON.parse(jsonText);
  return JSON.stringify({
    files: parsed.files.map(({ path: filePath, contentType }) => ({ path: filePath, contentType })),
  }, null, 2);
}

function normalizeSitemapXml(xml) {
  return xml;
}

async function readGolden(relativePath) {
  return fs.readFile(path.join(goldenDir, relativePath), 'utf8');
}

test('buildSite matches the golden fixture for the default preview payload', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  const result = await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  const asset = files.find((file) => /^assets\/style\.[a-f0-9]{8}\.css$/.test(file.path));
  assert.ok(asset, 'Expected a hashed stylesheet asset to be emitted');
  assert.equal(asset.path, 'assets/style.494f4abf.css');
  assert.equal(result.files.some((file) => file.path === 'page/2/index.html'), true);

  const comparisons = [
    ['index.html', getFileContent(files, 'index.html')],
    ['page/2/index.html', getFileContent(files, 'page/2/index.html')],
    ['archive/index.html', getFileContent(files, 'archive/index.html')],
    ['categories/general/index.html', getFileContent(files, 'categories/general/index.html')],
    ['tags/intro/index.html', getFileContent(files, 'tags/intro/index.html')],
    ['posts/hello-zeropress/index.html', getFileContent(files, 'posts/hello-zeropress/index.html')],
    ['about/index.html', getFileContent(files, 'about/index.html')],
    ['404.html', getFileContent(files, '404.html')],
    ['robots.txt', getFileContent(files, 'robots.txt')],
    ['feed.xml', normalizeFeedXml(getFileContent(files, 'feed.xml'))],
    ['sitemap.xml', normalizeSitemapXml(getFileContent(files, 'sitemap.xml'))],
    ['meta.json', normalizeMetaJson(getFileContent(files, 'meta.json'))],
    ['build-manifest.summary.json', normalizeManifestSummary(getFileContent(files, 'build-manifest.json'))],
  ];

  for (const [relativePath, actual] of comparisons) {
    const expected = await readGolden(relativePath);
    assert.equal(actual.trim(), expected.trim(), `Golden fixture mismatch for ${relativePath}`);
  }
});

test('buildSiteFromThemeDir loads the golden fixture theme directory and FilesystemWriter writes files to disk', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-core-out-'));

  try {
    const writer = new FilesystemWriter({ outDir });
    await buildSiteFromThemeDir({
      previewData: await loadDefaultPreviewData(),
      themeDir: goldenThemeDir,
      writer,
      options: { generateSpecialFiles: false, injectHtmx: false },
    });

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const postHtml = await fs.readFile(path.join(outDir, 'posts', 'hello-zeropress', 'index.html'), 'utf8');
    assert.match(indexHtml, /Hello ZeroPress/);
    assert.match(postHtml, /Preview post content/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('buildSite supports medium fixture with raw Unicode slugs and paginated taxonomy routes', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadMediumPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  const postSlug = '안녕하세요-제로프레스';
  const secondPostSlug = '디자인-시스템-가이드';
  const pageSlug = '회사소개';
  const categorySlug = '디자인';
  const tagSlug = '한글';

  const expectedPaths = [
    `posts/${postSlug}/index.html`,
    `posts/${secondPostSlug}/index.html`,
    `${pageSlug}/index.html`,
    'page/2/index.html',
    `categories/${categorySlug}/index.html`,
    `categories/${categorySlug}/page/2/index.html`,
    `tags/${tagSlug}/index.html`,
    `tags/${tagSlug}/page/2/index.html`,
  ];

  for (const outputPath of expectedPaths) {
    assert.equal(files.some((file) => file.path === outputPath), true, `Expected ${outputPath} to be generated`);
  }

  const postHtml = getFileContent(files, `posts/${postSlug}/index.html`);
  assert.match(postHtml, /안녕하세요 제로프레스/);

  const pageHtml = getFileContent(files, `${pageSlug}/index.html`);
  assert.match(pageHtml, /회사 소개/);
  assert.match(pageHtml, /ZeroPress 소개 페이지입니다/);

  const categoryPageTwoHtml = getFileContent(files, `categories/${categorySlug}/page/2/index.html`);
  assert.match(categoryPageTwoHtml, /Taxonomy Coverage Check/);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.ok(sitemapXml.includes(`https://example.kr/posts/${postSlug}/`));
  assert.ok(sitemapXml.includes(`https://example.kr/${pageSlug}/`));
  assert.equal(sitemapXml.includes(`https://example.kr/categories/${categorySlug}/`), false);
  assert.equal(sitemapXml.includes(`https://example.kr/tags/${tagSlug}/`), false);

  const metaJson = JSON.parse(getFileContent(files, 'meta.json'));
  assert.equal(metaJson.site.locale, 'ko-KR');
  assert.equal(metaJson.pages.some((page) => page.url === `/posts/${postSlug}/`), true);
  assert.equal(metaJson.pages.some((page) => page.url === `/${pageSlug}/`), true);

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  for (const outputPath of expectedPaths) {
    assert.equal(manifest.files.some((file) => file.path === outputPath), true, `Expected ${outputPath} in manifest`);
  }
});

test('buildSite uses escaped post excerpt for meta description on post pages', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.description = 'Site "description" fallback';
  previewData.content.posts[0].excerpt = 'Post "excerpt" & summary';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /<meta name="description" content="Post &quot;excerpt&quot; &amp; summary">/);
  assert.doesNotMatch(pageHtml, /<meta name="description"/);
});

test('buildSite renders SEO meta for post and page routes', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.mediaBaseUrl = 'https://media.example.com';
  previewData.content.posts[0].featured_image = '/images/post-share.png';
  previewData.content.pages[0].excerpt = 'About page summary';
  previewData.content.pages[0].featured_image = './images/page-share.png';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /<title>Hello ZeroPress - ZeroPress Preview<\/title>/);
  assert.match(postHtml, /property="og:type" content="article"/);
  assert.match(postHtml, /property="og:url" content="https:\/\/example\.com\/posts\/hello-zeropress\/"/);
  assert.match(postHtml, /property="og:image" content="https:\/\/media\.example\.com\/images\/post-share\.png"/);
  assert.match(postHtml, /property="article:published_time" content="2026-02-14T09:00:00Z"/);
  assert.match(postHtml, /property="article:modified_time" content="2026-02-14T09:00:00Z"/);

  assert.match(pageHtml, /<title>About - ZeroPress Preview<\/title>/);
  assert.match(pageHtml, /<meta name="description" content="About page summary">/);
  assert.match(pageHtml, /property="og:type" content="website"/);
  assert.match(pageHtml, /property="og:image" content="https:\/\/media\.example\.com\/images\/page-share\.png"/);
  assert.doesNotMatch(pageHtml, /property="article:published_time"/);
  assert.doesNotMatch(pageHtml, /property="article:modified_time"/);
});

test('buildSite omits canonical and og:url when site.url is empty and still emits og:image from mediaBaseUrl', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.url = '';
  previewData.site.mediaBaseUrl = 'https://media.example.com';
  previewData.content.posts[0].featured_image = '/images/post-share.png';
  previewData.content.pages[0].featured_image = 'https://cdn.example.com/page-share.png';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.doesNotMatch(postHtml, /rel="canonical"/);
  assert.doesNotMatch(postHtml, /property="og:url"/);
  assert.match(postHtml, /property="og:image" content="https:\/\/media\.example\.com\/images\/post-share\.png"/);
  assert.doesNotMatch(pageHtml, /rel="canonical"/);
  assert.doesNotMatch(pageHtml, /property="og:url"/);
  assert.match(pageHtml, /property="og:image" content="https:\/\/cdn\.example\.com\/page-share\.png"/);
});

test('buildSite normalizes media fields against site.mediaBaseUrl before rendering', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.mediaBaseUrl = 'https://media.example.com/base/';
  previewData.content.authors[0].avatar = '/avatars/author.png?size=96';
  previewData.content.posts[0].featured_image = './images/post-share.png?fit=cover';
  previewData.content.pages[0].featured_image = '/images/page-share.png?format=webp';

  themePackage.templates.set('post', [
    '<article',
    ' data-author-avatar="{{post.author_avatar}}"',
    ' data-featured-image="{{post.featured_image}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', '<section data-featured-image="{{page.featured_image}}">{{page.title}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /data-author-avatar="https:\/\/media\.example\.com\/avatars\/author\.png\?size=96"/);
  assert.match(postHtml, /data-featured-image="https:\/\/media\.example\.com\/base\/images\/post-share\.png\?fit=cover"/);
  assert.match(pageHtml, /data-featured-image="https:\/\/media\.example\.com\/images\/page-share\.png\?format=webp"/);
});

test('buildSite blanks unresolved relative media fields when site.mediaBaseUrl is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.authors[0].avatar = '/avatars/author.png';
  previewData.content.posts[0].featured_image = './images/post-share.png';
  previewData.content.pages[0].featured_image = '/images/page-share.png';

  themePackage.templates.set('post', [
    '<article',
    ' data-author-avatar="{{post.author_avatar}}"',
    ' data-featured-image="{{post.featured_image}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', '<section data-featured-image="{{page.featured_image}}">{{page.title}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /data-author-avatar=""/);
  assert.match(postHtml, /data-featured-image=""/);
  assert.match(pageHtml, /data-featured-image=""/);
  assert.doesNotMatch(postHtml, /property="og:image"/);
});

test('buildSite skips sitemap.xml and feed.xml when site.url is empty', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.url = '';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === 'sitemap.xml'), false);
  assert.equal(files.some((file) => file.path === 'feed.xml'), false);
  assert.equal(files.some((file) => file.path === 'robots.txt'), true);
  assert.equal(files.some((file) => file.path === 'meta.json'), true);

  const robotsTxt = getFileContent(files, 'robots.txt');
  assert.equal(robotsTxt.trim(), 'User-agent: *\nAllow: /');

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(manifest.files.some((file) => file.path === 'sitemap.xml'), false);
  assert.equal(manifest.files.some((file) => file.path === 'feed.xml'), false);
});

test('buildSite skips archive routes when archive template is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = withoutTemplates(await loadGoldenThemePackage(), ['archive']);

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === 'archive/index.html'), false);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.equal(sitemapXml.includes('https://example.com/archive/'), false);
});

test('buildSite skips category routes and sitemap entries when category template is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = withoutTemplates(await loadGoldenThemePackage(), ['category']);

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path.startsWith('categories/')), false);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.equal(sitemapXml.includes('https://example.com/categories/general/'), false);
});

test('buildSite skips tag routes and sitemap entries when tag template is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = withoutTemplates(await loadGoldenThemePackage(), ['tag']);

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path.startsWith('tags/')), false);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.equal(sitemapXml.includes('https://example.com/tags/intro/'), false);
});

test('buildSite emits only renderable special-file URLs when optional route templates are missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = withoutTemplates(await loadGoldenThemePackage(), ['archive', 'category', 'tag']);

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === 'index.html'), true);
  assert.equal(files.some((file) => file.path === 'posts/hello-zeropress/index.html'), true);
  assert.equal(files.some((file) => file.path === 'about/index.html'), true);
  assert.equal(files.some((file) => file.path === 'robots.txt'), true);
  assert.equal(files.some((file) => file.path === 'archive/index.html'), false);
  assert.equal(files.some((file) => file.path.startsWith('categories/')), false);
  assert.equal(files.some((file) => file.path.startsWith('tags/')), false);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.equal(sitemapXml.includes('https://example.com/archive/'), false);
  assert.equal(sitemapXml.includes('https://example.com/categories/general/'), false);
  assert.equal(sitemapXml.includes('https://example.com/tags/intro/'), false);
  assert.equal(sitemapXml.includes('https://example.com/posts/hello-zeropress/'), true);
  assert.equal(sitemapXml.includes('https://example.com/about/'), true);

  const metaJson = JSON.parse(getFileContent(files, 'meta.json'));
  assert.equal(metaJson.pages.some((page) => page.url === '/posts/hello-zeropress/'), true);
  assert.equal(metaJson.pages.some((page) => page.url === '/about/'), true);
});

test('buildSite skips 404.html when the theme does not provide a 404 template', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = withoutTemplates(await loadGoldenThemePackage(), ['404']);

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  assert.equal(writer.getFiles().some((file) => file.path === '404.html'), false);
});

test('buildSite omits comment container markup when site.disallowComments is true', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.disallowComments = true;

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.equal(postHtml.includes('hx-get="/api/comments/post-1"'), false);
  assert.equal(postHtml.includes('<section id="comments" class="zp-comments">'), false);
});

test('buildSite omits comment container markup when post.allow_comments is false', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[0].allow_comments = false;

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.equal(postHtml.includes('hx-get="/api/comments/post-1"'), false);
  assert.equal(postHtml.includes('<section id="comments" class="zp-comments">'), false);
});

test('buildSite renders comment shell with worker-compatible endpoints when comments are enabled', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.equal(postHtml.includes('hx-get="/api/comments/post-1"'), true);
  assert.equal(postHtml.includes('hx-post="/api/comments/post-1"'), true);
});

test('buildSite renders v0.5 raw content and resolves post author data from authors', async () => {
  const writer = new MemoryWriter();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('post', '<article class="post-entry">{{post.author_name}}|{{post.author_avatar}}|{{post.html}}</article>');
  themePackage.templates.set('page', '<article class="page-entry">{{page.html}}</article>');

  await buildSite({
    previewData: {
      version: '0.5',
      generator: 'test-suite',
      generated_at: '2026-04-02T00:00:00Z',
      site: {
        title: 'ZeroPress',
        description: 'Test preview data',
        url: 'https://example.com',
        mediaBaseUrl: 'https://media.example.com',
        locale: 'en-US',
        postsPerPage: 10,
        dateFormat: 'YYYY-MM-DD',
        timeFormat: 'HH:mm',
        timezone: 'UTC',
        disallowComments: true,
      },
      content: {
        authors: [
          {
            id: 'author-1',
            display_name: 'Admin',
            avatar: '/avatars/admin.webp',
          },
        ],
        posts: [
          {
            id: 'post-1',
            public_id: 1,
            title: 'Markdown Post',
            slug: 'markdown-post',
            content: '# Markdown Heading\n\nParagraph text.',
            document_type: 'markdown',
            excerpt: 'Markdown excerpt',
            published_at_iso: '2026-04-02T00:00:00Z',
            updated_at_iso: '2026-04-02T00:00:00Z',
            author_id: 'author-1',
            status: 'published',
            allow_comments: true,
            category_slugs: [],
            tag_slugs: [],
          },
        ],
        pages: [
          {
            title: 'Plaintext Page',
            slug: 'plaintext-page',
            content: 'First paragraph.\n\nSecond paragraph.',
            document_type: 'plaintext',
            status: 'published',
          },
        ],
        categories: [],
        tags: [],
      },
    },
    themePackage,
    writer,
    options: { generateSpecialFiles: false, injectHtmx: false },
  });

  const files = writer.getFiles();
  const postHtml = getFileContent(files, 'posts/markdown-post/index.html');
  const pageHtml = getFileContent(files, 'plaintext-page/index.html');

  assert.match(postHtml, /Admin\|https:\/\/media\.example\.com\/avatars\/admin\.webp\|/);
  assert.match(postHtml, /<h1 id="markdown-heading">/);
  assert.match(postHtml, /<p>Paragraph text\.<\/p>/);
  assert.match(pageHtml, /<p>First paragraph\.<\/p>/);
  assert.match(pageHtml, /<p>Second paragraph\.<\/p>/);
});
