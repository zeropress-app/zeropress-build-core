# @zeropress/build-core

![npm](https://img.shields.io/npm/v/%40zeropress%2Fbuild-core)
![license](https://img.shields.io/npm/l/%40zeropress%2Fbuild-core)
![node](https://img.shields.io/node/v/%40zeropress%2Fbuild-core)

Shared deterministic rendering core for ZeroPress static output v0.6.

This package is the canonical rendering core for preview-data and theme packages consumed directly by:

- [@zeropress/build](https://www.npmjs.com/package/@zeropress/build)
- [@zeropress/theme](https://www.npmjs.com/package/@zeropress/theme)

Public contract references:

- [Preview Data v0.7 Spec](https://zeropress.dev/reference/preview-data/specs/v0.7/)
- [Preview Data v0.7 Schema](https://schemas.zeropress.dev/preview-data/v0.7/schema.json)
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
- fallback `robots.txt` is emitted when `generateRobotsTxt` is not `false`
- fallback `robots.txt` uses `site.indexing`; `false` emits `Disallow: /`, while missing or `true` emits `Allow: /`
- callers that disable fallback robots because a public `robots.txt` exists should copy that file as-is; sitemap directives in custom robots files are caller/user responsibility
- dotted slug segments such as `v0.6` remain literal in route URLs, canonical URLs, and output filenames
- output planning rejects duplicate public URLs, including clean-host aliases (`page.html` → `/page` and `page/index.html` → `/page/`), content routes shadowed by generated special files, and file/directory path hierarchy conflicts before writing

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

Build-core derives:

- index/archive/category/tag routes
- post list HTML blocks
- pagination HTML
- taxonomy link HTML
- localized fallback `published_at` / `updated_at` values plus unconditional `published_at_iso` / `updated_at_iso` values
- datetime formatting from `site.locale`, `site.timezone`, `site.date_style`, and `site.time_style`
- `reading_time`
- a route-root `comments` discriminated context

Build Core always emits localized fallback datetime strings together with canonical ISO timestamps. Themes may progressively enhance explicitly marked `<time datetime="...">` elements for the visitor's browser locale and timezone, but must preserve the fallback when JavaScript, `Intl`, or ISO parsing is unavailable. Themes that want canonical site-local display should use the fallback without client enhancement.

When `site.comments` is present, Build Core materializes the following defaults before rendering:

- `provider: "zeropress"`
- `per_page: 50`
- `order: "desc"`
- `threading.enabled: true`
- `threading.max_depth: 2`

Trailing slashes are removed from `site.comments.api_base_url`, except when the value is the same-origin root `/`. The normalized configuration remains available as `site.comments`.

Every rendered route receives a top-level `comments` object. Inactive and non-detail routes receive exactly:

```js
{
  comments: {
    enabled: false
  }
}
```

An active post or page detail route receives:

```js
{
  comments: {
    enabled: true,
    target_type: 'post', // or 'page'
    target_public_id: 101,
    provider: 'zeropress', // or 'wordpress'
    api_base_url: 'https://comments.example.com',
    per_page: 50,
    order: 'desc',
    threading: {
      enabled: true,
      max_depth: 2
    },
    request_token: '...'
  }
}
```

The active state requires all of the following:

- the theme declares `features.comments: true`
- `site.comments` is configured
- `site.disallow_comments` is `false`
- the post or page has `allow_comments: true` and a positive `public_id`
- the ZeroPress provider has a non-empty item `comments.request_token`

The theme-facing `request_token` key exists only for the `zeropress` provider. Preview-data items may retain ignored token metadata for `wordpress` or inactive comment states, but Build Core drops it. An active `wordpress` context omits that key entirely. Post/page objects, structured list items, collection items and cursors, adjacent-item summaries, search data, feeds, and non-detail route roots do not receive a copy of the item token. Themes must use the route-root `comments.enabled` discriminator.

The canonical `preview-data v0.7` site contract uses:

- `site.media_origin`
- `site.media_delivery_mode`
- `site.locale`
- `site.timezone`
- `site.date_style`
- `site.time_style`
- `site.disallow_comments`
- `site.comments`
- `site.indexing`
- `site.expose_generator`
- `site.search`

`site.media_origin` is either an empty string or an absolute HTTP(S) origin. Build Core resolves root-relative and relative site favicon/logo, profile-widget avatar, author avatar, Post/Page featured-image, and `content.media[].src` values against that origin, while preserving already-absolute external URLs. SEO image metadata receives the normalized featured image. Responsive `srcset` variants require `media_delivery_mode: "media_domain"` and an exact origin match; paths, credentials, query strings, and fragments are not part of the media-origin contract.

`site.favicon.icon`, `svg`, and `png` form the default favicon set. `icon_dark` is the optional dark color-scheme icon. When both sets exist, Build Core emits the dark icon first with `media="(prefers-color-scheme: dark)"` and marks every default icon link with the light media query. A single available set is emitted without a media condition, and `apple_touch_icon` is always unconditional. An explicit preview-data `site.favicon` object replaces the complete auto-discovered build option instead of merging field by field.

Native search artifacts are emitted only when preview-data does not set `site.search: false` and the active theme declares `features.search: true`. When that effective search state is disabled, search widgets are omitted from resolved widget items while their widget areas and non-search siblings remain available. `search_pagefind.js` is a Pagefind adapter that can replace `search.js` after a post-build Pagefind step.

Optional route templates behave as rendering capabilities, not guaranteed outputs:

- `archive.html`
- `category.html`
- `tag.html`
- `404.html`

If preview-data includes content that could produce archive/category/tag pages but the theme omits the matching optional template, build-core skips those outputs. `404.html` is emitted only when the theme provides its matching template. Special files are derived from emitted outputs rather than raw preview-data alone.

## Build Options

Supported options:

- `assetHashing`
- `favicon`
- `sitemapStylesheetHref`
- `generateFeed`
- `generateRobotsTxt`
- `reservedOutputPaths`
- `writeManifest`

Defaults:

- `assetHashing: true`
- `generateFeed: true`
- `generateRobotsTxt: true`
- `writeManifest: false`

`reservedOutputPaths` is an internal orchestration boundary for callers that already own files in the final output tree, such as a copied public directory. Reserved files are safety-validated and participate in clean-URL alias, exact-path, and file/directory hierarchy collision checks, but Build Core does not write them or include them in `build-manifest.json`.

## License

MIT
