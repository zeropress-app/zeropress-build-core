# @zeropress/build-core

![npm](https://img.shields.io/npm/v/%40zeropress%2Fbuild-core)
![license](https://img.shields.io/npm/l/%40zeropress%2Fbuild-core)
![node](https://img.shields.io/node/v/%40zeropress%2Fbuild-core)

Shared deterministic rendering core for Preview Data v0.7 and Theme Runtime v0.7.

This package is the canonical rendering core for preview-data and theme packages consumed directly by:

- [@zeropress/build](https://www.npmjs.com/package/@zeropress/build)
- [@zeropress/theme](https://www.npmjs.com/package/@zeropress/theme)

Public contract references:

- [Preview Data v0.7 Spec](https://zeropress.dev/reference/preview-data/specs/v0.7/)
- [Preview Data v0.7 Schema](https://schemas.zeropress.dev/preview-data/v0.7/schema.json)
- [Theme Runtime v0.7 Spec](https://zeropress.dev/reference/theme-runtime/specs/v0.7/)
- [Theme Runtime v0.7 Schema](https://schemas.zeropress.dev/theme-runtime/v0.7/schema.json)

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
  ]
}
```

Notes:

- `writer` is required
- `previewData` must already satisfy the canonical preview-data contract
- `themePackage` must already be a validated in-memory theme package
- `sitemap.xml` is emitted only when `site.url` is a non-empty canonical URL
- `feed.xml` is emitted only when `site.feed.enabled` is not `false`, `site.url` is a non-empty canonical URL, and `generateFeed` is not `false`
- callers may pass `sitemapStylesheetHref` to add an XML stylesheet processing instruction to generated `sitemap.xml`
- fallback `robots.txt` is emitted when `generateRobotsTxt` is not `false`
- fallback `robots.txt` uses the effective `site.robots.allow_indexing` policy; omitted Preview Data defaults to `true`, `false` emits `Disallow: /`, and `true` emits `Allow: /`
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

Theme packages use fixed safety limits shared with `@zeropress/theme-validator`: at most 128 entries, 1 MiB per file, and 4 MiB in total expanded content. `buildSiteFromThemeDir()` checks filesystem sizes before reading file bodies, while `buildSite()` validates the same limits for an already-loaded in-memory package. Packaged ZIP input is handled by `@zeropress/theme`, which additionally limits the archive itself to 2 MiB.

JavaScript theme assets are emitted as provided. Build-core may hash output filenames, but it does not rewrite or minify JavaScript content.

User-defined scalar metadata under `site.meta`, `post.meta`, `page.meta`, and item `meta` is always HTML-escaped during template interpolation. Names ending in `_html` or `_url` do not opt metadata into raw rendering; use the explicit content and custom HTML contracts for trusted raw markup.

Build-core derives:

- index/archive/category/tag routes
- post list HTML blocks
- pagination HTML
- taxonomy link HTML
- localized fallback `published_at` / `updated_at` values plus unconditional `published_at_iso` / `updated_at_iso` values
- datetime formatting from `site.locale`, `site.timezone`, `site.date_style`, and `site.time_style`
- `reading_time`
- a route-root `comments` discriminated context

Every ordinary rendered route receives effective feature state on `site`, regardless of whether the corresponding Preview Data preference was omitted:

```js
{
  search: { enabled: true },
  feed: { enabled: true, url: '/feed.xml' },
  archive: { enabled: true, url: '/archive/' },
  comments: {
    enabled: true,
    provider: 'zeropress',
    api_base_url: 'https://comments.example.com',
    per_page: 50,
    order: 'desc',
    threading: { enabled: true, max_depth: 2 }
  }
}
```

Disabled states are exactly `{ enabled: false }`. Search combines the Preview Data request with `theme.json.features.search`. Feed additionally requires a canonical `site.url` and is hard-disabled by `generateFeed: false`. Archive additionally requires `archive.html`; its URL is `/archive/` for directory output and `/archive` for html-extension output. Comments additionally require `theme.json.features.comments`. `site.post_index.enabled` and `site.post_index.paginate` are also effective values after applying `theme.json.features.post_index` and route generation.

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
- `site.comments` is configured with `enabled: true`
- the post or page has `allow_comments: true` and a positive `public_id`
- the ZeroPress provider has a non-empty item `comments.request_token`

Post and Page `allow_comments` are optional Preview Data fields. Omission is
normalized to `false`; producers should emit `true` only for items that opt in
to comments.

The theme-facing `request_token` key exists only for the `zeropress` provider. Preview-data items may retain ignored token metadata for `wordpress` or inactive comment states, but Build Core drops it. An active `wordpress` context omits that key entirely. Post/page objects, structured list items, collection items and cursors, adjacent-item summaries, search data, feeds, and non-detail route roots do not receive a copy of the item token. Themes must use the route-root `comments.enabled` discriminator.

The canonical `preview-data v0.7` site contract uses:

- `site.media_origin`
- `site.media_delivery_mode`
- `site.locale`
- `site.timezone`
- `site.date_style`
- `site.time_style`
- `site.feed`
- `site.archive`
- `site.comments`
- `site.robots`
- `site.expose_generator`
- `site.search`

Post objects use `public_id` as their public numeric identity. The removed internal `content.posts[].id` field is neither required nor exposed to the theme runtime.

`site.url` is either an empty string or a credential-free HTTP(S) origin. A trailing root slash is accepted and normalized to `URL.origin`; credentials, paths, queries, and fragments are invalid. Menu and newsletter navigation URLs must be safe single-slash root-relative paths or credential-free HTTP(S) URLs. Query and fragment are allowed, while bare/dot-relative paths, protocol-relative URLs, path dot segments, backslashes, whitespace/control characters, and malformed percent escapes are invalid.

`site.media_origin` is either an empty string or an absolute HTTP(S) origin. Media fields accept only safe single-slash root-relative paths with a real path or credential-free HTTP(S) URLs with a path; `/`, bare paths, and dot-relative paths are invalid. Build Core resolves root-relative site favicon/logo, profile-widget avatar, author avatar, Post/Page featured-image, and `content.media[].src` values against that origin, while preserving already-absolute external URLs. SEO image metadata receives the normalized featured image. Responsive `srcset` variants require `media_delivery_mode: "media_domain"`, a non-empty origin, and an exact origin match; paths, credentials, query strings, and fragments are not part of the media-origin contract.

Locale and time zone are canonicalized once at build start. Locale uses canonical BCP 47. Time zone accepts `UTC`, canonical IANA identifiers, or canonical fixed offsets within `±14:00`; zero offset becomes `UTC`. The same values drive fallback date strings, archives, date-based permalinks, feeds, and rendered metadata.

When routing fields are omitted, Build Core uses directory output, `/posts/:slug/`, `/:slug/`, `/categories/:slug/`, and `/tags/:slug/`; `front_page` defaults to `theme_index`; and `post_index` defaults to `{ enabled: true, path: "/", paginate: true }`. Page objects retain a leaf `slug`, but external identity uses the NFC-normalized effective route path. Page front-page references use `page_path`, Page collection references use `path`, and different Page paths may share the same leaf slug.

`site.favicon.icon`, `svg`, and `png` form the default favicon set. `icon_dark` is the optional dark color-scheme icon. When both sets exist, Build Core emits the dark icon first with `media="(prefers-color-scheme: dark)"` and marks every default icon link with the light media query. A single available set is emitted without a media condition, and `apple_touch_icon` is always unconditional. An explicit preview-data `site.favicon` object replaces the complete auto-discovered build option instead of merging field by field.

### Custom HTML

Preview Data v0.7 carries optional trusted site-level HTML as flat raw strings:

```json
{
  "custom_html": {
    "head_end": "<meta name=\"example\" content=\"value\">",
    "body_end": "<script src=\"/assets/example.js\"></script>"
  }
}
```

Each configured slot must be nonblank and is limited to 65,536 Unicode code points. Build Core preserves the string without trimming, escaping, sanitizing, or interpreting it.

For ordinary theme-rendered HTML routes, site customization order is deterministic:

1. favicon links
2. ZeroPress generator metadata, unless disabled
3. the generated custom CSS link
4. `custom_html.head_end`
5. `custom_html.body_end`

Closing `</head>` and `</body>` tags are matched case-insensitively. If a configured custom HTML slot has no matching closing tag, the build fails with the route, output path, missing tag, and remediation guidance instead of silently dropping the configured content. Themes that consume these slots must render the corresponding closing tag. A `site.front_page.type: "standalone_html"` document remains byte-for-byte independent and does not receive favicon, generator, custom CSS, or custom HTML injection.

Native search artifacts are emitted only when preview-data does not set `site.search.enabled: false` and the active theme declares `features.search: true`. When that effective search state is disabled, search widgets are omitted from resolved widget items while their widget areas and non-search siblings remain available. `search_pagefind.js` is a Pagefind adapter that can replace `search.js` after a post-build Pagefind step.

When archive is disabled or `archive.html` is missing, archive routes and archive widget items are omitted while authored menu items, widget areas, and non-archive siblings remain unchanged. No archive output path is claimed in that state, so content may use `/archive`. Feed behaves the same way for `feed.xml`: a disabled feed neither emits nor claims the file. Enabled feeds add one RSS autodiscovery link to `meta.head_tags` on ordinary theme-rendered routes; `404.html` and standalone front-page HTML do not receive it.

Optional route templates behave as rendering capabilities, not guaranteed outputs:

- `archive.html`
- `category.html`
- `tag.html`
- `404.html`

If preview-data includes content that could produce archive/category/tag pages but the theme omits the matching optional template, build-core skips those outputs. `404.html` is emitted only when the theme provides its matching template. Special files are derived from emitted outputs rather than raw preview-data alone.

Generated `404.html` uses the document title `Page Not Found - <site title>` and always includes `robots: noindex`. It omits description, canonical, Open Graph, and article metadata because a static error document is not a canonical or shareable content route. Build-core writes the artifact only; the development server or deployment host remains responsible for serving it with HTTP status `404` for missing URLs.

## Build Options

Supported options:

- `assetHashing`
- `favicon`
- `sitemapStylesheetHref`
- `generateFeed`
- `generateRobotsTxt`
- `reservedOutputPaths`

Defaults:

- `assetHashing: true`
- `generateFeed: true`
- `generateRobotsTxt: true`

`reservedOutputPaths` is an internal orchestration boundary for callers that already own files in the final output tree, such as a copied public directory. Reserved files are safety-validated and participate in clean-URL alias, exact-path, and file/directory hierarchy collision checks, but Build Core does not write them or include them in the returned file summaries.

## License

MIT
