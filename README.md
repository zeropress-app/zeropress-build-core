# @zeropress/build-core

![npm](https://img.shields.io/npm/v/%40zeropress%2Fbuild-core)
![license](https://img.shields.io/npm/l/%40zeropress%2Fbuild-core)
![node](https://img.shields.io/node/v/%40zeropress%2Fbuild-core)

Shared deterministic rendering core for ZeroPress static output v0.6.

This package is the canonical rendering core for preview-data and theme packages consumed directly by:

- [@zeropress/build](https://www.npmjs.com/package/@zeropress/build)
- [@zeropress/theme](https://www.npmjs.com/package/@zeropress/theme)

Public contract references:

- [Preview Data v0.6 Spec](https://zeropress.dev/spec/preview-data-v0.6.html)
- [Preview Data v0.6 Schema](https://schemas.zeropress.dev/preview-data/v0.6/schema.json)
- [Theme Runtime v0.6 Spec](https://zeropress.dev/spec/theme-runtime-v0.6.html)
- [Theme Runtime v0.6 Schema](https://schemas.zeropress.dev/theme-runtime/v0.6/schema.json)

It accepts canonical preview-data plus a validated theme package and produces static HTML artifacts through a writer interface.

`preview-data` stays canonical and data-only. Build-core computes the render-ready route state that themes consume at render time. Actual artifact output is the intersection of:

- renderable preview-data entries
- theme template capability

## Install

```bash
npm install @zeropress/build-core
```

## Exports

```js
import {
  buildSite,
  buildSiteFromThemeDir,
  MemoryWriter,
  FilesystemWriter,
} from '@zeropress/build-core';
```

## Purpose

`@zeropress/build-core` is responsible for:

- validating preview-data input
- validating in-memory theme packages
- computing paginated routes from content data
- computing theme-facing render data such as post lists, taxonomy links, pagination, and formatted timestamps
- rendering route HTML
- processing theme assets
- generating special files such as:
  - `sitemap.xml`
  - `feed.xml`
  - fallback `robots.txt`
  - `/_zeropress/search.json` when native search is enabled
  - `/_zeropress/search.js` when native search is enabled
  - `/_zeropress/search_pagefind.js` when native search is enabled
- writing outputs through a pluggable writer

It does not:

- fetch content from databases or APIs
- package or validate theme directories on its own unless the caller uses `buildSiteFromThemeDir`
- watch files, run a dev server, or perform deployment
- talk to queues, KV, Durable Objects, R2, GitHub, or other infrastructure directly

## Core APIs

### `buildSite(input)`

Renders a full static artifact from preview-data and a theme package.

```js
import { buildSite, MemoryWriter } from '@zeropress/build-core';

const writer = new MemoryWriter();

const result = await buildSite({
  previewData,
  themePackage,
  writer,
  options: {
    writeManifest: true,
  },
});
```

Returns:

```js
{
  files: [
    {
      path: 'index.html',
      contentType: 'text/html',
      size: 1234,
      sha256: '...'
    }
  ],
  manifest: {
    generatedAt: '2026-04-02T00:00:00Z',
    files: [
      {
        path: 'index.html',
        contentType: 'text/html',
        size: 1234,
        sha256: '...'
      }
    ]
  }
}
```

Notes:

- `writer` is required
- `previewData` must already satisfy the canonical preview-data contract
- `themePackage` must already be a validated in-memory theme package
- `sitemap.xml` is emitted only when `site.url` is a non-empty canonical URL
- `feed.xml` is emitted only when `site.url` is a non-empty canonical URL and `generateFeed` is not `false`
- callers may pass `sitemapStylesheetHref` to add an XML stylesheet processing instruction to generated `sitemap.xml`
- fallback `robots.txt` is emitted when `generateSpecialFiles` is enabled and `generateRobotsTxt` is not `false`
- fallback `robots.txt` uses `site.indexing`; `false` emits `Disallow: /`, while missing or `true` emits `Allow: /`
- callers that disable fallback robots because a public `robots.txt` exists should copy that file as-is; sitemap directives in custom robots files are caller/user responsibility

### `buildSiteFromThemeDir(input)`

Loads a theme directory from disk and renders it using the same core pipeline.

This is useful for local tooling that wants filesystem theme loading but still uses the same deterministic core renderer.

## Writers

### `MemoryWriter`

Collects generated files in memory.

Best for:

- tests
- comparisons
- in-process orchestration

### `FilesystemWriter`

Writes generated files to a target directory.

Best for:

- local output generation
- CLI workflows

## Input Contracts

### Preview Data

`previewData` must satisfy the canonical ZeroPress preview-data contract enforced by:

- [`@zeropress/preview-data-validator`](https://www.npmjs.com/package/@zeropress/preview-data-validator)

### Theme Package

`themePackage` must contain:

- `metadata`
- `templates`
- `partials`
- `assets`

Theme validation is enforced through:

- [`@zeropress/theme-validator`](https://www.npmjs.com/package/@zeropress/theme-validator)

`buildSiteFromThemeDir()` is the convenience entry point that loads a theme directory and converts it into the required in-memory `themePackage`.

JavaScript theme assets are emitted as provided. Build-core may hash output filenames, but it does not rewrite or minify JavaScript content.

In `preview-data v0.6`, the payload does not carry `routes` arrays or raw HTML fragments such as `categories_html`.

Build-core derives:

- index/archive/category/tag routes
- post list HTML blocks
- pagination HTML
- taxonomy link HTML
- formatted `published_at` / `updated_at`
- datetime formatting from `site.locale`, `site.timezone`, `site.date_style`, and `site.time_style`
- `reading_time`
- `comments_enabled`

Comment availability is derived from preview-data policy:

- `site.disallow_comments`
- `content.posts[].allow_comments`

The canonical `preview-data v0.6` site contract uses:

- `site.media_base_url`
- `site.media_delivery_mode`
- `site.locale`
- `site.timezone`
- `site.datetime_display`
- `site.date_style`
- `site.time_style`
- `site.disallow_comments`
- `site.indexing`
- `site.expose_generator`
- `site.search`

Native search artifacts are emitted only when preview-data does not set `site.search: false` and the active theme declares `features.search: true`. `search_pagefind.js` is a Pagefind adapter that can replace `search.js` after a post-build Pagefind step.

Optional route templates behave as rendering capabilities, not guaranteed outputs:

- `archive.html`
- `category.html`
- `tag.html`
- `404.html`

If preview-data includes content that could produce archive/category/tag pages but the theme omits the matching optional template, build-core skips those outputs. Special files are derived from emitted outputs rather than raw preview-data alone.

## Build Options

Supported options:

- `assetHashing`
- `favicon`
- `sitemapStylesheetHref`
- `generateSpecialFiles`
- `generateFeed`
- `generateRobotsTxt`
- `writeManifest`

These options apply to both full builds and partial renders where relevant.

Defaults:

- `assetHashing: true`
- `generateSpecialFiles: true`
- `generateFeed: true`
- `generateRobotsTxt: true`
- `writeManifest: false`

## License

MIT
