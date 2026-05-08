# @zeropress/build-core

![npm](https://img.shields.io/npm/v/%40zeropress%2Fbuild-core)
![license](https://img.shields.io/npm/l/%40zeropress%2Fbuild-core)
![node](https://img.shields.io/node/v/%40zeropress%2Fbuild-core)

Shared build core for ZeroPress.

This package is the deterministic rendering engine used by:

- `zeropress-admin-api-v2`
- [`@zeropress/build`](https://www.npmjs.com/package/@zeropress/build) package

It accepts canonical preview-data plus a validated theme package and produces static HTML artifacts through a writer interface.

`preview-data` stays canonical and data-only. Build-core computes the render-ready route state that themes consume at render time. Actual artifact output is the intersection of:

- renderable preview-data entries
- theme template capability

---

## Install

```bash
npm install @zeropress/build-core
```

---

## Exports

```js
import {
  buildSite,
  buildSiteFromThemeDir,
  MemoryWriter,
  FilesystemWriter,
} from '@zeropress/build-core';
```

---

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
  - `robots.txt`
- writing outputs through a pluggable writer

It does not:

- fetch content from databases or APIs
- package or validate theme directories on its own unless the caller uses `buildSiteFromThemeDir`
- watch files, run a dev server, or perform deployment
- talk to queues, KV, Durable Objects, R2, GitHub, or other infrastructure directly

---

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
- `sitemap.xml` and `feed.xml` are emitted only when `site.url` is a non-empty canonical URL
- `robots.txt` is still emitted when `generateSpecialFiles` is enabled

### `buildSiteFromThemeDir(input)`

Loads a theme directory from disk and renders it using the same core pipeline.

This is useful for local tooling that wants filesystem theme loading but still uses the same deterministic core renderer.

---

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

---

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

As of `preview-data v0.4`, the payload no longer carries `routes` arrays or raw HTML fragments such as `categories_html`.

Build-core now derives:

- index/archive/category/tag routes
- post list HTML blocks
- pagination HTML
- taxonomy link HTML
- formatted `published_at` / `updated_at`
- `reading_time`
- `comments_enabled`

It also emits a comments allowlist artifact:

- `/_zeropress/comment-policy.json`

Comment availability is derived from preview-data policy:

- `site.disallowComments`
- `content.posts[].allow_comments`

The canonical `preview-data v0.4` site contract uses:

- `site.locale`
- `site.timezone`
- `site.disallowComments`

Optional route templates behave as rendering capabilities, not guaranteed outputs:

- `archive.html`
- `category.html`
- `tag.html`
- `404.html`

If preview-data includes content that could produce archive/category/tag pages but the theme omits the matching optional template, build-core skips those outputs. Special files are derived from emitted outputs rather than raw preview-data alone.

---

## Build Options

Supported options:

- `assetHashing`
- `generateSpecialFiles`
- `writeManifest`

These options apply to both full builds and partial renders where relevant.

Defaults:

- `assetHashing: true`
- `generateSpecialFiles: true`
- `writeManifest: false`

---

## Requirements

- Node.js >= 18.18.0
- ESM only

---

## Related

- [@zeropress/preview-data-validator](https://www.npmjs.com/package/@zeropress/preview-data-validator)
- [@zeropress/theme-validator](https://www.npmjs.com/package/@zeropress/theme-validator)
- [@zeropress/theme](https://www.npmjs.com/package/@zeropress/theme)

---

## License

MIT
