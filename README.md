# @zeropress/build-core

![npm](https://img.shields.io/npm/v/%40zeropress%2Fbuild-core)
![license](https://img.shields.io/npm/l/%40zeropress%2Fbuild-core)
![node](https://img.shields.io/node/v/%40zeropress%2Fbuild-core)

Shared build and partial-render core for ZeroPress.

This package is the deterministic rendering engine used by:

- `zeropress-admin-api-v2`
- future `@zeropress/build` CLI flows

It accepts canonical preview-data plus a validated theme package and produces static HTML artifacts through a writer interface.

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
  buildSelectedRoutes,
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
- rendering route HTML
- processing theme assets
- generating special files such as:
  - `sitemap.xml`
  - `feed.xml`
  - `robots.txt`
  - `meta.json`
- writing outputs through a pluggable writer

It does not talk to databases, queues, KV, Durable Objects, R2, or deployment infrastructure directly.

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
    generatedAt: '2026-04-02T00:00:00.000Z',
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

### `buildSelectedRoutes(input)`

Renders only selected post and list routes while preserving full-build parity for those outputs.

This is intended for selective publish and other partial-render workflows.

```js
await buildSelectedRoutes({
  previewData,
  themePackage,
  writer,
  selection: {
    posts: ['hello-zeropress'],
    indexRoutes: ['/'],
    archiveRoutes: ['/archive/'],
    categoryRoutes: ['/categories/general/'],
    tagRoutes: ['/tags/intro/'],
    includeAssets: false,
  },
});
```

### `buildSiteFromThemeDir(input)`

Loads a theme directory from disk and renders it using the same core pipeline.

This is useful for local tooling and CLI flows.

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

---

## Build Options

Supported options:

- `assetHashing`
- `generateSpecialFiles`
- `injectHtmx`
- `writeManifest`

These options apply to both full builds and partial renders where relevant.

---

## Requirements

- Node.js >= 18.18.0
- ESM only

---

## Related

- [@zeropress/preview-data-validator](https://www.npmjs.com/package/@zeropress/preview-data-validator)
- [@zeropress/theme-validator](https://www.npmjs.com/package/@zeropress/theme-validator)
- [zeropress-theme](https://www.npmjs.com/package/zeropress-theme)

---

## License

MIT
