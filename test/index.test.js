import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelectedRoutes, buildSite, buildSiteFromThemeDir, FilesystemWriter, MemoryWriter } from '../src/index.js';

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
  const templateNames = ['layout', 'index', 'archive', 'category', 'tag', 'post', 'page'];
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
  return xml
    .replace(
      /(<loc>https:\/\/example\.com\/<\/loc>\n\s*<lastmod>)[^<]+(<\/lastmod>)/,
      '$1__TODAY__$2',
    )
    .replace(
      /(<loc>https:\/\/example\.com\/about\/<\/loc>\n\s*<lastmod>)[^<]+(<\/lastmod>)/,
      '$1__TODAY__$2',
    )
    .replace(
      /(<loc>https:\/\/example\.com\/categories\/general\/<\/loc>\n\s*<lastmod>)[^<]+(<\/lastmod>)/,
      '$1__TODAY__$2',
    )
    .replace(
      /(<loc>https:\/\/example\.com\/tags\/intro\/<\/loc>\n\s*<lastmod>)[^<]+(<\/lastmod>)/,
      '$1__TODAY__$2',
    );
}

async function readGolden(relativePath) {
  return fs.readFile(path.join(goldenDir, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

test('buildSelectedRoutes renders only selected outputs with full-build parity', async () => {
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  const fullWriter = new MemoryWriter();
  await buildSite({
    previewData,
    themePackage,
    writer: fullWriter,
    options: { generateSpecialFiles: false, injectHtmx: true },
  });

  const selectedWriter = new MemoryWriter();
  const result = await buildSelectedRoutes({
    previewData,
    themePackage,
    writer: selectedWriter,
    selection: {
      posts: ['hello-zeropress'],
      indexRoutes: ['/'],
      archiveRoutes: ['/archive/'],
      categoryRoutes: ['/categories/general/'],
      tagRoutes: ['/tags/intro/'],
      includeAssets: false,
    },
    options: { generateSpecialFiles: false, injectHtmx: true },
  });

  const files = selectedWriter.getFiles();
  const selectedPaths = files.map((file) => file.path).sort();
  const expectedPaths = [
    'archive/index.html',
    'categories/general/index.html',
    'index.html',
    'posts/hello-zeropress/index.html',
    'tags/intro/index.html',
  ];

  assert.deepEqual(selectedPaths, expectedPaths);
  assert.equal(result.files.map((file) => file.path).sort().join('|'), expectedPaths.join('|'));

  for (const outputPath of expectedPaths) {
    assert.equal(
      getFileContent(files, outputPath),
      getFileContent(fullWriter.getFiles(), outputPath),
      `Partial render mismatch for ${outputPath}`,
    );
  }

  assert.equal(files.some((file) => file.path.startsWith('assets/')), false);
  assert.equal(files.some((file) => file.path === 'about/index.html'), false);
});

test('buildSite supports medium fixture with encoded slugs and paginated taxonomy routes', async () => {
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
  const encodedPostSlug = encodeURIComponent('안녕하세요-제로프레스');
  const encodedSecondPostSlug = encodeURIComponent('디자인-시스템-가이드');
  const encodedPageSlug = encodeURIComponent('회사소개');
  const encodedCategorySlug = encodeURIComponent('디자인');
  const encodedTagSlug = encodeURIComponent('한글');

  const expectedPaths = [
    `posts/${encodedPostSlug}/index.html`,
    `posts/${encodedSecondPostSlug}/index.html`,
    `${encodedPageSlug}/index.html`,
    'page/2/index.html',
    `categories/${encodedCategorySlug}/index.html`,
    `categories/${encodedCategorySlug}/page/2/index.html`,
    `tags/${encodedTagSlug}/index.html`,
    `tags/${encodedTagSlug}/page/2/index.html`,
  ];

  for (const outputPath of expectedPaths) {
    assert.equal(files.some((file) => file.path === outputPath), true, `Expected ${outputPath} to be generated`);
  }

  const postHtml = getFileContent(files, `posts/${encodedPostSlug}/index.html`);
  assert.match(postHtml, /안녕하세요 제로프레스/);
  assert.match(postHtml, new RegExp(`/categories/${escapeRegExp(encodedCategorySlug)}/`));
  assert.match(postHtml, new RegExp(`/tags/${escapeRegExp(encodedTagSlug)}/`));

  const pageHtml = getFileContent(files, `${encodedPageSlug}/index.html`);
  assert.match(pageHtml, /회사 소개/);
  assert.match(pageHtml, /ZeroPress 소개 페이지입니다/);

  const categoryPageTwoHtml = getFileContent(files, `categories/${encodedCategorySlug}/page/2/index.html`);
  assert.match(categoryPageTwoHtml, /Taxonomy Coverage Check/);

  const sitemapXml = getFileContent(files, 'sitemap.xml');
  assert.ok(sitemapXml.includes(`https://example.kr/posts/${encodedPostSlug}/`));
  assert.ok(sitemapXml.includes(`https://example.kr/${encodedPageSlug}/`));
  assert.ok(sitemapXml.includes(`https://example.kr/categories/${encodedCategorySlug}/`));
  assert.ok(sitemapXml.includes(`https://example.kr/tags/${encodedTagSlug}/`));

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  for (const outputPath of expectedPaths) {
    assert.equal(manifest.files.some((file) => file.path === outputPath), true, `Expected ${outputPath} in manifest`);
  }
});

test('buildSelectedRoutes keeps parity for medium fixture encoded routes and second-page taxonomy outputs', async () => {
  const previewData = await loadMediumPreviewData();
  const themePackage = await loadGoldenThemePackage();
  const encodedCategorySlug = encodeURIComponent('디자인');
  const encodedTagSlug = encodeURIComponent('한글');

  const fullWriter = new MemoryWriter();
  await buildSite({
    previewData,
    themePackage,
    writer: fullWriter,
    options: { generateSpecialFiles: false, injectHtmx: true },
  });

  const selectedWriter = new MemoryWriter();
  const result = await buildSelectedRoutes({
    previewData,
    themePackage,
    writer: selectedWriter,
    selection: {
      posts: ['안녕하세요-제로프레스', 'taxonomy-coverage-check'],
      indexRoutes: ['/', '/page/2/'],
      archiveRoutes: ['/archive/', '/archive/page/2/'],
      categoryRoutes: [`/categories/${encodedCategorySlug}/`, `/categories/${encodedCategorySlug}/page/2/`],
      tagRoutes: [`/tags/${encodedTagSlug}/`, `/tags/${encodedTagSlug}/page/2/`],
      includeAssets: false,
    },
    options: { generateSpecialFiles: false, injectHtmx: true },
  });

  const files = selectedWriter.getFiles();
  const expectedPaths = [
    'archive/index.html',
    'archive/page/2/index.html',
    `categories/${encodedCategorySlug}/index.html`,
    `categories/${encodedCategorySlug}/page/2/index.html`,
    'index.html',
    'page/2/index.html',
    `posts/${encodeURIComponent('안녕하세요-제로프레스')}/index.html`,
    'posts/taxonomy-coverage-check/index.html',
    `tags/${encodedTagSlug}/index.html`,
    `tags/${encodedTagSlug}/page/2/index.html`,
  ];

  assert.deepEqual(files.map((file) => file.path).sort(), expectedPaths);
  assert.equal(result.files.map((file) => file.path).sort().join('|'), expectedPaths.join('|'));

  for (const outputPath of expectedPaths) {
    assert.equal(
      getFileContent(files, outputPath),
      getFileContent(fullWriter.getFiles(), outputPath),
      `Partial render mismatch for ${outputPath}`,
    );
  }

  assert.equal(files.some((file) => file.path === 'feed.xml'), false);
  assert.equal(files.some((file) => file.path.startsWith('assets/')), false);
  assert.equal(files.some((file) => file.path === `${encodeURIComponent('회사소개')}/index.html`), false);
});
