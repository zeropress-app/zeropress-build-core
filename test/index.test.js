import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite, buildSiteFromThemeDir, FilesystemWriter, MemoryWriter } from '../src/index.js';
import { ControlFlowRenderer } from '../src/render/control-flow-renderer.js';
import { renderDocument } from '../src/render/content-renderer.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const goldenDir = path.join(__dirname, 'golden', 'default-preview');
const goldenThemeDir = path.join(fixturesDir, 'golden-theme');

async function loadDefaultPreviewData() {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, 'default-preview-data.json'), 'utf8'));
}

async function loadMediumPreviewData() {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, 'medium-preview-data.json'), 'utf8'));
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

function createAssetBuffer(source = 'body { color: red; }') {
  return Buffer.from(source, 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatExpectedIntlTimestamp(value, site) {
  if (site.date_style === 'none' && site.time_style === 'none') {
    return '';
  }

  const options = {
    timeZone: site.timezone,
  };
  if (site.date_style !== 'none') {
    options.dateStyle = site.date_style;
  }
  if (site.time_style !== 'none') {
    options.timeStyle = site.time_style;
  }

  return new Intl.DateTimeFormat(site.locale, options).format(new Date(value));
}

function createInterpolatingRenderer() {
  const resolvePath = (data, templatePath) => templatePath.split('.').reduce((current, segment) => {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    return current[segment];
  }, data);

  return new ControlFlowRenderer({
    resolvePath,
    renderText: (value, data) => String(value || '').replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*)*)\}\}/g, (_, templatePath) => {
      const resolved = resolvePath(data, templatePath);
      return resolved == null ? '' : String(resolved);
    }),
  });
}

test('ControlFlowRenderer renders nested if/if_eq/for blocks and strips comments', () => {
  const renderer = new ControlFlowRenderer();
  const output = renderer.render(`
{{! inline note }}
{{#if widget.title}}
<section>
  {{#if_eq widget.type "profile"}}
    <h2>{{widget.title}}</h2>
    <ul>
      {{#for item in widget.items}}<li>{{item.label}}</li>{{/for}}
    </ul>
  {{#else}}
    <p>fallback</p>
  {{/if_eq}}
</section>
{{/if}}
{{!-- block note --}}
`, {
    widget: {
      title: 'About',
      type: 'profile',
      items: [{ label: 'One' }, { label: 'Two' }],
    },
  });

  assert.match(output, /<h2>\{\{widget\.title\}\}<\/h2>/);
  assert.match(output, /<li>\{\{item\.label\}\}<\/li><li>\{\{item\.label\}\}<\/li>/);
  assert.doesNotMatch(output, /inline note|block note|fallback/);
});

test('ControlFlowRenderer rejects duplicate else blocks', () => {
  const renderer = new ControlFlowRenderer();
  assert.throws(
    () => renderer.render('{{#if widget.title}}A{{#else}}B{{#else}}C{{/if}}', { widget: { title: 'x' } }),
    /Unexpected else tag/,
  );
});

test('ControlFlowRenderer exposes loop metadata and else_if branches', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render(
    '{{#for item in items}}{{#if loop.first}}first{{#else_if loop.last}}last{{#else}}middle{{/if}}:{{loop.index}}:{{item.label}};{{/for}}',
    {
      items: [
        { label: 'One' },
        { label: 'Two' },
        { label: 'Three' },
      ],
    },
  );

  assert.equal(output, 'first:0:One;middle:1:Two;last:2:Three;');
});

test('ControlFlowRenderer renders internal hyphens in data path segments', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render(
    '{{#if menus.docs-sidebar.items}}{{#for section in menus.docs-sidebar.items}}{{#if section.custom-title}}{{section.custom-title}}{{#else_if section.fallback-title}}{{section.fallback-title}}{{/if}}{{#if_eq section.custom-kind "guide"}}:{{section.custom-kind}}{{/if_eq}};{{/for}}{{/if}}',
    {
      menus: {
        'docs-sidebar': {
          items: [
            { 'custom-kind': 'guide', 'custom-title': 'Guides' },
            { 'custom-kind': 'reference', 'fallback-title': 'Reference' },
          ],
        },
      },
    },
  );

  assert.equal(output, 'Guides:guide;Reference;');
});

test('ControlFlowRenderer supports strict typed comparison helpers', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render([
    '{{#if_eq loop_index 4}}number{{#else}}no-number{{/if_eq}}',
    '{{#if_eq loop_index "4"}}bad-string{{#else}}strict-string{{/if_eq}}',
    '{{#if_eq site.footer.attribution true}}footer{{/if_eq}}',
    '{{#if_eq route.type 4}}bad-route-number{{#else}}route-type-strict{{/if_eq}}',
    '{{#if_eq route.url current.url}}active{{/if_eq}}',
    '{{#if_neq loop.last true}},{{/if_neq}}',
    '{{#if_in route.type "post" "page" "front_page" 4 "tag"}}in-route{{/if_in}}',
    '{{#if_in numeric_route "4"}}bad-in-string{{#else}}strict-in{{/if_in}}',
    '{{#if_starts_with route.url section.url}}prefix{{/if_starts_with}}',
    '{{#if_starts_with route.type 4}}bad-prefix{{#else}}strict-prefix{{/if_starts_with}}',
  ].join('|'), {
    loop_index: 4,
    loop: { last: false },
    site: { footer: { attribution: true } },
    route: { type: 'post', url: '/docs/install/' },
    current: { url: '/docs/install/' },
    section: { url: '/docs/' },
    numeric_route: 4,
  });

  assert.equal(output, 'number|strict-string|footer|route-type-strict|active|,|in-route|strict-in|prefix|strict-prefix');
});

test('ControlFlowRenderer supports comparison else-if branches', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render([
    '{{#if_neq route.type "post"}}not-post{{#else_if_neq route.type "page"}}not-page{{#else}}fallback{{/if_neq}}',
    '{{#if_in route.type "tag"}}tag{{#else_if_in route.type "post" "page"}}content{{/if}}',
    '{{#if_starts_with route.url "/blog/"}}blog{{#else_if_starts_with route.url "/docs/"}}docs{{/if}}',
    '{{#if_eq route.url current.url}}exact{{#else_if_starts_with route.url "/docs/"}}parent{{#else}}none{{/if}}',
    '{{#if_in route.type "page"}}page{{#else_if_eq route.type "post"}}post{{/if}}',
    '{{#if_starts_with route.url "/none/"}}none{{#else_if_neq route.type "page"}}not-page{{/if}}',
  ].join('|'), {
    route: { type: 'post', url: '/docs/install/' },
    current: { url: '/elsewhere/' },
  });

  assert.equal(output, 'not-page|content|docs|parent|post|not-page');
});

test('ControlFlowRenderer rejects malformed comparison helpers', () => {
  const renderer = createInterpolatingRenderer();

  assert.throws(
    () => renderer.render('{{#if_eq site.footer.attribution}}bad{{/if_eq}}', {}),
    /Invalid if_eq expression/,
  );
  assert.throws(
    () => renderer.render('{{#if_in route.type}}bad{{/if_in}}', {}),
    /Invalid if_in expression/,
  );
  assert.throws(
    () => renderer.render('{{#if_eq route.type post page}}bad{{/if_eq}}', {}),
    /Invalid if_eq expression/,
  );
  assert.throws(
    () => renderer.render('{{#if_eq route.type "post"}}bad{{/if_starts_with}}', {}),
    /Unexpected closing tag/,
  );
  assert.throws(
    () => renderer.render('{{#if_eq route.type "post"}}ok{{#else}}fallback{{#else_if_eq route.type "page"}}bad{{/if}}', {}),
    /Unexpected else_if_eq tag/,
  );
  assert.throws(
    () => renderer.render('{{#if route.type}}ok{{#else_if_eq route.type "post"}}bad{{/if}}', { route: { type: 'post' } }),
    /Unexpected else_if_eq tag/,
  );
});

test('ControlFlowRenderer renders partial arguments and nested partial shadowing', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render(
    '{{#for item in collections.work.items}}{{partial:card project=item variant="compact" show_excerpt=true limit=3 fallback=null missing=does.not.exist}}{{/for}}',
    {
      collections: {
        work: {
          items: [
            {
              title: 'Partial aliases',
              excerpt: 'Structured partial args',
              tags: ['templates'],
            },
          ],
        },
      },
    },
    {
      partials: new Map([
        ['card', '<article data-variant="{{partial.variant}}" data-limit="{{partial.limit}}">{{partial.project.title}}{{#if partial.show_excerpt}}<p>{{partial.project.excerpt}}</p>{{/if}}{{#if partial.project.tags}}<b>tags</b>{{/if}}{{#if partial.fallback}}bad-null{{/if}}{{#if partial.missing}}bad-missing{{#else}}missing{{/if}}{{partial:badge variant="nested"}}<span class="after">{{partial.variant}}</span></article>'],
        ['badge', '<em>{{partial.project.title}}/{{partial.variant}}</em>'],
      ]),
    },
  );

  assert.equal(output, '<article data-variant="compact" data-limit="3">Partial aliases<p>Structured partial args</p><b>tags</b>missing<em>Partial aliases/nested</em><span class="after">compact</span></article>');
});

test('ControlFlowRenderer rejects malformed partial argument values', () => {
  const renderer = createInterpolatingRenderer();
  const renderOptions = { partials: new Map([['card', '<p>Card</p>']]) };

  assert.throws(
    () => renderer.render('{{partial:card item=posts.items[0]}}', {}, renderOptions),
    /Unsupported partial argument value/,
  );
  assert.throws(
    () => renderer.render('{{partial:card visible=post&&page}}', {}, renderOptions),
    /Unsupported partial argument value/,
  );
  assert.throws(
    () => renderer.render('{{partial:card variant=compact}}', {}, renderOptions),
    /Unsupported partial argument value/,
  );
  assert.throws(
    () => renderer.render('{{partial:card count=1 count=2}}', {}, renderOptions),
    /Duplicate partial argument/,
  );
});

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
    ['build-manifest.summary.json', normalizeManifestSummary(getFileContent(files, 'build-manifest.json'))],
  ];

  for (const [relativePath, actual] of comparisons) {
    const expected = await readGolden(relativePath);
    assert.equal(actual.trim(), expected.trim(), `Golden fixture mismatch for ${relativePath}`);
  }
});

test('buildSite preserves JavaScript string literal whitespace in theme assets', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  themePackage.assets.set(
    'theme.js',
    Buffer.from('const observerOptions = { rootMargin: "-40% 0px -55% 0px" };\nconst label = "a + b";\n'),
  );

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { assetHashing: false, generateSpecialFiles: false },
  });

  const script = getFileContent(writer.getFiles(), 'assets/theme.js');
  assert.match(script, /rootMargin: "-40% 0px -55% 0px"/);
  assert.match(script, /"a \+ b"/);
});

test('buildSite exposes optional site.footer fields to themes', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  previewData.site.footer = {
    copyright_text: 'Copyright 2026 Example Corp.',
    attribution: false,
  };
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('layout', [
    '<main>{{slot:content}}</main>',
    '<footer>',
    '{{#if site.footer.copyright_text}}<p>{{site.footer.copyright_text}}</p>{{#else_if site.title}}<p>{{site.title}}</p>{{/if}}',
    '{{#if site.footer.attribution}}<p>Published with ZeroPress.</p>{{/if}}',
    '</footer>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /Copyright 2026 Example Corp\./);
  assert.doesNotMatch(indexHtml, /Published with ZeroPress/);
});

test('buildSite exposes optional site.logo fields to themes with media normalization', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  previewData.site.media_base_url = 'https://media.example.com';
  previewData.site.logo = {
    src: '/logo.svg',
    alt: 'Example logo',
  };
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('index', [
    '{{#if site.logo.src}}',
    '<img class="brand-logo" src="{{site.logo.src}}" alt="{{site.logo.alt}}">',
    '{{/if}}',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /<img class="brand-logo" src="https:\/\/media\.example\.com\/logo\.svg" alt="Example logo">/);
  assert.doesNotMatch(indexHtml, /src="\/logo\.svg"/);
});

test('buildSite reports invalid preview data at the core API boundary', async () => {
  const writer = new MemoryWriter();
  const themePackage = await loadGoldenThemePackage();

  await assert.rejects(
    () => buildSite({
      previewData: { version: '0.3' },
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /Invalid preview-data:/,
  );
});

test('buildSite renders menu helpers from preview-data menus', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.partials.set('header', '<header>{{menu:primary}}</header>');
  themePackage.partials.set('footer', '<footer>{{menu:footer}}</footer>');

  previewData.menus.footer = {
    name: 'Footer Menu',
    items: [
      {
        title: 'Docs',
        url: '/docs/',
        type: 'custom',
        target: '_blank',
        children: [],
      },
    ],
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');

  assert.match(indexHtml, /<header><ul><li><a href="\/" target="_self">Home<\/a><\/li><li><a href="\/archive\/" target="_self">Archive<\/a><\/li><\/ul><\/header>/);
  assert.match(indexHtml, /<footer><ul><li><a href="\/docs\/" target="_blank" rel="noreferrer noopener">Docs<\/a><\/li><\/ul><\/footer>/);
});

test('buildSite renders custom menu loops with hyphenated slot ids', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.templates.set('index', `
<main class="docs-home">
  {{#for section in menus.docs-sidebar.items}}
    <section class="docs-sidebar__section">
      <h2>{{section.title}}</h2>
      {{#for item in section.children}}<a class="icon-{{item.meta.icon}}" data-badge="{{item.meta.badge}}" href="{{item.url}}">{{item.title}}</a>{{/for}}
    </section>
  {{/for}}
</main>
`);
  previewData.menus['docs-sidebar'] = {
    name: 'Docs Sidebar',
    items: [
      {
        title: 'Getting Started',
        url: '/docs/',
        type: 'custom',
        target: '_self',
        children: [
          {
            title: 'Introduction',
            url: '/docs/introduction/',
            type: 'custom',
            target: '_self',
            meta: {
              icon: 'book',
              badge: 'Start <here>',
            },
            children: [],
          },
        ],
      },
    ],
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');

  assert.match(indexHtml, /<section class="docs-sidebar__section">/);
  assert.match(indexHtml, /<h2>Getting Started<\/h2>/);
  assert.match(indexHtml, /<a class="icon-book" data-badge="Start &lt;here&gt;" href="\/docs\/introduction\/">Introduction<\/a>/);
});

test('buildSite renders widget areas and injects preview-data custom CSS assets', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.templates.set('index', `
<section class="index-page">
  <aside class="sidebar-stack">
    {{#for widget in widgets.sidebar.items}}
      {{#if_eq widget.type "profile"}}
        <section class="widget-card widget-card--profile">
          {{#if widget.avatar_url}}<img class="widget-profile__avatar" src="{{widget.avatar_url}}" alt="{{widget.display_name}}">{{/if}}
          <div class="widget-profile__body">
            <p class="widget-profile__name">{{widget.display_name}}</p>
            {{#if widget.bio_text}}<p class="sidebar-copy">{{widget.bio_text}}</p>{{/if}}
          </div>
        </section>
      {{/if_eq}}
      {{#if_eq widget.type "recent-posts"}}
        <ul class="widget-list">
          {{#for item in widget.items}}<li><a href="{{item.url}}">{{item.title}}</a></li>{{/for}}
        </ul>
      {{/if_eq}}
      {{#if_eq widget.type "search"}}
        <form class="widget-search"><input class="search-input" type="search" placeholder="{{widget.placeholder}}"><button class="widget-search-button" type="submit">{{widget.button_label}}</button></form>
      {{/if_eq}}
      {{#if_eq widget.type "text"}}
        <div class="widget-copy">{{widget.html}}</div>
      {{/if_eq}}
    {{/for}}
  </aside>
</section>`);
  previewData.site.media_base_url = 'https://media.example.com';

  previewData.widgets = {
    sidebar: {
      name: 'Sidebar Widgets',
      items: [
        {
          type: 'profile',
          title: 'About',
          settings: {
            display_name: 'Admin',
            affiliation: 'ZeroPress Dev Team',
            bio_short: 'Preview profile',
            avatar: '/avatars/admin.webp',
          },
        },
        {
          type: 'recent-posts',
          title: 'Recent Posts',
          settings: {
            limit: 2,
            show_date: true,
          },
        },
        {
          type: 'search',
          title: 'Search',
          settings: {
            placeholder: 'Search articles',
            button_label: 'Go',
          },
        },
        {
          type: 'text',
          title: 'Note',
          settings: {
            document_type: 'markdown',
            content: 'Sidebar **markdown**',
          },
        },
      ],
    },
  };
  previewData.custom_css = {
    content: 'body { color: rgb(10, 20, 30); }',
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');
  const customCssAsset = files.find((file) => /^assets\/zeropress-custom\.[a-f0-9]{8}\.css$/.test(file.path));

  assert.ok(customCssAsset, 'Expected a hashed custom CSS asset to be emitted');
  assert.match(indexHtml, /<link rel="stylesheet" href="\/assets\/zeropress-custom\.[a-f0-9]{8}\.css">/);
  assert.match(indexHtml, /widget-card--profile/);
  assert.match(indexHtml, /src="https:\/\/media\.example\.com\/avatars\/admin\.webp"/);
  assert.match(indexHtml, /Preview profile/);
  assert.match(indexHtml, /Hello ZeroPress/);
  assert.match(indexHtml, /placeholder="Search articles"/);
  assert.match(indexHtml, /<button class="widget-search-button" type="submit">Go<\/button>/);
  assert.match(indexHtml, /Sidebar <strong>markdown<\/strong>/);
});

test('buildSite injects trusted custom HTML into rendered HTML routes', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.custom_css = {
    content: 'body { color: rgb(10, 20, 30); }',
  };
  previewData.custom_html = {
    head_end: {
      content: '<meta name="zp-custom-head" content="ok">\n<script>window.__zp_head = true;</script>',
    },
    body_end: {
      content: '<script defer src="/vendor/app.js"></script>',
    },
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');
  const postHtml = getFileContent(files, 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(files, 'about/index.html');
  const notFoundHtml = getFileContent(files, '404.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');

  for (const html of [indexHtml, postHtml, pageHtml, notFoundHtml]) {
    assert.match(html, /<meta name="zp-custom-head" content="ok">/);
    assert.match(html, /<script>window\.__zp_head = true;<\/script>/);
    assert.match(html, /<script defer src="\/vendor\/app\.js"><\/script>\n<\/body>/);
    assert.doesNotMatch(html, /&lt;meta name="zp-custom-head"/);
  }

  const customCssLinkIndex = indexHtml.indexOf('<link rel="stylesheet" href="/assets/zeropress-custom');
  const customHeadIndex = indexHtml.indexOf('<meta name="zp-custom-head" content="ok">');
  const headCloseIndex = indexHtml.indexOf('</head>');
  assert.ok(customCssLinkIndex > -1, 'Expected custom CSS link to be injected');
  assert.ok(customHeadIndex > customCssLinkIndex, 'Expected custom HTML head_end after custom CSS link');
  assert.ok(headCloseIndex > customHeadIndex, 'Expected custom HTML head_end before </head>');
  assert.doesNotMatch(sitemapXml, /zp-custom-head|vendor\/app\.js/);
});

test('buildSite injects favicon links before custom CSS and custom HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.favicon = {
    icon: '/explicit.ico',
  };
  previewData.custom_css = {
    content: 'body { color: rgb(10, 20, 30); }',
  };
  previewData.custom_html = {
    head_end: {
      content: '<meta name="zp-custom-head" content="ok">',
    },
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: {
      favicon: {
        icon: '/favicon.ico',
        svg: '/favicon.svg',
        png: '/favicon.png',
        apple_touch_icon: '/apple-touch-icon.png',
      },
    },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /<link rel="icon" href="\/explicit\.ico" sizes="any">/);
  assert.match(indexHtml, /<meta name="generator" content="ZeroPress">/);
  assert.doesNotMatch(indexHtml, /href="\/favicon\.ico"/);
  assert.doesNotMatch(indexHtml, /href="\/favicon\.svg"/);

  const iconIndex = indexHtml.indexOf('<link rel="icon" href="/explicit.ico" sizes="any">');
  const generatorIndex = indexHtml.indexOf('<meta name="generator" content="ZeroPress">');
  const customCssLinkIndex = indexHtml.indexOf('<link rel="stylesheet" href="/assets/zeropress-custom');
  const customHeadIndex = indexHtml.indexOf('<meta name="zp-custom-head" content="ok">');
  const headCloseIndex = indexHtml.indexOf('</head>');
  assert.ok(iconIndex > -1, 'Expected favicon link to be injected');
  assert.ok(generatorIndex > iconIndex, 'Expected generator meta after favicon links');
  assert.ok(customCssLinkIndex > generatorIndex, 'Expected custom CSS after generator meta');
  assert.ok(customHeadIndex > customCssLinkIndex, 'Expected custom HTML after custom CSS');
  assert.ok(headCloseIndex > customHeadIndex, 'Expected custom HTML before </head>');
});

test('buildSite can omit generator meta while preserving custom head HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.expose_generator = false;
  previewData.custom_html = {
    head_end: {
      content: '<meta name="generator" content="Custom Generator">',
    },
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.doesNotMatch(indexHtml, /content="ZeroPress"/);
  assert.match(indexHtml, /<meta name="generator" content="Custom Generator">/);
});

test('buildSite does not deduplicate custom generator meta', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.custom_html = {
    head_end: {
      content: '<meta name="generator" content="Custom Generator">',
    },
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.equal([...indexHtml.matchAll(/<meta name="generator"/g)].length, 2);
  assert.match(indexHtml, /<meta name="generator" content="ZeroPress">/);
  assert.match(indexHtml, /<meta name="generator" content="Custom Generator">/);
});

test('buildSite normalizes explicit preview-data favicon links against media_base_url', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.media_base_url = 'https://media.example.com';
  previewData.site.favicon = {
    icon: '/favicon.ico',
    svg: '/favicon.svg',
    png: '/favicon.png',
    apple_touch_icon: '/apple-touch-icon.png',
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /<link rel="icon" href="https:\/\/media\.example\.com\/favicon\.ico" sizes="any">/);
  assert.match(indexHtml, /<link rel="icon" href="https:\/\/media\.example\.com\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(indexHtml, /<link rel="icon" href="https:\/\/media\.example\.com\/favicon\.png" type="image\/png">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="https:\/\/media\.example\.com\/apple-touch-icon\.png">/);
});

test('buildSite injects discovered favicon option when preview-data has no explicit favicon', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.media_base_url = 'https://media.example.com';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: {
      generateSpecialFiles: false,
      favicon: {
        icon: '/favicon.ico',
        svg: '/favicon.svg',
        png: '/favicon.png',
        apple_touch_icon: '/apple-touch-icon.png',
      },
    },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.png" type="image\/png">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.doesNotMatch(indexHtml, /media\.example\.com\/favicon/);
});

test('buildSite runtime 0.6 renders resolved widgets with escaping and safe URL filtering', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.6';
  themePackage.templates.set('index', `
<section class="index-page">
  <aside class="sidebar-stack">
    {{#for widget in widgets.sidebar.items}}
      {{#if_eq widget.type "link-list"}}
        {{#if widget.title}}
          <a class="widget-title-link" href="https://demo.zeropress.app" title="{{widget.title}}" target="_blank">{{widget.title}}</a>
        {{/if}}
        <div class="taxonomy-list taxonomy-list--stack widget-link-list">
          {{#for item in widget.items}}
            <a href="{{item.url}}" target="{{item.target}}">{{item.label}}</a>
          {{/for}}
        </div>
      {{/if_eq}}
      {{#if_eq widget.type "text"}}
        <div class="widget-copy">{{widget.html}}</div>
      {{/if_eq}}
      {{#if_eq widget.type "profile"}}
        <section class="widget-card widget-card--profile">
          {{#if widget.avatar_url}}<img class="widget-profile__avatar" src="{{widget.avatar_url}}" alt="{{widget.display_name}}">{{/if}}
          {{#if widget.bio_text}}<p class="sidebar-copy">{{widget.bio_text}}</p>{{/if}}
        </section>
      {{/if_eq}}
    {{/for}}
  </aside>
</section>`);

  previewData.site.media_base_url = 'https://media.example.com';
  previewData.widgets = {
    sidebar: {
      name: 'Sidebar Widgets',
      items: [
        {
          type: 'link-list',
          title: 'Lael\'s Zeropress "DEMO"site.<p>',
          settings: {
            links: [
              { label: 'Home', url: '/', target: '_self' },
              { label: 'Blocked', url: 'javascript:alert(1)', target: '_self' },
            ],
          },
        },
        {
          type: 'text',
          title: 'Note',
          settings: {
            document_type: 'markdown',
            content: 'Sidebar **markdown**',
          },
        },
        {
          type: 'profile',
          title: 'About',
          settings: {
            display_name: 'Admin',
            affiliation: 'ZeroPress Dev Team',
            bio_short: 'Preview profile',
            avatar: '/avatars/admin.webp',
          },
        },
      ],
    },
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /title="Lael&#39;s Zeropress &quot;DEMO&quot;site\.&lt;p&gt;"/);
  assert.match(indexHtml, />Lael&#39;s Zeropress &quot;DEMO&quot;site\.&lt;p&gt;<\/a>/);
  assert.match(indexHtml, /Sidebar <strong>markdown<\/strong>/);
  assert.match(indexHtml, /src="https:\/\/media\.example\.com\/avatars\/admin\.webp"/);
  assert.match(indexHtml, /Preview profile/);
  assert.match(indexHtml, /<a href="\/" target="_self">Home<\/a>/);
  assert.doesNotMatch(indexHtml, /javascript:alert/);
  assert.doesNotMatch(indexHtml, />Blocked<\/a>/);
});

test('loadThemePackageFromDir uses normalized validator manifest metadata', async () => {
  const themeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dir-'));

  try {
    await fs.writeFile(path.join(themeDir, 'theme.json'), JSON.stringify({
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.6',
      author: '  ZeroPress  ',
      description: '  Theme fixture  ',
      features: {
        comments: true,
        newsletter: false,
      },
      links: {
        homepage: '  https://example.com/theme  ',
        support: '  mailto:support@example.com  ',
        license: '  https://example.com/theme/license  ',
      },
      menu_slots: {
        primary: {
          title: '  Primary Menu  ',
          description: '  Main header navigation  ',
        },
      },
      widget_areas: {
        sidebar: {
          title: '  Sidebar Widgets  ',
          description: '  Right rail widgets  ',
        },
      },
      thumbnail: '/preview.png',
    }, null, 2));
    await fs.writeFile(path.join(themeDir, 'layout.html'), '<main>{{slot:content}}</main>');
    await fs.writeFile(path.join(themeDir, 'index.html'), '<h1>{{site.title}}</h1>');
    await fs.writeFile(path.join(themeDir, 'post.html'), '<article>{{post.title}}</article>');
    await fs.writeFile(path.join(themeDir, 'page.html'), '<section>{{page.title}}</section>');
    await fs.mkdir(path.join(themeDir, 'assets'));
    await fs.writeFile(path.join(themeDir, 'assets', 'style.css'), 'body { color: black; }');

    const themePackage = await loadThemePackageFromDir(themeDir);

    assert.deepEqual(themePackage.metadata, {
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.6',
      author: 'ZeroPress',
      description: 'Theme fixture',
      features: {
        comments: true,
        newsletter: false,
      },
      links: {
        homepage: 'https://example.com/theme',
        support: 'mailto:support@example.com',
        license: 'https://example.com/theme/license',
      },
      menu_slots: {
        primary: {
          title: 'Primary Menu',
          description: 'Main header navigation',
        },
      },
      widget_areas: {
        sidebar: {
          title: 'Sidebar Widgets',
          description: 'Right rail widgets',
        },
      },
      thumbnail: '/preview.png',
    });
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('loadThemePackageFromDir preserves theme capability metadata for internal fixtures', async () => {
  const themePackage = await loadThemePackageFromDir(goldenThemeDir);

  assert.deepEqual(themePackage.metadata.features, {
    comments: true,
    newsletter: false,
    search: true,
  });
});

test('buildSite rejects theme packages that do not target runtime 0.6', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.3';

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /Theme validation failed[\s\S]*ERROR INVALID_RUNTIME_VERSION[\s\S]*Reason: theme\.json field 'runtime' must be one of: 0\.6/,
  );
});

test('buildSiteFromThemeDir loads the golden fixture theme directory and FilesystemWriter writes files to disk', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-core-out-'));

  try {
    const writer = new FilesystemWriter({ outDir });
    await buildSiteFromThemeDir({
      previewData: await loadDefaultPreviewData(),
      themeDir: goldenThemeDir,
      writer,
      options: { generateSpecialFiles: false },
    });

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const postHtml = await fs.readFile(path.join(outDir, 'posts', 'hello-zeropress', 'index.html'), 'utf8');
    assert.match(indexHtml, /Hello ZeroPress/);
    assert.match(postHtml, /Preview post content/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('buildSiteFromThemeDir rejects themes that do not target runtime 0.6', async () => {
  const themeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-core-theme-'));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-core-out-'));

  try {
    await fs.writeFile(path.join(themeDir, 'theme.json'), JSON.stringify({
      name: 'Legacy Theme',
      namespace: 'test-studio',
      slug: 'legacy-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.3',
    }, null, 2));
    await fs.writeFile(path.join(themeDir, 'layout.html'), '<main>{{slot:content}}</main>');
    await fs.writeFile(path.join(themeDir, 'index.html'), '<h1>{{site.title}}</h1>');
    await fs.writeFile(path.join(themeDir, 'post.html'), '<article>{{post.title}}</article>');
    await fs.writeFile(path.join(themeDir, 'page.html'), '<section>{{page.title}}</section>');
    await fs.mkdir(path.join(themeDir, 'assets'));
    await fs.writeFile(path.join(themeDir, 'assets', 'style.css'), 'body { color: black; }');

    const writer = new FilesystemWriter({ outDir });
    await assert.rejects(
      buildSiteFromThemeDir({
        previewData: await loadDefaultPreviewData(),
        themeDir,
        writer,
        options: { generateSpecialFiles: false },
      }),
      /Theme validation failed[\s\S]*ERROR INVALID_RUNTIME_VERSION[\s\S]*Reason: theme\.json field 'runtime' must be one of: 0\.6/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('buildSite renders nested partials in templates and layout slot partials', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.widgets = {
    sidebar: {
      name: 'Sidebar Widgets',
      items: [
        {
          type: 'text',
          title: 'Note',
          settings: {
            document_type: 'markdown',
            content: 'Sidebar **markdown**',
          },
        },
      ],
    },
  };

  themePackage.templates.set('index', '<main class="index-shell">{{partial:sidebar/widgets}}</main>');
  themePackage.partials.set('header', '<header class="site-header">{{partial:shared/banner}}</header>');
  themePackage.partials.set('shared/banner', '<div class="banner">{{site.title}}</div>');
  themePackage.partials.set('sidebar/widgets', [
    '{{#if widgets.sidebar.items}}',
    '<aside class="sidebar-stack">',
    '{{#for widget in widgets.sidebar.items}}',
    '{{partial:sidebar/widget-card}}',
    '{{/for}}',
    '</aside>',
    '{{/if}}',
  ].join(''));
  themePackage.partials.set('sidebar/widget-card', [
    '{{#if_eq widget.type "text"}}',
    '<section class="widget-card">{{#if widget.title}}<h2>{{widget.title}}</h2>{{/if}}<div class="widget-copy">{{widget.html}}</div></section>',
    '{{/if_eq}}',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /<header class="site-header"><div class="banner">ZeroPress Preview<\/div><\/header>/);
  assert.match(indexHtml, /<main><main class="index-shell"><aside class="sidebar-stack"><section class="widget-card"><h2>Note<\/h2><div class="widget-copy"><p>Sidebar <strong>markdown<\/strong><\/p>\s*<\/div><\/section><\/aside><\/main><\/main>/);
});

test('buildSite runtime 0.6 exposes structured posts, archive groups, and pagination without legacy helpers', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.6';
  themePackage.templates.set('index', [
    '<section>',
    '  <div class="structured-posts">',
    '    {{#for post in posts.items}}',
    '      <article class="structured-post" data-slug="{{post.slug}}">',
    '        <a class="structured-link" href="{{post.url}}">{{post.title}}</a>',
    '        <span class="structured-author">{{post.author.display_name}}</span>',
    '        {{#for category in post.categories}}<span class="structured-category">{{category.name}}</span>{{/for}}',
    '        {{#for tag in post.tags}}<span class="structured-tag">{{tag.name}}</span>{{/for}}',
    '      </article>',
    '    {{/for}}',
    '  </div>',
    '  {{#if pagination.has_multiple_pages}}',
    '    <nav class="structured-pagination">',
    '      {{#if pagination.has_prev}}<a class="prev" href="{{pagination.prev_url}}">Previous</a>{{/if}}',
    '      {{#for page in pagination.window}}{{#if_eq page.kind "page"}}<a class="page {{#if page.current}}current{{/if}}" href="{{page.url}}">{{page.number}}</a>{{#else_if_eq page.kind "gap"}}<span class="page-gap">…</span>{{/if_eq}}{{/for}}',
    '      {{#if pagination.has_next}}<a class="next" href="{{pagination.next_url}}">Next</a>{{/if}}',
    '    </nav>',
    '  {{/if}}',
    '</section>',
  ].join('\n'));
  themePackage.templates.set('category', [
    '<section class="category-route">',
    '  <h1>{{taxonomy.name}}</h1>',
    '  <p>{{taxonomy.count}}</p>',
    '  {{#for post in posts.items}}<a class="category-link-item" href="{{post.url}}">{{post.title}}</a>{{/for}}',
    '</section>',
  ].join('\n'));
  themePackage.templates.set('tag', [
    '<section class="tag-route">',
    '  <h1>{{taxonomy.name}}</h1>',
    '  <p>{{taxonomy.count}}</p>',
    '  {{#for post in posts.items}}<a class="tag-link-item" href="{{post.url}}">{{post.title}}</a>{{/for}}',
    '</section>',
  ].join('\n'));
  themePackage.templates.set('archive', [
    '<section class="archive-route">',
    '  {{#for group in archive.groups}}',
    '    <section class="archive-group">',
    '      <h2>{{group.label}}</h2>',
    '      {{#for post in group.items}}<a class="archive-post" href="{{post.url}}">{{post.title}}</a><time datetime="{{post.published_at_iso}}">{{post.published_at}}</time>{{/for}}',
    '    </section>',
    '  {{/for}}',
    '</section>',
  ].join('\n'));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');
  const categoryHtml = getFileContent(files, 'categories/general/index.html');
  const tagHtml = getFileContent(files, 'tags/intro/index.html');
  const archiveHtml = getFileContent(files, 'archive/index.html');

  assert.match(indexHtml, /<article class="structured-post" data-slug="hello-zeropress">/);
  assert.match(indexHtml, /<a class="structured-link" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a>/);
  assert.match(indexHtml, /<span class="structured-author">Admin<\/span>/);
  assert.match(indexHtml, /<span class="structured-category">General<\/span>/);
  assert.match(indexHtml, /<span class="structured-tag">Intro<\/span>/);
  assert.match(indexHtml, /<nav class="structured-pagination">/);
  assert.match(indexHtml, /<a class="page current" href="\/">1<\/a>/);
  assert.match(indexHtml, /<a class="page " href="\/page\/2\/">2<\/a>/);

  assert.match(categoryHtml, /<h1>General<\/h1>/);
  assert.match(categoryHtml, /<p>3<\/p>/);
  assert.match(categoryHtml, /<a class="category-link-item" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a>/);

  assert.match(tagHtml, /<h1>Intro<\/h1>/);
  assert.match(tagHtml, /<p>3<\/p>/);
  assert.match(tagHtml, /<a class="tag-link-item" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a>/);

  assert.match(archiveHtml, /<section class="archive-group">\s*<h2>2026-02<\/h2>/);
  assert.match(archiveHtml, /<a class="archive-post" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a><time datetime="2026-02-14T09:00:00Z">Feb 14, 2026<\/time>/);
});

test('buildSite applies html-extension permalinks and page path overrides', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.posts_per_page = 1;
  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:public_id',
    pages: '/:slug/',
    categories: '/topics/:slug/',
    tags: '/labels/:slug/',
  };
  previewData.content.pages[0].path = 'spec/preview-data-v0.6';
  previewData.content.pages.push({
    ...previewData.content.pages[0],
    title: 'CLI Tools',
    slug: 'cli',
    path: 'cli/index',
    content: '<p>CLI page</p>',
  });

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: true },
  });

  const files = writer.getFiles();
  const paths = new Set(files.map((file) => file.path));
  assert.equal(paths.has('posts/101.html'), true);
  assert.equal(paths.has('posts/101/index.html'), false);
  assert.equal(paths.has('spec/preview-data-v0.6.html'), true);
  assert.equal(paths.has('cli/index.html'), true);
  assert.equal(paths.has('cli.html'), false);
  assert.equal(paths.has('topics/general.html'), true);
  assert.equal(paths.has('topics/general/page/2.html'), true);
  assert.equal(paths.has('labels/intro.html'), true);
  assert.equal(paths.has('archive.html'), true);
  assert.equal(paths.has('archive/page/2.html'), true);
  assert.equal(paths.has('page/2.html'), true);

  const indexHtml = getFileContent(files, 'index.html');
  const postHtml = getFileContent(files, 'posts/101.html');
  const pageHtml = getFileContent(files, 'spec/preview-data-v0.6.html');
  const indexPageHtml = getFileContent(files, 'cli/index.html');
  const categoryHtml = getFileContent(files, 'topics/general.html');
  const tagHtml = getFileContent(files, 'labels/intro.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');
  const feedXml = getFileContent(files, 'feed.xml');

  assert.match(indexHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(indexHtml, /<a href="\/page\/2" class="page-link ">2<\/a>/);
  assert.match(postHtml, /<link rel="canonical" href="https:\/\/example\.com\/posts\/101">/);
  assert.match(postHtml, /<a href="\/topics\/general" class="category-link">General<\/a>/);
  assert.match(postHtml, /<a href="\/labels\/intro" class="tag-link">Intro<\/a>/);
  assert.match(pageHtml, /<link rel="canonical" href="https:\/\/example\.com\/spec\/preview-data-v0\.6">/);
  assert.match(indexPageHtml, /<link rel="canonical" href="https:\/\/example\.com\/cli\/">/);
  assert.doesNotMatch(indexPageHtml, /https:\/\/example\.com\/cli\/index/);
  assert.match(categoryHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(tagHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/posts\/101<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/spec\/preview-data-v0\.6<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/cli\/<\/loc>/);
  assert.doesNotMatch(sitemapXml, /https:\/\/example\.com\/cli\/index/);
  assert.match(feedXml, /<link>https:\/\/example\.com\/posts\/101<\/link>/);
});

test('buildSite treats theme post_index=false as effective post index disabled', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.metadata.features = {
    ...(themePackage.metadata.features || {}),
    post_index: false,
  };
  themePackage.templates.set('index', [
    '<section data-route="{{route.type}}" data-front="{{route.is_front_page}}" data-post-index="{{route.is_post_index}}" data-pagination="{{pagination.enabled}}">',
    '{{#for post in posts.items}}<a href="{{post.url}}">{{post.title}}</a>{{/for}}',
    '</section>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');

  assert.match(indexHtml, /data-route="front_page"/);
  assert.match(indexHtml, /data-front="true"/);
  assert.match(indexHtml, /data-post-index="false"/);
  assert.match(indexHtml, /data-pagination="false"/);
  assert.doesNotMatch(indexHtml, /Hello ZeroPress/);
  assert.equal(files.some((file) => file.path === 'page/2/index.html'), false);
});

test('buildSite supports a non-paginated root post index', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.posts_per_page = 1;
  previewData.site.post_index = {
    enabled: true,
    path: '/',
    paginate: false,
  };
  themePackage.templates.set('index', [
    '<section data-route="{{route.type}}" data-front="{{route.is_front_page}}" data-post-index="{{route.is_post_index}}" data-pagination="{{pagination.enabled}}">',
    '{{#for post in posts.items}}<a href="{{post.url}}">{{post.title}}</a>{{/for}}',
    '</section>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');

  assert.match(indexHtml, /data-route="post_index"/);
  assert.match(indexHtml, /data-front="true"/);
  assert.match(indexHtml, /data-post-index="true"/);
  assert.match(indexHtml, /data-pagination="false"/);
  assert.match(indexHtml, /Hello ZeroPress/);
  assert.doesNotMatch(indexHtml, /Theme Blocks Deep Dive/);
  assert.equal(files.some((file) => file.path === 'page/2/index.html'), false);
});

test('buildSite supports front page page content with a separate post index', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.posts_per_page = 1;
  previewData.site.front_page = {
    type: 'page',
    page_slug: 'about',
  };
  previewData.site.post_index = {
    enabled: true,
    path: '/blog/',
    paginate: true,
  };
  themePackage.templates.set('index', [
    '<section data-route="{{route.type}}" data-front="{{route.is_front_page}}" data-post-index="{{route.is_post_index}}">',
    '{{#for post in posts.items}}<a href="{{post.url}}">{{post.title}}</a>{{/for}}',
    '</section>',
  ].join(''));
  themePackage.templates.set('page', '<section data-route="{{route.type}}" data-front="{{route.is_front_page}}"><h1>{{page.title}}</h1>{{page.html}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const rootHtml = getFileContent(files, 'index.html');
  const blogHtml = getFileContent(files, 'blog/index.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');

  assert.match(rootHtml, /<title>ZeroPress Preview - Default preview data<\/title>/);
  assert.match(rootHtml, /property="og:title" content="ZeroPress Preview - Default preview data"/);
  assert.match(rootHtml, /data-route="front_page"/);
  assert.match(rootHtml, /data-front="true"/);
  assert.match(rootHtml, /<h1>About<\/h1>/);
  assert.match(blogHtml, /<title>ZeroPress Preview<\/title>/);
  assert.match(blogHtml, /data-route="post_index"/);
  assert.match(blogHtml, /data-front="false"/);
  assert.match(blogHtml, /Hello ZeroPress/);
  assert.equal(files.some((file) => file.path === 'blog/page/2/index.html'), true);
  assert.equal(files.some((file) => file.path === 'about/index.html'), false);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/blog\/<\/loc>/);
  assert.doesNotMatch(sitemapXml, /<loc>https:\/\/example\.com\/about\/<\/loc>/);
});

test('buildSite uses site title only for front page meta when site description is empty', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.description = '';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const rootHtml = getFileContent(writer.getFiles(), 'index.html');

  assert.match(rootHtml, /<title>ZeroPress Preview<\/title>/);
  assert.match(rootHtml, /property="og:title" content="ZeroPress Preview"/);
});

test('buildSite supports an index slug as front page without emitting a duplicate page route', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  };
  previewData.site.front_page = {
    type: 'page',
    page_slug: 'index',
  };
  previewData.site.post_index = {
    enabled: false,
  };
  previewData.content.pages.unshift({
    title: 'Home',
    slug: 'index',
    content: '# Home\n\nWelcome home.',
    document_type: 'markdown',
    excerpt: 'Welcome home.',
    status: 'published',
  });
  themePackage.templates.set('page', '<section data-route="{{route.type}}" data-front="{{route.is_front_page}}"><h1>{{page.title}}</h1>{{page.html}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const rootHtml = getFileContent(files, 'index.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');

  assert.match(rootHtml, /data-route="front_page"/);
  assert.match(rootHtml, /data-front="true"/);
  assert.match(rootHtml, /Welcome home\./);
  assert.equal(files.filter((file) => file.path === 'index.html').length, 1);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.doesNotMatch(sitemapXml, /https:\/\/example\.com\/index/);
});

test('buildSite supports standalone front page HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.front_page = {
    type: 'standalone_html',
    html: '<!doctype html><html><head><title>Launch</title></head><body><h1>Launch</h1><script>window.launch = true;</script></body></html>',
  };
  previewData.site.favicon = {
    icon: '/favicon.ico',
  };
  previewData.custom_html = {
    head_end: {
      content: '<meta name="zp-custom-head" content="ok">',
    },
  };
  previewData.site.post_index = {
    enabled: true,
    path: '/blog/',
    paginate: false,
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const rootHtml = getFileContent(files, 'index.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');
  const feedXml = getFileContent(files, 'feed.xml');

  assert.equal(rootHtml, previewData.site.front_page.html);
  assert.doesNotMatch(rootHtml, /favicon\.ico|zp-custom-head|name="generator"/);
  assert.equal(files.some((file) => file.path === 'blog/index.html'), true);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.doesNotMatch(feedXml, /Launch/);
});

test('buildSite rejects front page root conflicts before writing files', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  previewData.site.front_page = {
    type: 'page',
    page_slug: 'about',
  };
  previewData.site.post_index = {
    enabled: true,
    path: '/',
    paginate: false,
  };

  await assert.rejects(
    () => buildSite({
      previewData,
      themePackage,
      writer,
    }),
    /site\.front_page occupies "\/"/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite exposes global taxonomies to every render context', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:public_id',
    pages: '/:slug/',
    categories: '/topics/:slug/',
    tags: '/labels/:slug/',
  };
  previewData.content.categories.push({
    name: 'Empty Category',
    slug: 'empty-category',
  });
  previewData.content.tags.push({
    name: 'Quiet Tag',
    slug: 'quiet-tag',
    description: 'Tag with no posts',
  });

  themePackage.templates.set('layout', [
    '<html>',
    '  <body>',
    '    <nav class="global-taxonomies">',
    '      {{#for category in taxonomies.categories}}<a class="global-category" href="{{category.url}}" data-slug="{{category.slug}}" data-count="{{category.count}}" data-description="{{category.description}}">{{category.name}}</a>{{/for}}',
    '      {{#for tag in taxonomies.tags}}<a class="global-tag" href="{{tag.url}}" data-slug="{{tag.slug}}" data-count="{{tag.count}}" data-description="{{tag.description}}">{{tag.name}}</a>{{/for}}',
    '    </nav>',
    '    <main>{{slot:content}}</main>',
    '  </body>',
    '</html>',
  ].join('\n'));
  themePackage.templates.set('category', '<section class="category-route" data-count="{{taxonomy.count}}">{{taxonomy.name}}</section>');
  themePackage.templates.set('tag', '<section class="tag-route" data-count="{{taxonomy.count}}">{{taxonomy.name}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: true },
  });

  const files = writer.getFiles();
  const indexHtml = getFileContent(files, 'index.html');
  const postHtml = getFileContent(files, 'posts/101.html');
  const pageHtml = getFileContent(files, 'about.html');
  const notFoundHtml = getFileContent(files, '404.html');
  const categoryHtml = getFileContent(files, 'topics/general.html');
  const tagHtml = getFileContent(files, 'labels/intro.html');

  assert.match(indexHtml, /<a class="global-category" href="\/topics\/general" data-slug="general" data-count="3" data-description="General posts">General<\/a>/);
  assert.match(indexHtml, /<a class="global-category" href="\/topics\/empty-category" data-slug="empty-category" data-count="0" data-description="">Empty Category<\/a>/);
  assert.match(indexHtml, /<a class="global-tag" href="\/labels\/intro" data-slug="intro" data-count="3" data-description="">Intro<\/a>/);
  assert.match(indexHtml, /<a class="global-tag" href="\/labels\/quiet-tag" data-slug="quiet-tag" data-count="0" data-description="Tag with no posts">Quiet Tag<\/a>/);
  assert.match(categoryHtml, /<section class="category-route" data-count="3">General<\/section>/);
  assert.match(tagHtml, /<section class="tag-route" data-count="3">Intro<\/section>/);
  assert.match(postHtml, /<nav class="global-taxonomies">/);
  assert.match(pageHtml, /<nav class="global-taxonomies">/);
  assert.match(notFoundHtml, /<nav class="global-taxonomies">/);
});

test('buildSite applies date-based post permalinks in directory output style', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.permalinks = {
    output_style: 'directory',
    posts: '/posts/:year/:month/:day/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  };

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const postHtml = getFileContent(files, 'posts/2026/02/14/hello-zeropress/index.html');
  const indexHtml = getFileContent(files, 'index.html');

  assert.match(indexHtml, /<a href="\/posts\/2026\/02\/14\/hello-zeropress\/">Hello ZeroPress<\/a>/);
  assert.match(postHtml, /<link rel="canonical" href="https:\/\/example\.com\/posts\/2026\/02\/14\/hello-zeropress\/">/);
});

test('buildSite rejects duplicate permalink routes before writing files', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:public_id',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  };
  previewData.content.pages[0].path = 'posts/101';

  await assert.rejects(
    () => buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /Duplicate public URL detected: \/posts\/101/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects html-extension page path index public URL collisions', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:slug',
    pages: '/:slug',
    categories: '/categories/:slug',
    tags: '/tags/:slug',
  };
  previewData.content.pages[0].path = 'cli';
  previewData.content.pages.push({
    ...previewData.content.pages[0],
    title: 'CLI Index',
    slug: 'cli-index',
    path: 'cli/index',
  });

  await assert.rejects(
    () => buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /Duplicate public URL detected: \/cli\//,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite exposes pagination.window for compact page navigation', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  const templatePost = previewData.content.posts[0];

  previewData.site.posts_per_page = 1;
  previewData.content.posts = Array.from({ length: 10 }, (_, index) => ({
    ...templatePost,
    public_id: index + 1,
    title: `Window Post ${index + 1}`,
    slug: `window-post-${index + 1}`,
    published_at_iso: `2026-02-${String(28 - index).padStart(2, '0')}T09:00:00Z`,
    updated_at_iso: `2026-02-${String(28 - index).padStart(2, '0')}T09:00:00Z`,
  }));

  themePackage.templates.set('index', [
    '<nav class="window-pagination">',
    '  {{#for page in pagination.window}}',
    '    {{#if_eq page.kind "page"}}<a class="page{{#if page.current}} current{{/if}}" href="{{page.url}}">{{page.number}}</a>{{#else_if_eq page.kind "gap"}}<span class="gap">…</span>{{/if_eq}}',
    '  {{/for}}',
    '</nav>',
  ].join('\n'));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const fifthPageHtml = getFileContent(writer.getFiles(), 'page/5/index.html');
  assert.match(fifthPageHtml, /<nav class="window-pagination">/);
  assert.match(fifthPageHtml, /<a class="page" href="\/">1<\/a>\s*<span class="gap">…<\/span>\s*<a class="page" href="\/page\/4\/">4<\/a>\s*<a class="page current" href="\/page\/5\/">5<\/a>\s*<a class="page" href="\/page\/6\/">6<\/a>\s*<span class="gap">…<\/span>\s*<a class="page" href="\/page\/10\/">10<\/a>/);
});

test('buildSite runtime 0.6 exposes structured post surroundings without legacy post helpers', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.6';
  themePackage.templates.set('post', [
    '<article class="structured-post-shell">',
    '  <span class="structured-author">{{post.author.display_name}}</span>',
    '  <img class="structured-avatar" src="{{post.author.avatar}}" alt="{{post.author.display_name}}">',
    '  <div class="structured-categories">{{#for category in post.categories}}<a class="structured-category" href="{{category.url}}">{{category.name}}</a>{{/for}}</div>',
    '  <div class="structured-tags">{{#for tag in post.tags}}<a class="structured-tag" href="{{tag.url}}">{{tag.name}}</a>{{/for}}</div>',
    '  {{#if post.prev}}<a class="prev-post" href="{{post.prev.url}}">{{post.prev.title}}</a>{{/if}}',
    '  {{#if post.next}}<a class="next-post" href="{{post.next.url}}">{{post.next.title}}</a>{{/if}}',
    '</article>',
  ].join('\n'));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const firstPostHtml = getFileContent(files, 'posts/hello-zeropress/index.html');
  const secondPostHtml = getFileContent(files, 'posts/theme-blocks-deep-dive/index.html');
  const thirdPostHtml = getFileContent(files, 'posts/archive-patterns/index.html');

  assert.match(firstPostHtml, /<span class="structured-author">Admin<\/span>/);
  assert.match(firstPostHtml, /<img class="structured-avatar" src="" alt="Admin">/);
  assert.match(firstPostHtml, /<a class="structured-category" href="\/categories\/general\/">General<\/a>/);
  assert.match(firstPostHtml, /<a class="structured-tag" href="\/tags\/intro\/">Intro<\/a>/);
  assert.doesNotMatch(firstPostHtml, /class="prev-post"/);
  assert.match(firstPostHtml, /<a class="next-post" href="\/posts\/theme-blocks-deep-dive\/">Theme Blocks Deep Dive<\/a>/);

  assert.match(secondPostHtml, /<a class="prev-post" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a>/);
  assert.match(secondPostHtml, /<a class="next-post" href="\/posts\/archive-patterns\/">Archive Patterns<\/a>/);

  assert.match(thirdPostHtml, /<a class="prev-post" href="\/posts\/theme-blocks-deep-dive\/">Theme Blocks Deep Dive<\/a>/);
  assert.doesNotMatch(thirdPostHtml, /class="next-post"/);
});

test('buildSite fails closed before FilesystemWriter can escape the output directory', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-build-core-out-'));
  const escapedFileName = `${path.basename(outDir)}-escape.css`;
  const escapedPath = path.join(path.dirname(outDir), escapedFileName);

  try {
    const writer = new FilesystemWriter({ outDir });
    const previewData = await loadDefaultPreviewData();
    const themePackage = cloneThemePackage(await loadGoldenThemePackage());
    themePackage.assets.set(`../../${escapedFileName}`, createAssetBuffer());

    await assert.rejects(
      buildSite({
        previewData,
        themePackage,
        writer,
        options: { assetHashing: false, generateSpecialFiles: false },
      }),
      /Unsafe output path detected:/,
    );

    await assert.rejects(fs.access(escapedPath));
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(escapedPath, { force: true });
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

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  for (const outputPath of expectedPaths) {
    assert.equal(manifest.files.some((file) => file.path === outputPath), true, `Expected ${outputPath} in manifest`);
  }
});

test('buildSite rejects a page slug with traversal segments', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.pages[0].slug = '../escape';

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /INVALID_PAGE_SLUG/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects a post slug containing a slash', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[0].slug = 'a/b';

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /INVALID_POST_SLUG/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects a post slug containing whitespace', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[0].slug = 'hello world';

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /INVALID_POST_SLUG/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects a category slug that would create traversal-looking taxonomy paths', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.categories[0].slug = '../x';
  previewData.content.posts[0].category_slugs = ['../x'];

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /INVALID_POST_CATEGORY_SLUGS/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects a percent-encoded dangerous post slug', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[0].slug = '%2e%2e';

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /INVALID_POST_SLUG/,
  );
  assert.equal(writer.getFiles().length, 0);
});

test('buildSite rejects unsafe asset output paths before MemoryWriter records files', async () => {
  for (const assetPath of ['../../escape.css', '%2e%2e/escape.css']) {
    const writer = new MemoryWriter();
    const previewData = await loadDefaultPreviewData();
    const themePackage = cloneThemePackage(await loadGoldenThemePackage());
    themePackage.assets.set(assetPath, createAssetBuffer());

    await assert.rejects(
      buildSite({
        previewData,
        themePackage,
        writer,
        options: { assetHashing: false, generateSpecialFiles: false },
      }),
      /Unsafe output path detected:/,
    );
    assert.equal(writer.getFiles().length, 0, `Expected no files to be recorded for ${assetPath}`);
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
    options: { generateSpecialFiles: false },
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

  previewData.site.media_base_url = 'https://media.example.com';
  previewData.content.posts[0].featured_image = '/images/post-share.png';
  previewData.content.pages[0].excerpt = 'About page summary';
  previewData.content.pages[0].featured_image = './images/page-share.png';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
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

test('buildSite omits canonical and og:url when site.url is empty and still emits og:image from media_base_url', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.url = '';
  previewData.site.media_base_url = 'https://media.example.com';
  previewData.content.posts[0].featured_image = '/images/post-share.png';
  previewData.content.pages[0].featured_image = 'https://cdn.example.com/page-share.png';

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
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

test('buildSite normalizes media fields against site.media_base_url before rendering', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.media_base_url = 'https://media.example.com/base/';
  previewData.content.authors[0].avatar = '/avatars/author.png?size=96';
  previewData.content.posts[0].featured_image = './images/post-share.png?fit=cover';
  previewData.content.pages[0].featured_image = '/images/page-share.png?format=webp';

  themePackage.templates.set('post', [
    '<article',
    ' data-author-avatar="{{post.author.avatar}}"',
    ' data-featured-image="{{post.featured_image}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', '<section data-featured-image="{{page.featured_image}}">{{page.title}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /data-author-avatar="https:\/\/media\.example\.com\/avatars\/author\.png\?size=96"/);
  assert.match(postHtml, /data-featured-image="https:\/\/media\.example\.com\/base\/images\/post-share\.png\?fit=cover"/);
  assert.match(pageHtml, /data-featured-image="https:\/\/media\.example\.com\/images\/page-share\.png\?format=webp"/);
});

test('buildSite derives managed media and responsive srcset from content media registry', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.media_base_url = 'https://media.example.com';
  previewData.site.media_delivery_mode = 'media_domain';
  previewData.content.authors[0].avatar = '/avatars/admin.jpg';
  previewData.content.posts[0].featured_image = '/originals/hello.jpg';
  previewData.content.pages[0].featured_image = '/originals/about.png';
  previewData.content.media = [
    { src: '/avatars/admin.jpg', width: 512, height: 512, alt: 'Admin avatar' },
    { src: '/originals/hello.jpg', width: 1500, height: 900, alt: 'Hello cover' },
    { src: '/originals/about.png', width: 640, height: 360, alt: 'About cover' },
  ];

  themePackage.templates.set('post', [
    '<article',
    ' data-avatar-src="{{post.author.avatar_media.src}}"',
    ' data-avatar-srcset="{{post.author.avatar_media.srcset}}"',
    ' data-featured-src="{{post.featured_media.src}}"',
    ' data-featured-width="{{post.featured_media.width}}"',
    ' data-featured-height="{{post.featured_media.height}}"',
    ' data-featured-alt="{{post.featured_media.alt}}"',
    ' data-featured-srcset="{{post.featured_media.srcset}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', [
    '<section',
    ' data-featured-src="{{page.featured_media.src}}"',
    ' data-featured-srcset="{{page.featured_media.srcset}}">',
    '{{page.title}}',
    '</section>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /data-avatar-src="https:\/\/media\.example\.com\/avatars\/admin\.jpg"/);
  assert.match(postHtml, /data-avatar-srcset="[^"]*w=512&amp;fit=scale-down&amp;format=auto 512w/);
  assert.match(postHtml, /data-featured-src="https:\/\/media\.example\.com\/originals\/hello\.jpg"/);
  assert.match(postHtml, /data-featured-width="1500"/);
  assert.match(postHtml, /data-featured-height="900"/);
  assert.match(postHtml, /data-featured-alt="Hello cover"/);
  assert.match(postHtml, /w=1280&amp;fit=scale-down&amp;format=auto 1280w/);
  assert.match(postHtml, /w=1500&amp;fit=scale-down&amp;format=auto 1500w/);
  assert.doesNotMatch(postHtml, /w=1600&amp;fit=scale-down&amp;format=auto 1600w/);
  assert.match(pageHtml, /data-featured-src="https:\/\/media\.example\.com\/originals\/about\.png"/);
  assert.match(pageHtml, /w=640&amp;fit=scale-down&amp;format=auto 640w/);
  assert.doesNotMatch(pageHtml, /w=768&amp;fit=scale-down&amp;format=auto 768w/);
});

test('buildSite omits managed media srcset when delivery mode or media host is unavailable', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.media_base_url = '';
  previewData.site.media_delivery_mode = 'media_domain';
  previewData.content.posts[0].featured_image = '/originals/hello.jpg';
  previewData.content.posts[1].featured_image = 'https://cdn.example.com/external.jpg';
  previewData.content.media = [
    { src: '/originals/hello.jpg', width: 1200, height: 800, alt: 'Local cover' },
    { src: 'https://cdn.example.com/external.jpg', width: 1200, height: 800, alt: 'External cover' },
  ];

  themePackage.templates.set('post', [
    '<article',
    ' data-featured-src="{{post.featured_media.src}}"',
    ' data-featured-srcset="{{post.featured_media.srcset}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const localPostHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const externalPostHtml = getFileContent(writer.getFiles(), 'posts/theme-blocks-deep-dive/index.html');

  assert.match(localPostHtml, /data-featured-src="\/originals\/hello\.jpg"/);
  assert.match(localPostHtml, /data-featured-srcset=""/);
  assert.match(externalPostHtml, /data-featured-src="https:\/\/cdn\.example\.com\/external\.jpg"/);
  assert.match(externalPostHtml, /data-featured-srcset=""/);
});

test('buildSite leaves managed media undefined when registry does not match media fields', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.media_base_url = 'https://media.example.com';
  previewData.site.media_delivery_mode = 'media_domain';
  previewData.content.posts[0].featured_image = '/originals/hello.jpg';
  previewData.content.media = [
    { src: '/originals/other.jpg', width: 1200, height: 800, alt: 'Other cover' },
  ];

  themePackage.templates.set('post', [
    '<article',
    ' data-featured-src="{{post.featured_media.src}}"',
    ' data-featured-srcset="{{post.featured_media.srcset}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.match(postHtml, /data-featured-src=""/);
  assert.match(postHtml, /data-featured-srcset=""/);
});

test('buildSite preserves relative media fields when site.media_base_url is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.authors[0].avatar = '/avatars/author.png';
  previewData.content.posts[0].featured_image = './images/post-share.png';
  previewData.content.pages[0].featured_image = '/images/page-share.png';

  themePackage.templates.set('post', [
    '<article',
    ' data-author-avatar="{{post.author.avatar}}"',
    ' data-featured-image="{{post.featured_image}}">',
    '{{post.title}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', '<section data-featured-image="{{page.featured_image}}">{{page.title}}</section>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  const pageHtml = getFileContent(writer.getFiles(), 'about/index.html');

  assert.match(postHtml, /data-author-avatar="\/avatars\/author\.png"/);
  assert.match(postHtml, /data-featured-image="\.\/images\/post-share\.png"/);
  assert.match(pageHtml, /data-featured-image="\/images\/page-share\.png"/);
  assert.doesNotMatch(postHtml, /property="og:image"/);
  assert.doesNotMatch(pageHtml, /property="og:image"/);
});

test('buildSite formats timestamps with Intl datetime styles and exposes datetime_display', async () => {
  const publishedAt = '2026-05-15T13:12:34Z';
  const cases = [
    ['short', 'short'],
    ['medium', 'medium'],
    ['long', 'long'],
    ['full', 'full'],
    ['none', 'none'],
  ];

  for (const [date_style, time_style] of cases) {
    const writer = new MemoryWriter();
    const previewData = await loadDefaultPreviewData();
    const themePackage = cloneThemePackage(await loadGoldenThemePackage());
    previewData.site.locale = 'ko-KR';
    previewData.site.timezone = 'Asia/Seoul';
    previewData.site.datetime_display = 'client';
    previewData.site.date_style = date_style;
    previewData.site.time_style = time_style;
    previewData.content.posts = [{
      ...previewData.content.posts[0],
      published_at_iso: publishedAt,
      updated_at_iso: publishedAt,
    }];
    themePackage.templates.set('post', '<time datetime="{{post.published_at_iso}}" data-display="{{site.datetime_display}}">{{post.published_at}}</time>');

    await buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    });

    const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
    const expected = formatExpectedIntlTimestamp(publishedAt, {
      locale: 'ko-KR',
      timezone: 'Asia/Seoul',
      date_style,
      time_style,
    });

    assert.match(postHtml, /data-display="client"/);
    assert.match(postHtml, new RegExp(`<time datetime="2026-05-15T13:12:34Z" data-display="client">${escapeRegExp(expected)}<\\/time>`));
    assert.match(postHtml, /datetime="2026-05-15T13:12:34Z"/);
  }
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
  assert.equal(files.some((file) => file.path === 'meta.json'), false);

  const robotsTxt = getFileContent(files, 'robots.txt');
  assert.equal(robotsTxt.trim(), 'User-agent: *\nAllow: /');

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(manifest.files.some((file) => file.path === 'sitemap.xml'), false);
  assert.equal(manifest.files.some((file) => file.path === 'feed.xml'), false);
});

test('buildSite can disable feed.xml while keeping other special files', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateFeed: false, writeManifest: true },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === 'sitemap.xml'), true);
  assert.equal(files.some((file) => file.path === 'feed.xml'), false);
  assert.equal(files.some((file) => file.path === 'robots.txt'), true);

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(manifest.files.some((file) => file.path === 'sitemap.xml'), true);
  assert.equal(manifest.files.some((file) => file.path === 'feed.xml'), false);
  assert.equal(manifest.files.some((file) => file.path === 'robots.txt'), true);
});

test('buildSite can add a stylesheet processing instruction to sitemap.xml', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: {
      sitemapStylesheetHref: '/sitemap.xsl',
    },
  });

  const sitemapXml = getFileContent(writer.getFiles(), 'sitemap.xml');
  assert.match(
    sitemapXml,
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<\?xml-stylesheet type="text\/xsl" href="\/sitemap\.xsl"\?>\n<urlset/,
  );
});

test('buildSite exposes page updated timestamp and writes page sitemap lastmod', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.pages[0].updated_at_iso = '2026-05-27T11:20:30+09:00';
  previewData.content.pages.push({
    ...previewData.content.pages[0],
    title: 'Guide',
    slug: 'guide',
    content: '# Guide\n\nA second page.',
    excerpt: 'A second page.',
    updated_at_iso: '2026-05-28T12:30:00+09:00',
  });
  previewData.collections = {
    docs: {
      title: 'Docs',
      items: [
        { type: 'page', slug: 'about' },
        { type: 'page', slug: 'guide' },
      ],
    },
  };
  themePackage.templates.set('index', [
    '{{#for item in collections.docs.items}}',
    '<span data-item="{{item.slug}}" data-updated="{{item.updated_at}}" data-iso="{{item.updated_at_iso}}">{{item.title}}</span>',
    '{{/for}}',
  ].join(''));
  themePackage.templates.set('page', [
    '<time datetime="{{page.updated_at_iso}}">{{page.updated_at}}</time>',
    '{{#if page.collection_cursor.next}}',
    '<a data-next-updated="{{page.collection_cursor.next.updated_at_iso}}" href="{{page.collection_cursor.next.url}}">{{page.collection_cursor.next.title}}</a>',
    '{{/if}}',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const aboutHtml = getFileContent(files, 'about/index.html');
  const indexHtml = getFileContent(files, 'index.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');
  const searchJson = JSON.parse(getFileContent(files, '_zeropress/search.json'));

  assert.match(aboutHtml, /<time datetime="2026-05-27T02:20:30Z">May 27, 2026<\/time>/);
  assert.match(aboutHtml, /data-next-updated="2026-05-28T03:30:00Z"/);
  assert.match(indexHtml, /data-item="about" data-updated="May 27, 2026" data-iso="2026-05-27T02:20:30Z"/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/about\/<\/loc>\n    <lastmod>2026-05-27T02:20:30Z<\/lastmod>/);
  assert.equal(searchJson.find((item) => item.id === 'page:about')?.updated_at_iso, '2026-05-27T02:20:30Z');
});

test('buildSite rejects invalid page updated_at_iso', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.pages[0].updated_at_iso = 'not-a-date';

  await assert.rejects(
    () => buildSite({
      previewData,
      themePackage,
      writer,
    }),
    /INVALID_PAGE_UPDATED_AT_ISO|content\.pages\[0\]\.updated_at_iso/,
  );
});

test('buildSite renders fallback robots.txt from site.indexing policy', async () => {
  const themePackage = await loadGoldenThemePackage();

  {
    const writer = new MemoryWriter();
    const previewData = await loadDefaultPreviewData();
    previewData.site.indexing = true;

    await buildSite({
      previewData,
      themePackage,
      writer,
    });

    const robotsTxt = getFileContent(writer.getFiles(), 'robots.txt');
    assert.match(robotsTxt, /^User-agent: \*\nAllow: \//);
    assert.match(robotsTxt, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  }

  {
    const writer = new MemoryWriter();
    const previewData = await loadDefaultPreviewData();
    previewData.site.indexing = false;

    await buildSite({
      previewData,
      themePackage,
      writer,
    });

    const files = writer.getFiles();
    const robotsTxt = getFileContent(files, 'robots.txt');
    assert.equal(robotsTxt.trim(), 'User-agent: *\nDisallow: /');
    assert.equal(files.some((file) => file.path === 'sitemap.xml'), true);
    assert.equal(files.some((file) => file.path === 'feed.xml'), true);
    assert.doesNotMatch(getFileContent(files, 'posts/hello-zeropress/index.html'), /<meta name="robots" content="noindex">/);
  }
});

test('buildSite applies noindex discoverability without removing automatic listings', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[0].discoverability = 'noindex';
  previewData.content.pages[0].discoverability = 'noindex';

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  assert.match(getFileContent(files, 'posts/hello-zeropress/index.html'), /<meta name="robots" content="noindex">/);
  assert.match(getFileContent(files, 'about/index.html'), /<meta name="robots" content="noindex">/);
  assert.match(getFileContent(files, 'index.html'), /Hello ZeroPress/);
  assert.match(getFileContent(files, 'sitemap.xml'), /https:\/\/example\.com\/posts\/hello-zeropress\//);
  assert.match(getFileContent(files, 'sitemap.xml'), /https:\/\/example\.com\/about\//);
  assert.match(getFileContent(files, 'feed.xml'), /Hello ZeroPress/);

  const searchItems = JSON.parse(getFileContent(files, '_zeropress/search.json'));
  assert.equal(searchItems.some((item) => item.id === 'post:hello-zeropress'), true);
  assert.equal(searchItems.some((item) => item.id === 'page:about'), true);
});

test('buildSite delists posts from automatic discovery while preserving direct routes and explicit collections', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.content.posts[0].discoverability = 'delist';
  previewData.widgets = {
    sidebar: {
      name: 'Sidebar',
      items: [{ type: 'recent-posts', title: 'Recent', settings: { limit: 3 } }],
    },
  };
  previewData.collections = {
    featured: {
      title: 'Featured',
      items: [{ type: 'post', slug: 'hello-zeropress' }],
    },
  };
  themePackage.templates.set('index', `${themePackage.templates.get('index')}
<aside class="recent-widget">{{#for widget in widgets.sidebar.items}}{{#for item in widget.items}}<span>{{item.title}}</span>{{/for}}{{/for}}</aside>
<section class="featured-collection">{{#for item in collections.featured.items}}<span>{{item.title}}</span>{{/for}}</section>`);
  themePackage.templates.set('post', `${themePackage.templates.get('post')}
<nav class="post-adjacent">{{#if post.prev}}<span class="prev">{{post.prev.title}}</span>{{/if}}{{#if post.next}}<span class="next">{{post.next.title}}</span>{{/if}}</nav>`);

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  const delistedPostHtml = getFileContent(files, 'posts/hello-zeropress/index.html');
  const nextPostHtml = getFileContent(files, 'posts/theme-blocks-deep-dive/index.html');
  const indexHtml = getFileContent(files, 'index.html');
  const categoryHtml = getFileContent(files, 'categories/general/index.html');
  const tagHtml = getFileContent(files, 'tags/intro/index.html');
  const archiveHtml = getFileContent(files, 'archive/index.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');
  const feedXml = getFileContent(files, 'feed.xml');
  const searchItems = JSON.parse(getFileContent(files, '_zeropress/search.json'));
  const postListHtml = indexHtml.match(/<div class="posts">([\s\S]*?)<\/div>\s*<aside class="recent-widget">/)?.[1] || '';
  const recentWidgetHtml = indexHtml.match(/<aside class="recent-widget">([\s\S]*?)<\/aside>/)?.[1] || '';
  const featuredCollectionHtml = indexHtml.match(/<section class="featured-collection">([\s\S]*?)<\/section>/)?.[1] || '';

  assert.match(delistedPostHtml, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(postListHtml, /Hello ZeroPress/);
  assert.doesNotMatch(recentWidgetHtml, /Hello ZeroPress/);
  assert.match(featuredCollectionHtml, /Hello ZeroPress/);
  assert.doesNotMatch(categoryHtml, /Hello ZeroPress/);
  assert.doesNotMatch(tagHtml, /Hello ZeroPress/);
  assert.doesNotMatch(archiveHtml, /Hello ZeroPress/);
  assert.doesNotMatch(nextPostHtml, /class="prev">Hello ZeroPress/);
  assert.doesNotMatch(sitemapXml, /posts\/hello-zeropress\//);
  assert.doesNotMatch(feedXml, /Hello ZeroPress/);
  assert.equal(searchItems.some((item) => item.id === 'post:hello-zeropress'), false);
});

test('buildSite delists pages from sitemap and native search while preserving route HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.pages[0].discoverability = 'delist';

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  assert.match(getFileContent(files, 'about/index.html'), /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(getFileContent(files, 'sitemap.xml'), /https:\/\/example\.com\/about\//);

  const searchItems = JSON.parse(getFileContent(files, '_zeropress/search.json'));
  assert.equal(searchItems.some((item) => item.id === 'page:about'), false);
});

test('buildSite delists page front pages from sitemap and native search while preserving root HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.front_page = { type: 'page', page_slug: 'about' };
  previewData.site.post_index = { enabled: false };
  previewData.content.pages[0].discoverability = 'delist';

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const files = writer.getFiles();
  assert.match(getFileContent(files, 'index.html'), /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(getFileContent(files, 'sitemap.xml'), /https:\/\/example\.com\/<\/loc>/);

  const searchItems = JSON.parse(getFileContent(files, '_zeropress/search.json'));
  assert.equal(searchItems.some((item) => item.id === 'page:about'), false);
});

test('buildSite can disable fallback robots.txt while keeping other special files', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true, generateRobotsTxt: false },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === 'robots.txt'), false);
  assert.equal(files.some((file) => file.path === 'sitemap.xml'), true);
  assert.equal(files.some((file) => file.path === 'feed.xml'), true);

  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(manifest.files.some((file) => file.path === 'robots.txt'), false);
});

test('buildSite emits native static search artifacts and adapter results', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.front_page = { type: 'page', page_slug: 'about' };
  previewData.site.post_index = { enabled: false };
  previewData.content.posts = [
    {
      ...previewData.content.posts[0],
      title: 'Alpha Release',
      slug: 'alpha-release',
      content: '<p>General release notes</p>',
      excerpt: '',
      published_at_iso: '2026-02-14T09:00:00Z',
      updated_at_iso: '2026-02-14T10:00:00Z',
    },
    {
      ...previewData.content.posts[1],
      title: 'Body Only',
      slug: 'body-only',
      content: '<p>Alpha appears only in body text.</p>',
      excerpt: '',
      published_at_iso: '2026-02-13T09:00:00Z',
      updated_at_iso: '2026-02-13T10:00:00Z',
    },
    {
      ...previewData.content.posts[2],
      title: '서울 안내',
      slug: 'seoul-guide',
      content: '<p>한강과 서울 여행 정보를 정리합니다.</p>',
      excerpt: '',
      published_at_iso: '2026-02-12T09:00:00Z',
      updated_at_iso: '2026-02-12T10:00:00Z',
    },
  ];
  previewData.content.pages = [
    {
      title: 'About',
      slug: 'about',
      content: '## Search Heading\n\nAbout page 서울 content.',
      document_type: 'markdown',
      status: 'published',
    },
    {
      title: 'Visible Page',
      slug: 'visible-page',
      content: '<script>hiddenSearchTerm()</script><style>.hidden{color:red}</style><p>Visible text for search.</p>',
      document_type: 'html',
      status: 'published',
    },
  ];

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  const searchJson = getFileContent(files, '_zeropress/search.json');
  const searchJs = getFileContent(files, '_zeropress/search.js');
  const searchPagefindJs = getFileContent(files, '_zeropress/search_pagefind.js');
  const searchItems = JSON.parse(searchJson);
  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));

  assert.equal(files.some((file) => file.path === '_zeropress/search.json'), true);
  assert.equal(files.some((file) => file.path === '_zeropress/search.js'), true);
  assert.equal(files.some((file) => file.path === '_zeropress/search_pagefind.js'), true);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.json'), true);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.js'), true);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search_pagefind.js'), true);
  assert.deepEqual(searchItems.map((item) => item.id).sort(), [
    'page:about',
    'page:visible-page',
    'post:alpha-release',
    'post:body-only',
    'post:seoul-guide',
  ]);
  assert.equal(searchItems.find((item) => item.id === 'page:about')?.url, '/');
  assert.deepEqual(searchItems.find((item) => item.id === 'page:about')?.headings, ['Search Heading']);
  assert.match(searchItems.find((item) => item.id === 'page:visible-page')?.content_text, /Visible text for search/);
  assert.doesNotMatch(searchItems.find((item) => item.id === 'page:visible-page')?.content_text || '', /hiddenSearchTerm|color:red/);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-search-adapter-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}\n');
  const adapterPath = path.join(tempDir, 'search.js');
  await fs.writeFile(adapterPath, searchJs);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /search\.json$/);
    return {
      ok: true,
      json: async () => searchItems,
    };
  };

  try {
    const searchModule = await import(`${pathToFileURL(adapterPath).href}?t=${Date.now()}`);
    const alphaResults = await searchModule.search('alpha', { limit: 5 });
    assert.equal(alphaResults.results.length >= 2, true);
    assert.equal((await alphaResults.results[0].data()).meta.title, 'Alpha Release');
    assert.equal((await alphaResults.results[1].data()).meta.title, 'Body Only');

    const hangulResults = await searchModule.search('서울', { limit: 5 });
    assert.equal(hangulResults.results.length > 0, true);
    const hangulTitles = await Promise.all(hangulResults.results.map(async (result) => (await result.data()).meta.title));
    assert.equal(hangulTitles.includes('서울 안내'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const pagefindAdapterPath = path.join(tempDir, 'search_pagefind.js');
  const pagefindDir = path.join(tempDir, 'pagefind');
  await fs.mkdir(pagefindDir);
  await fs.writeFile(pagefindAdapterPath, searchPagefindJs);
  await fs.writeFile(path.join(pagefindDir, 'pagefind.js'), `export const configuredOptions = [];
export async function options(value) {
  configuredOptions.push(value);
}
export async function search(query, options = {}) {
  return {
    results: [
      { id: 'one', data: async () => ({ url: '/_zeropress/getting-started/', sub_results: [{ url: '/_zeropress/getting-started/#install' }] }) },
      { id: 'two', data: async () => ({ url: '_zeropress/reference/' }) },
      { id: 'three', data: async () => ({ url: '/three/' }) }
    ],
    query,
    options
  };
}
`);
  const pagefindModule = await import(`${pathToFileURL(pagefindAdapterPath).href}?t=${Date.now()}`);
  const preloadedPagefind = await pagefindModule.preload();
  assert.equal(typeof preloadedPagefind.search, 'function');
  assert.deepEqual(preloadedPagefind.configuredOptions, [{ baseUrl: '/' }]);
  const pagefindResults = await pagefindModule.search('anything', { limit: 2 });
  assert.deepEqual(pagefindResults.results.map((result) => result.id), ['one', 'two']);
  assert.equal(pagefindResults.query, 'anything');
  assert.equal((await pagefindResults.results[0].data()).url, '/getting-started/');
  assert.equal((await pagefindResults.results[0].data()).sub_results[0].url, '/getting-started/#install');
  assert.equal((await pagefindResults.results[1].data()).url, '/reference/');
});

test('buildSite skips native search artifacts when special files are disabled', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  assert.equal(files.some((file) => file.path === '_zeropress/search.json'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search.js'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search_pagefind.js'), false);
});

test('buildSite skips native search artifacts when theme does not support search', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.metadata.features = {
    comments: true,
    newsletter: false,
  };
  themePackage.templates.set('index', '{{#if site.search}}search enabled{{#else}}search disabled{{/if}}');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(files.some((file) => file.path === '_zeropress/search.json'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search.js'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search_pagefind.js'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.json'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.js'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search_pagefind.js'), false);
  assert.match(getFileContent(files, 'index.html'), /search disabled/);
});

test('buildSite skips native search artifacts when site search is disabled', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  previewData.site.search = false;
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('index', '{{#if site.search}}search enabled{{#else}}search disabled{{/if}}');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { writeManifest: true },
  });

  const files = writer.getFiles();
  const manifest = JSON.parse(getFileContent(files, 'build-manifest.json'));
  assert.equal(files.some((file) => file.path === '_zeropress/search.json'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search.js'), false);
  assert.equal(files.some((file) => file.path === '_zeropress/search_pagefind.js'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.json'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search.js'), false);
  assert.equal(manifest.files.some((file) => file.path === '_zeropress/search_pagefind.js'), false);
  assert.match(getFileContent(files, 'index.html'), /search disabled/);
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

test('buildSite omits comment container markup when site.disallow_comments is true', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.site.disallow_comments = true;

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.equal(postHtml.includes('data-zp-comments'), false);
  assert.equal(postHtml.includes('htmx.org'), false);
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
  assert.equal(postHtml.includes('data-zp-comments'), false);
  assert.equal(postHtml.includes('htmx.org'), false);
});

test('buildSite renders an empty comments mount when comments are enabled', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.equal(postHtml.includes('data-zp-comments'), true);
  assert.equal(postHtml.includes('data-zp-comments-post="101"'), true);
  assert.equal(postHtml.includes('hidden></div>'), true);
  assert.equal(postHtml.includes('htmx.org'), false);
});

test('buildSite disables comments when the theme capability is missing', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  delete themePackage.metadata.features;

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');

  assert.equal(postHtml.includes('data-zp-comments'), false);
  assert.equal(writer.getFiles().some((file) => file.path === '_zeropress/comment-policy.json'), false);
});

test('renderDocument creates markdown TOC from h2-h4 headings only', () => {
  const document = renderDocument([
    '# Page Title',
    '',
    '## Same',
    '',
    '### **Marked** `API`',
    '',
    '#### Details',
    '',
    '##### Too Deep',
    '',
    '###### Also Too Deep',
    '',
    '## Same',
  ].join('\n'), 'markdown');

  assert.deepEqual(document.toc, [
    {
      level: 2,
      id: 'same',
      title: 'Same',
      href: '#same',
    },
    {
      level: 3,
      id: 'marked-api',
      title: 'Marked API',
      href: '#marked-api',
    },
    {
      level: 4,
      id: 'details',
      title: 'Details',
      href: '#details',
    },
    {
      level: 2,
      id: 'same-1',
      title: 'Same',
      href: '#same-1',
    },
  ]);
  assert.match(document.html, /<h1 id="page-title">Page Title<\/h1>/);
  assert.match(document.html, /<h2 id="same">Same<\/h2>/);
  assert.match(document.html, /<h3 id="marked-api"><strong>Marked<\/strong> <code>API<\/code><\/h3>/);
  assert.match(document.html, /<h2 id="same-1">Same<\/h2>/);
  assert.doesNotMatch(document.html, /class="header-anchor"/);
});

test('renderDocument preserves standard markdown compatibility output', () => {
  const table = renderDocument([
    '| Name | Count |',
    '| --- | ---: |',
    '| Alpha | 1 |',
  ].join('\n'), 'markdown');
  const strike = renderDocument('This is ~~deleted~~ text.', 'markdown');
  const mermaid = renderDocument([
    '```mermaid',
    'graph TD;',
    '```',
  ].join('\n'), 'markdown');

  assert.match(table.html, /<table>/);
  assert.match(table.html, /<th>Name<\/th>/);
  assert.match(table.html, /<th class="zp-align-right">Count<\/th>/);
  assert.match(table.html, /<td>Alpha<\/td>/);
  assert.match(table.html, /<td class="zp-align-right">1<\/td>/);
  assert.doesNotMatch(table.html, /style=/);
  const alignedTable = renderDocument([
    '| Left | Center | Right |',
    '| :--- | :---: | ---: |',
    '| a | b | c |',
  ].join('\n'), 'markdown');
  assert.match(alignedTable.html, /<th class="zp-align-left">Left<\/th>/);
  assert.match(alignedTable.html, /<th class="zp-align-center">Center<\/th>/);
  assert.match(alignedTable.html, /<th class="zp-align-right">Right<\/th>/);
  assert.match(alignedTable.html, /<td class="zp-align-left">a<\/td>/);
  assert.match(alignedTable.html, /<td class="zp-align-center">b<\/td>/);
  assert.match(alignedTable.html, /<td class="zp-align-right">c<\/td>/);
  assert.match(strike.html, /<s>deleted<\/s>/);
  assert.match(mermaid.html, /<code class="language-mermaid">/);
});

test('renderDocument does not auto-link bare domains or filename-like text', () => {
  const document = renderDocument([
    '## When To example.com site',
    '',
    '## When To build.sh Instead',
    '',
    'Use example.com and build.sh as plain text unless the author writes a Markdown link.',
    '',
    'Use [Example](https://example.com) when a link is intended.',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<h2 id="when-to-examplecom-site">When To example\.com site<\/h2>/);
  assert.match(document.html, /<h2 id="when-to-buildsh-instead">When To build\.sh Instead<\/h2>/);
  assert.match(document.html, /<p>Use example\.com and build\.sh as plain text unless the author writes a Markdown link\.<\/p>/);
  assert.match(document.html, /<a href="https:\/\/example\.com">Example<\/a>/);
  assert.doesNotMatch(document.html, /href="http:\/\/example\.com"/);
  assert.doesNotMatch(document.html, /href="http:\/\/build\.sh"/);
});

test('renderDocument preserves safe semantic media HTML in markdown', () => {
  const document = renderDocument([
    '<figure class="gallery-item" onclick="alert(1)">',
    '<picture class="responsive-media">',
    '<source media="(min-width: 900px)" srcset="/images/hero-large.webp 1200w, /images/hero.webp 800w" sizes="(min-width: 900px) 720px, 100vw" type="image/webp">',
    '<img src="/images/hero.jpg" srcset="/images/hero.jpg 800w, /images/hero@2x.jpg 1600w" sizes="100vw" alt="Hero" width="800" height="450" loading="lazy" decoding="async" style="width:100%">',
    '</picture>',
    '<figcaption id="hero-caption">Hero caption</figcaption>',
    '</figure>',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<figure class="gallery-item">/);
  assert.match(document.html, /<picture class="responsive-media">/);
  assert.match(document.html, /<source media="\(min-width: 900px\)" srcset="\/images\/hero-large\.webp 1200w, \/images\/hero\.webp 800w" sizes="\(min-width: 900px\) 720px, 100vw" type="image\/webp" \/>/);
  assert.match(document.html, /<img src="\/images\/hero\.jpg" srcset="\/images\/hero\.jpg 800w, \/images\/hero@2x\.jpg 1600w" sizes="100vw" alt="Hero" width="800" height="450" loading="lazy" decoding="async" \/>/);
  assert.match(document.html, /<figcaption id="hero-caption">Hero caption<\/figcaption>/);
  assert.doesNotMatch(document.html, /onclick/);
  assert.doesNotMatch(document.html, /style=/);
});

test('renderDocument preserves safe iframe title in markdown', () => {
  const document = renderDocument(
    '<iframe src="https://www.youtube.com/embed/demo" title="YouTube video player" width="560" height="315" frameborder="0" allowfullscreen></iframe>',
    'markdown',
  );

  assert.match(document.html, /<iframe src="https:\/\/www\.youtube\.com\/embed\/demo" title="YouTube video player" width="560" height="315" frameborder="0" allowfullscreen=""><\/iframe>/);
});

test('renderDocument preserves safe native media HTML in markdown', () => {
  const document = renderDocument([
    '<video controls controlsList="nofullscreen nodownload unknown nodownload" autoplay="" loop="" muted playsinline poster="/media/demo.jpg" preload="metadata" width="640" height="360" title="Demo" style="width:100%" onclick="alert(1)">',
    '<source src="/media/demo.mp4" type="video/mp4">',
    '<track src="/media/demo-en.vtt" kind="captions" srclang="en" label="English" default>',
    '</video>',
    '<audio controls controlsList="nodownload noremoteplayback" preload="none" title="Audio demo">',
    '<source src="/media/demo.mp3" type="audio/mpeg">',
    '</audio>',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<video controls="" controlslist="nofullscreen nodownload" autoplay="" loop="" muted="" playsinline="" poster="\/media\/demo\.jpg" preload="metadata" width="640" height="360" title="Demo">/);
  assert.match(document.html, /<source src="\/media\/demo\.mp4" type="video\/mp4" \/>/);
  assert.match(document.html, /<track src="\/media\/demo-en\.vtt" kind="captions" srclang="en" label="English" default="" \/>/);
  assert.match(document.html, /<\/video>/);
  assert.match(document.html, /<audio controls="" controlslist="nodownload noremoteplayback" preload="none" title="Audio demo">/);
  assert.match(document.html, /<source src="\/media\/demo\.mp3" type="audio\/mpeg" \/>/);
  assert.match(document.html, /<\/audio>/);
  assert.doesNotMatch(document.html, /onclick/);
  assert.doesNotMatch(document.html, /style=/);
  assert.doesNotMatch(document.html, /unknown/);
});

test('renderDocument removes unsafe native media URLs in markdown', () => {
  const document = renderDocument([
    '<video src="javascript:alert(1)" poster="javascript:alert(1)" controls>',
    '<source src="javascript:alert(1)" type="video/mp4">',
    '<track src="javascript:alert(1)" kind="captions">',
    '</video>',
    '<audio src="javascript:alert(1)" controls controlsList="badtoken"></audio>',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<video controls="">/);
  assert.match(document.html, /<source type="video\/mp4" \/>/);
  assert.match(document.html, /<track kind="captions" \/>/);
  assert.match(document.html, /<audio controls=""><\/audio>/);
  assert.doesNotMatch(document.html, /javascript:alert/);
  assert.doesNotMatch(document.html, /poster=/);
  assert.doesNotMatch(document.html, /controlslist/);
});

test('renderDocument removes unsafe srcset candidates from semantic media HTML', () => {
  const document = renderDocument([
    '<picture>',
    '<source srcset="javascript:alert(1) 1x" type="image/webp">',
    '<img src="/safe.jpg" srcset="javascript:alert(1) 1x" alt="Safe">',
    '</picture>',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<source type="image\/webp" \/>/);
  assert.match(document.html, /<img src="\/safe\.jpg" alt="Safe" \/>/);
  assert.doesNotMatch(document.html, /javascript:alert/);
});

test('renderDocument renders GFM-compatible task lists', () => {
  const document = renderDocument([
    '- [x] Done',
    '- [ ] Todo',
  ].join('\n'), 'markdown');

  assert.match(document.html, /<ul class="contains-task-list">/);
  assert.match(document.html, /<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" checked="" disabled="" aria-label="Completed task" \/> Done<\/li>/);
  assert.match(document.html, /<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled="" aria-label="Incomplete task" \/> Todo<\/li>/);
  assert.doesNotMatch(document.html, /\[x\]/);
  assert.doesNotMatch(document.html, /\[ \]/);
});

test('renderDocument renders GitHub alerts as ZeroPress alert blocks', () => {
  const markers = [
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['CAUTION', 'caution', 'Caution'],
  ];

  for (const [marker, className, title] of markers) {
    const document = renderDocument([
      `> [!${marker}]`,
      '> Alert body with **formatting**.',
    ].join('\n'), 'markdown');

    assert.match(document.html, new RegExp(`<aside class="zp-alert zp-alert--${className}" role="note">`));
    assert.match(document.html, new RegExp(`<p class="zp-alert__title">${title}</p>`));
    assert.match(document.html, /<p>Alert body with <strong>formatting<\/strong>\.<\/p>/);
    assert.doesNotMatch(document.html, new RegExp(`\\[!${marker}\\]`));
  }

  const unsupported = renderDocument([
    '> [!TODO]',
    '> Keep this blockquote.',
  ].join('\n'), 'markdown');

  assert.match(unsupported.html, /<blockquote>/);
  assert.match(unsupported.html, /\[!TODO\]/);
  assert.doesNotMatch(unsupported.html, /zp-alert/);
});

test('renderDocument keeps alert headings in markdown TOC', () => {
  const document = renderDocument([
    '> [!NOTE]',
    '>',
    '> ## Alert Heading',
    '> Body',
  ].join('\n'), 'markdown');

  assert.deepEqual(document.toc, [
    {
      level: 2,
      id: 'alert-heading',
      title: 'Alert Heading',
      href: '#alert-heading',
    },
  ]);
  assert.match(document.html, /<aside class="zp-alert zp-alert--note" role="note">/);
  assert.match(document.html, /<h2 id="alert-heading">Alert Heading<\/h2>/);
});

test('renderDocument leaves non-markdown TOC empty', () => {
  assert.deepEqual(renderDocument('<h2 id="custom">Custom</h2>', 'html').toc, []);
  assert.deepEqual(renderDocument('## Plaintext heading', 'plaintext').toc, []);
});

test('buildSite exposes markdown TOC to page and post templates', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.content.posts = [
    {
      public_id: 1,
      title: 'TOC Post',
      slug: 'toc-post',
      content: [
        '# TOC Post',
        '',
        '## Overview',
        '',
        '### Details',
        '',
        '##### Appendix',
      ].join('\n'),
      document_type: 'markdown',
      excerpt: 'TOC excerpt',
      published_at_iso: '2026-04-02T00:00:00Z',
      updated_at_iso: '2026-04-02T00:00:00Z',
      author_id: previewData.content.authors[0].id,
      status: 'published',
      allow_comments: false,
      category_slugs: [],
      tag_slugs: [],
    },
  ];
  previewData.content.pages = [
    {
      title: 'TOC Page',
      slug: 'toc-page',
      content: [
        '# TOC Page',
        '',
        '## Start',
        '',
        '#### Fine Print',
      ].join('\n'),
      document_type: 'markdown',
      status: 'published',
    },
    {
      title: 'HTML Page',
      slug: 'html-page',
      content: '<h2 id="manual">Manual HTML</h2>',
      document_type: 'html',
      status: 'published',
    },
  ];
  themePackage.templates.set('post', [
    '<article>',
    '{{#for item in post.toc}}<a class="post-toc-item toc-level-{{item.level}}" href="{{item.href}}" data-id="{{item.id}}">{{item.title}}</a>{{/for}}',
    '{{post.html}}',
    '</article>',
  ].join(''));
  themePackage.templates.set('page', [
    '<article>',
    '{{#if page.toc}}<nav class="page-toc">{{#for item in page.toc}}<a class="page-toc-item toc-level-{{item.level}}" href="{{item.href}}" data-id="{{item.id}}">{{item.title}}</a>{{/for}}</nav>{{/if}}',
    '{{page.html}}',
    '</article>',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const postHtml = getFileContent(files, 'posts/toc-post/index.html');
  const markdownPageHtml = getFileContent(files, 'toc-page/index.html');
  const htmlPageHtml = getFileContent(files, 'html-page/index.html');

  assert.match(postHtml, /<a class="post-toc-item toc-level-2" href="#overview" data-id="overview">Overview<\/a>/);
  assert.match(postHtml, /<a class="post-toc-item toc-level-3" href="#details" data-id="details">Details<\/a>/);
  assert.doesNotMatch(postHtml, /href="#appendix"/);
  assert.match(postHtml, /<h2 id="overview">Overview<\/h2>/);
  assert.match(markdownPageHtml, /<nav class="page-toc"><a class="page-toc-item toc-level-2" href="#start" data-id="start">Start<\/a><a class="page-toc-item toc-level-4" href="#fine-print" data-id="fine-print">Fine Print<\/a><\/nav>/);
  assert.match(htmlPageHtml, /<h2 id="manual">Manual HTML<\/h2>/);
  assert.doesNotMatch(htmlPageHtml, /page-toc/);
});

test('buildSite preserves markdown task list and alert HTML for pages and posts', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.content.posts = [
    {
      public_id: 1,
      title: 'Markdown Compatibility Post',
      slug: 'markdown-compat',
      content: [
        '# Markdown Compatibility Post',
        '',
        '- [x] Ship the renderer',
        '',
        '> [!WARNING]',
        '> Watch the sanitizer.',
      ].join('\n'),
      document_type: 'markdown',
      excerpt: 'Markdown compatibility excerpt',
      published_at_iso: '2026-04-02T00:00:00Z',
      updated_at_iso: '2026-04-02T00:00:00Z',
      author_id: previewData.content.authors[0].id,
      status: 'published',
      allow_comments: false,
      category_slugs: [],
      tag_slugs: [],
    },
  ];
  previewData.content.pages = [
    {
      title: 'Markdown Compatibility Page',
      slug: 'markdown-compat-page',
      content: [
        '# Markdown Compatibility Page',
        '',
        '- [ ] Review docs',
        '',
        '> [!TIP]',
        '> Use public files for progressive enhancement.',
      ].join('\n'),
      document_type: 'markdown',
      status: 'published',
    },
  ];
  themePackage.templates.set('post', '<article>{{post.html}}</article>');
  themePackage.templates.set('page', '<article>{{page.html}}</article>');

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const postHtml = getFileContent(files, 'posts/markdown-compat/index.html');
  const pageHtml = getFileContent(files, 'markdown-compat-page/index.html');

  assert.match(postHtml, /<ul class="contains-task-list">/);
  assert.match(postHtml, /<input class="task-list-item-checkbox" type="checkbox" checked="" disabled="" aria-label="Completed task" \/>/);
  assert.match(postHtml, /<aside class="zp-alert zp-alert--warning" role="note">/);
  assert.match(postHtml, /<p class="zp-alert__title">Warning<\/p>/);
  assert.doesNotMatch(postHtml, /\[!WARNING\]/);

  assert.match(pageHtml, /<ul class="contains-task-list">/);
  assert.match(pageHtml, /<input class="task-list-item-checkbox" type="checkbox" disabled="" aria-label="Incomplete task" \/>/);
  assert.match(pageHtml, /<aside class="zp-alert zp-alert--tip" role="note">/);
  assert.match(pageHtml, /<p class="zp-alert__title">Tip<\/p>/);
  assert.doesNotMatch(pageHtml, /\[!TIP\]/);
});

test('buildSite renders v0.6 raw content and resolves structured post author data from authors', async () => {
  const writer = new MemoryWriter();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('post', '<article class="post-entry">{{post.author.display_name}}|{{post.author.avatar}}|{{post.comments_enabled}}|{{post.slug}}|{{post.public_id}}|{{post.meta.badge}}|{{post.meta.rank}}|{{post.meta.featured}}|{{post.html}}</article>');
  themePackage.templates.set('page', '<article class="page-entry">{{page.meta.section}}|{{page.meta.order}}|{{page.html}}</article>');

  await buildSite({
    previewData: {
      version: '0.6',
      generator: 'test-suite',
      generated_at: '2026-04-02T00:00:00Z',
      site: {
        title: 'ZeroPress',
        description: 'Test preview data',
        url: 'https://example.com',
        media_base_url: 'https://media.example.com',
        locale: 'en-US',
        posts_per_page: 10,
        datetime_display: 'static',
        date_style: 'medium',
        time_style: 'none',
        timezone: 'UTC',
        disallow_comments: true,
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
            public_id: 1,
            title: 'Markdown Post',
            slug: 'markdown-post',
            content: '# Markdown Heading\n\nParagraph text.',
            document_type: 'markdown',
            excerpt: 'Markdown excerpt',
            published_at_iso: '2026-04-02T00:00:00Z',
            updated_at_iso: '2026-04-02T00:00:00Z',
            author_id: 'author-1',
            meta: {
              badge: 'featured',
              rank: 7,
              featured: true,
            },
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
            meta: {
              section: 'docs',
              order: 2,
            },
            status: 'published',
          },
        ],
        categories: [],
        tags: [],
      },
      menus: {},
      widgets: {},
    },
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const files = writer.getFiles();
  const postHtml = getFileContent(files, 'posts/markdown-post/index.html');
  const pageHtml = getFileContent(files, 'plaintext-page/index.html');

  assert.match(postHtml, /Admin\|https:\/\/media\.example\.com\/avatars\/admin\.webp\|false\|markdown-post\|1\|featured\|7\|true\|/);
  assert.match(postHtml, /<h1 id="markdown-heading">Markdown Heading<\/h1>/);
  assert.doesNotMatch(postHtml, /class="header-anchor"/);
  assert.match(postHtml, /<p>Paragraph text\.<\/p>/);
  assert.match(pageHtml, /docs\|2\|/);
  assert.match(pageHtml, /<p>First paragraph\.<\/p>/);
  assert.match(pageHtml, /<p>Second paragraph\.<\/p>/);
});

test('buildSite accepts missing menus and widgets and preserves site meta', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  delete previewData.menus;
  delete previewData.widgets;
  previewData.site.meta = {
    issue: 'Spring 2026',
    show_sponsor_banner: false,
  };
  themePackage.templates.set('index', [
    '<h1>{{site.meta.issue}}</h1>',
    '{{menu:primary}}',
    '{{#if menus.primary.items}}MENU{{/if}}',
    '{{#if widgets.sidebar.items}}WIDGET{{/if}}',
    '{{#if site.meta.show_sponsor_banner}}SPONSOR{{/if}}',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const indexHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(indexHtml, /Spring 2026/);
  assert.doesNotMatch(indexHtml, /MENU/);
  assert.doesNotMatch(indexHtml, /WIDGET/);
  assert.doesNotMatch(indexHtml, /SPONSOR/);
});

test('buildSite resolves named collections in every render context', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.content.posts[0].meta = {
    badge: 'Feature',
  };
  previewData.content.posts[0].data = {
    stack: ['ZeroPress', 'Cloudflare'],
    facts: [
      { label: 'Role', value: 'Writing' },
      { label: 'Year', value: 2026 },
    ],
  };
  previewData.content.pages[0].meta = {
    badge: 'Reference',
  };
  previewData.content.pages[0].data = {
    swatches: [
      { name: 'Ink', value: '#111111' },
    ],
  };
  previewData.collections = {
    'cover-story': {
      title: 'Cover Story',
      items: [
        { type: 'post', slug: previewData.content.posts[0].slug },
        { type: 'page', slug: previewData.content.pages[0].slug },
      ],
    },
  };

  const collectionTemplate = [
    '<section>{{collections.cover-story.title}} count={{collections.cover-story.count}}',
    '{{#for item in collections.cover-story.items}}',
    '<a data-type="{{item.type}}" data-badge="{{item.meta.badge}}" data-stack="{{#for stack in item.data.stack}}{{stack}};{{/for}}" data-swatch="{{#for swatch in item.data.swatches}}{{swatch.name}}={{swatch.value}}{{/for}}" href="{{item.url}}">{{item.title}}</a>',
    '{{/for}}</section>',
  ].join('');
  themePackage.templates.set('index', collectionTemplate);
  themePackage.templates.set('post', collectionTemplate);
  themePackage.templates.set('page', collectionTemplate);
  themePackage.templates.set('404', collectionTemplate);

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  for (const outputPath of ['index.html', 'posts/hello-zeropress/index.html', 'about/index.html', '404.html']) {
    const html = getFileContent(writer.getFiles(), outputPath);
    assert.match(html, /Cover Story/);
    assert.match(html, /count=2/);
    assert.match(html, /data-type="post" data-badge="Feature" data-stack="ZeroPress;Cloudflare;" data-swatch="" href="\/posts\/hello-zeropress\/"/);
    assert.match(html, /data-type="page" data-badge="Reference" data-stack="" data-swatch="Ink=#111111" href="\/about\/"/);
  }
});

test('buildSite exposes collection counts and route collection cursors', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.front_page = { type: 'page', page_slug: 'about' };
  previewData.site.post_index = { enabled: true, path: '/blog/', paginate: true };
  previewData.collections = {
    work: {
      title: 'Selected Work',
      items: [
        { type: 'post', slug: 'hello-zeropress' },
        { type: 'page', slug: 'about' },
        { type: 'post', slug: 'theme-blocks-deep-dive' },
      ],
    },
    secondary: {
      title: 'Secondary Work',
      items: [
        { type: 'post', slug: 'hello-zeropress' },
        { type: 'post', slug: 'archive-patterns' },
      ],
    },
    empty: {
      title: 'Empty Collection',
      items: [],
    },
  };
  previewData.content.posts[0].data = {
    stack: ['ZeroPress', 'SQLite'],
    facts: 'not an array',
    payload: { html: '<strong>safe</strong>' },
  };
  previewData.content.pages[0].data = {
    facts: [{ label: 'Type', value: 'Front Page' }],
  };

  themePackage.templates.set('post', [
    'stack={{#for item in post.data.stack}}{{item}};{{/for}}',
    'facts={{#for fact in post.data.facts}}{{fact.label}}{{/for}}',
    'object={{post.data.payload}} html={{post.data.payload.html}}',
    'work-count={{collections.work.count}} empty-count={{collections.empty.count}}',
    '{{#if collections.empty.items}}BAD-empty-items{{/if}}',
    '{{#if collections.empty.count}}BAD-empty-count{{/if}}',
    '{{#if post.collection_cursors.work.prev}} work-prev={{post.collection_cursors.work.prev.title}}:{{post.collection_cursors.work.prev.url}}{{/if}}',
    '{{#if post.collection_cursors.work.next}} work-next={{post.collection_cursors.work.next.type}}:{{post.collection_cursors.work.next.title}}:{{post.collection_cursors.work.next.url}}{{/if}}',
    '{{#if post.collection_cursors.work.first}} work-first{{/if}}',
    '{{#if post.collection_cursors.work.last}} work-last{{/if}}',
    '{{#if post.collection_cursors.secondary.next}} secondary-next={{post.collection_cursors.secondary.next.title}}{{/if}}',
    ' alias={{post.collection_cursor.collection_id}}:{{post.collection_cursor.collection_title}}',
    '{{#if post.collection_cursor.next}} alias-next={{post.collection_cursor.next.title}}{{/if}}',
  ].join(''));
  themePackage.templates.set('page', [
    'work-count={{collections.work.count}} empty-count={{collections.empty.count}}',
    ' page-pos={{page.collection_cursors.work.position}}/{{page.collection_cursors.work.count}}',
    ' page-alias={{page.collection_cursor.collection_id}}:{{page.collection_cursor.collection_title}}',
    ' page-facts={{#for fact in page.data.facts}}{{fact.label}}={{fact.value}}{{/for}}',
    ' page-prev-stack={{#for item in page.collection_cursors.work.prev.data.stack}}{{item}};{{/for}}',
    ' page-prev={{page.collection_cursors.work.prev.title}}:{{page.collection_cursors.work.prev.url}}',
    ' page-alias-prev={{page.collection_cursor.prev.title}}:{{page.collection_cursor.prev.url}}',
    ' page-next={{page.collection_cursors.work.next.title}}:{{page.collection_cursors.work.next.url}}',
    ' page-alias-next={{page.collection_cursor.next.title}}:{{page.collection_cursor.next.url}}',
    '{{#for item in collections.work.items}}<a href="{{item.url}}">{{item.title}}</a>{{/for}}',
  ].join(''));

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const firstPostHtml = getFileContent(writer.getFiles(), 'posts/hello-zeropress/index.html');
  assert.match(firstPostHtml, /stack=ZeroPress;SQLite;facts=object=\[object Object\] html=&lt;strong&gt;safe&lt;\/strong&gt;work-count=3/);
  assert.match(firstPostHtml, /work-count=3 empty-count=0/);
  assert.doesNotMatch(firstPostHtml, /BAD-empty/);
  assert.match(firstPostHtml, /work-first/);
  assert.doesNotMatch(firstPostHtml, /work-prev=/);
  assert.match(firstPostHtml, /work-next=page:About:\//);
  assert.match(firstPostHtml, /secondary-next=Archive Patterns/);
  assert.match(firstPostHtml, /alias=work:Selected Work/);
  assert.match(firstPostHtml, /alias-next=About/);

  const secondPostHtml = getFileContent(writer.getFiles(), 'posts/theme-blocks-deep-dive/index.html');
  assert.match(secondPostHtml, /work-last/);
  assert.match(secondPostHtml, /work-prev=About:\//);
  assert.doesNotMatch(secondPostHtml, /work-next=/);

  const frontPageHtml = getFileContent(writer.getFiles(), 'index.html');
  assert.match(frontPageHtml, /page-pos=2\/3/);
  assert.match(frontPageHtml, /page-alias=work:Selected Work/);
  assert.match(frontPageHtml, /page-facts=Type=Front Page/);
  assert.match(frontPageHtml, /page-prev-stack=ZeroPress;SQLite;/);
  assert.match(frontPageHtml, /page-prev=Hello ZeroPress:\/posts\/hello-zeropress\//);
  assert.match(frontPageHtml, /page-alias-prev=Hello ZeroPress:\/posts\/hello-zeropress\//);
  assert.match(frontPageHtml, /page-next=Theme Blocks Deep Dive:\/posts\/theme-blocks-deep-dive\//);
  assert.match(frontPageHtml, /page-alias-next=Theme Blocks Deep Dive:\/posts\/theme-blocks-deep-dive\//);
  assert.match(frontPageHtml, /<a href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a>/);
  assert.match(frontPageHtml, /<a href="\/">About<\/a>/);
});

test('buildSite rejects collections that reference missing content slugs', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.collections = {
    features: {
      items: [
        { type: 'post', slug: 'missing-post' },
      ],
    },
  };

  await assert.rejects(
    buildSite({
      previewData,
      themePackage,
      writer,
      options: { generateSpecialFiles: false },
    }),
    /Invalid collection "features": item 1 references missing post slug "missing-post"/,
  );
});

test('buildSite keeps ZeroPress template syntax inside markdown page content literal', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.content.pages = [
    {
      title: 'Theme Runtime',
      slug: 'theme-runtime-v0-5',
      content: [
        '# Theme Runtime',
        '',
        '```html',
        '{{#if site.title}}',
        '<h1>{{site.title}}</h1>',
        '{{#else}}',
        '<h1>Untitled</h1>',
        '{{/if}}',
        '```',
      ].join('\n'),
      document_type: 'markdown',
      status: 'published',
    },
  ];

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const pageHtml = getFileContent(writer.getFiles(), 'theme-runtime-v0-5/index.html');
  assert.match(pageHtml, /<h1 id="theme-runtime">Theme Runtime<\/h1>/);
  assert.doesNotMatch(pageHtml, /class="header-anchor"/);
  assert.match(pageHtml, /\{\{#if site\.title\}\}/);
  assert.match(pageHtml, /\{\{site\.title\}\}/);
  assert.match(pageHtml, /\{\{#else\}\}/);
  assert.match(pageHtml, /\{\{\/if\}\}/);
  assert.doesNotMatch(pageHtml, /ZeroPress Preview<\/h1>/);
});

test('buildSite preserves dollar replacement tokens inside content slot HTML', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.templates.set('layout', '<main>{{slot:content}}</main>');
  themePackage.templates.set('post', '<article>{{post.html}}</article>');
  previewData.content.posts = [
    {
      ...previewData.content.posts[0],
      title: 'Replacement Tokens',
      slug: 'replacement-tokens',
      content: [
        '```apache',
        '<FilesMatch \\.php$>',
        'return "$";',
        '```',
      ].join('\n'),
      document_type: 'markdown',
    },
  ];

  await buildSite({
    previewData,
    themePackage,
    writer,
    options: { generateSpecialFiles: false },
  });

  const postHtml = getFileContent(writer.getFiles(), 'posts/replacement-tokens/index.html');
  assert.match(postHtml, /&lt;FilesMatch \\.php\$&gt;/);
  assert.match(postHtml, /\$&quot;/);
  assert.doesNotMatch(postHtml, /ZEROPRESS_CONTENT_SLOT/);
});
