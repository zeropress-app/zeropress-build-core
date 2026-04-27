import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function createAssetBuffer(source = 'body { color: red; }') {
  return Buffer.from(source, 'utf8');
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
    renderText: (value, data) => String(value || '').replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}\}/g, (_, templatePath) => {
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

test('ControlFlowRenderer renders partial arguments and nested partial shadowing', () => {
  const renderer = createInterpolatingRenderer();
  const output = renderer.render(
    '{{partial:card variant="compact" show_excerpt=true}}',
    {
      post: {
        excerpt: 'Structured partial args',
      },
    },
    {
      partials: new Map([
        ['card', '<article data-variant="{{partial.variant}}">{{#if partial.show_excerpt}}<p>{{post.excerpt}}</p>{{/if}}{{partial:badge variant="nested"}}<span class="after">{{partial.variant}}</span></article>'],
        ['badge', '<em>{{partial.variant}}</em>'],
      ]),
    },
  );

  assert.equal(output, '<article data-variant="compact"><p>Structured partial args</p><em>nested</em><span class="after">compact</span></article>');
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
    ['meta.json', normalizeMetaJson(getFileContent(files, 'meta.json'))],
    ['build-manifest.summary.json', normalizeManifestSummary(getFileContent(files, 'build-manifest.json'))],
  ];

  for (const [relativePath, actual] of comparisons) {
    const expected = await readGolden(relativePath);
    assert.equal(actual.trim(), expected.trim(), `Golden fixture mismatch for ${relativePath}`);
  }
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
  previewData.site.mediaBaseUrl = 'https://media.example.com';

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

test('buildSite runtime 0.5 renders resolved widgets with escaping and safe URL filtering', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.5';
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

  previewData.site.mediaBaseUrl = 'https://media.example.com';
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
      runtime: '0.5',
      author: '  ZeroPress  ',
      description: '  Theme fixture  ',
      features: {
        comments: true,
        newsletter: false,
      },
      menuSlots: {
        primary: {
          title: '  Primary Menu  ',
          description: '  Main header navigation  ',
        },
      },
      widgetAreas: {
        sidebar: {
          title: '  Sidebar Widgets  ',
          description: '  Right rail widgets  ',
        },
      },
      settings: {
        accent: 'sand',
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
      runtime: '0.5',
      author: 'ZeroPress',
      description: 'Theme fixture',
      features: {
        comments: true,
        newsletter: false,
      },
      menuSlots: {
        primary: {
          title: 'Primary Menu',
          description: 'Main header navigation',
        },
      },
      widgetAreas: {
        sidebar: {
          title: 'Sidebar Widgets',
          description: 'Right rail widgets',
        },
      },
      settings: {
        accent: 'sand',
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
  });
});

test('buildSite rejects theme packages that do not target runtime 0.5', async () => {
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
    /Theme validation failed: theme\.json field 'runtime' must be one of: 0\.5/,
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

test('buildSiteFromThemeDir rejects themes that do not target runtime 0.5', async () => {
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
      /Theme validation failed: theme\.json field 'runtime' must be one of: 0\.5/,
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

test('buildSite runtime 0.5 exposes structured posts, archive groups, and pagination without legacy helpers', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.5';
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
  assert.match(archiveHtml, /<a class="archive-post" href="\/posts\/hello-zeropress\/">Hello ZeroPress<\/a><time datetime="2026-02-14T09:00:00Z">2026-02-14 09:00<\/time>/);
});

test('buildSite applies html-extension permalinks and page path overrides', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  previewData.site.postsPerPage = 1;
  previewData.site.permalinks = {
    output_style: 'html-extension',
    posts: '/posts/:public_id',
    pages: '/:slug/',
    categories: '/topics/:slug/',
    tags: '/labels/:slug/',
  };
  previewData.content.pages[0].path = 'spec/preview-data-v0.5';

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
  assert.equal(paths.has('spec/preview-data-v0.5.html'), true);
  assert.equal(paths.has('topics/general.html'), true);
  assert.equal(paths.has('topics/general/page/2.html'), true);
  assert.equal(paths.has('labels/intro.html'), true);
  assert.equal(paths.has('archive.html'), true);
  assert.equal(paths.has('archive/page/2.html'), true);
  assert.equal(paths.has('page/2.html'), true);

  const indexHtml = getFileContent(files, 'index.html');
  const postHtml = getFileContent(files, 'posts/101.html');
  const pageHtml = getFileContent(files, 'spec/preview-data-v0.5.html');
  const categoryHtml = getFileContent(files, 'topics/general.html');
  const tagHtml = getFileContent(files, 'labels/intro.html');
  const sitemapXml = getFileContent(files, 'sitemap.xml');
  const feedXml = getFileContent(files, 'feed.xml');
  const metaJson = JSON.parse(getFileContent(files, 'meta.json'));

  assert.match(indexHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(indexHtml, /<a href="\/page\/2" class="page-link ">2<\/a>/);
  assert.match(postHtml, /<link rel="canonical" href="https:\/\/example\.com\/posts\/101">/);
  assert.match(postHtml, /<a href="\/topics\/general" class="category-link">General<\/a>/);
  assert.match(postHtml, /<a href="\/labels\/intro" class="tag-link">Intro<\/a>/);
  assert.match(pageHtml, /<link rel="canonical" href="https:\/\/example\.com\/spec\/preview-data-v0\.5">/);
  assert.match(categoryHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(tagHtml, /<a href="\/posts\/101">Hello ZeroPress<\/a>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/posts\/101<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/example\.com\/spec\/preview-data-v0\.5<\/loc>/);
  assert.match(feedXml, /<link>https:\/\/example\.com\/posts\/101<\/link>/);
  assert.equal(metaJson.pages.some((page) => page.url === '/posts/101'), true);
  assert.equal(metaJson.pages.some((page) => page.url === '/spec/preview-data-v0.5'), true);
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

test('buildSite exposes pagination.window for compact page navigation', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  const templatePost = previewData.content.posts[0];

  previewData.site.postsPerPage = 1;
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

test('buildSite runtime 0.5 exposes structured post surroundings without legacy post helpers', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());

  themePackage.metadata.runtime = '0.5';
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
    '_zeropress/comment-policy.json',
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

  previewData.site.mediaBaseUrl = 'https://media.example.com';
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

test('buildSite blanks unresolved relative media fields when site.mediaBaseUrl is missing', async () => {
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

test('buildSite emits a comment policy allowlist manifest for published commentable posts', async () => {
  const writer = new MemoryWriter();
  const previewData = await loadDefaultPreviewData();
  const themePackage = await loadGoldenThemePackage();

  previewData.content.posts[1].allow_comments = false;
  previewData.content.posts[2].status = 'draft';

  await buildSite({
    previewData,
    themePackage,
    writer,
  });

  const commentPolicy = JSON.parse(getFileContent(writer.getFiles(), '_zeropress/comment-policy.json'));
  assert.deepEqual(commentPolicy, {
    version: 1,
    commentable_posts: [101],
  });
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
  const commentPolicy = JSON.parse(getFileContent(writer.getFiles(), '_zeropress/comment-policy.json'));

  assert.equal(postHtml.includes('data-zp-comments'), false);
  assert.deepEqual(commentPolicy, {
    version: 1,
    commentable_posts: [],
  });
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

test('buildSite renders v0.5 raw content and resolves structured post author data from authors', async () => {
  const writer = new MemoryWriter();
  const themePackage = cloneThemePackage(await loadGoldenThemePackage());
  themePackage.templates.set('post', '<article class="post-entry">{{post.author.display_name}}|{{post.author.avatar}}|{{post.comments_enabled}}|{{post.slug}}|{{post.public_id}}|{{post.meta.badge}}|{{post.meta.rank}}|{{post.meta.featured}}|{{post.html}}</article>');
  themePackage.templates.set('page', '<article class="page-entry">{{page.meta.section}}|{{page.meta.order}}|{{page.html}}</article>');

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
