import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite, MemoryWriter } from '../src/index.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';

async function fixture() {
  return {
    previewData: JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url))),
    themePackage: await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url))),
  };
}
async function build(input, options) {
  const writer = new MemoryWriter();
  const result = await buildSite({ ...input, options, writer });
  return { ...result, output: new Map(writer.getFiles().map((file) => [file.path, file.content])) };
}

const indexPath = '_zeropress/search.json';
const adapterPaths = ['_zeropress/search.js', '_zeropress/search_pagefind.js'];

test('explicit omission preserves all other artifacts, effective search state and inputs', async () => {
  const input = await fixture();
  input.themePackage.templates.set('index', '{{#if site.search.enabled}}search enabled{{#else}}search disabled{{/if}}');
  const before = structuredClone(input.previewData);
  const normal = await build(input);
  const explicitTrue = await build(input, { generateSearchIndex: true });
  assert.deepEqual(explicitTrue, normal);
  const skipped = await build(input, { generateSearchIndex: false });
  assert.equal(skipped.warnings.length, 1);
  assert.equal(skipped.warnings[0].recordCount, 4);
  assert.equal(skipped.warnings[0].reason, 'requested');
  assert.match(String(skipped.output.get('index.html')), /search enabled/);
  assert.deepEqual([...skipped.output.keys()], [...normal.output.keys()]);
  for (const [name, content] of normal.output) {
    if (name !== indexPath) assert.deepEqual(skipped.output.get(name), content, name);
  }
  assert.equal(JSON.parse(String(skipped.output.get(indexPath)))[0].id, 'zeropress:search-omitted');
  assert.deepEqual(input.previewData, before);
});

test('search count includes posts, pages and a page front page while excluding drafts and delisted content', async () => {
  const input = await fixture();
  input.previewData.site.front_page = { type: 'page', page_path: 'about' };
  input.previewData.site.post_index = { enabled: false };
  input.previewData.content.posts[0].discoverability = 'delist';
  input.previewData.content.posts[1].status = 'draft';
  input.previewData.content.pages.push({ ...input.previewData.content.pages[0], slug: 'another' });
  const normal = await build(input);
  const items = JSON.parse(String(normal.output.get(indexPath)));
  assert.deepEqual(items.map(({ id }) => id), ['post:archive-patterns', 'page:about', 'page:another']);
  assert.equal(items[1].url, '/');
  const skipped = await build(input, { generateSearchIndex: false });
  assert.equal(skipped.warnings[0].recordCount, items.length);

  input.previewData.content.pages[0].discoverability = 'delist';
  assert.equal((await build(input, { generateSearchIndex: false })).warnings[0].recordCount, 2);
});

test('truly empty and delisted-only sites retain [] with no warning even when indexing is skipped', async () => {
  for (const delisted of [false, true]) {
    const input = await fixture();
    if (delisted) {
      for (const item of [...input.previewData.content.posts, ...input.previewData.content.pages]) item.discoverability = 'delist';
      input.previewData.site.front_page = { type: 'page', page_path: 'about' };
      input.previewData.site.post_index = { enabled: false };
    } else {
      input.previewData.content.posts = [];
      input.previewData.content.pages = [];
    }
    for (const generateSearchIndex of [undefined, false]) {
      const result = await build(input, { generateSearchIndex });
      assert.equal(result.output.get(indexPath), '[]\n');
      assert.deepEqual(result.warnings, []);
      for (const name of adapterPaths) assert.ok(result.output.has(name));
    }
  }
});

test('site and theme search disabling take precedence over the indexing option', async () => {
  for (const disabledBy of ['site', 'theme']) {
    const input = await fixture();
    if (disabledBy === 'site') input.previewData.site.search = { enabled: false };
    else input.themePackage.metadata.features.search = false;
    const result = await build(input, { generateSearchIndex: false });
    for (const name of [indexPath, ...adapterPaths]) assert.equal(result.output.has(name), false);
    assert.deepEqual(result.warnings, []);
  }
});

test('automatic size omission still emits the adapters and succeeds', async () => {
  const input = await fixture();
  input.previewData.content.posts = [input.previewData.content.posts[0]];
  input.previewData.content.posts[0].content = '<p>' + 'x'.repeat(5 * 1024 * 1024) + '</p>';
  input.previewData.content.pages = [];
  const result = await build(input);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].reason, 'size_limit');
  assert.equal(result.warnings[0].recordCount, 1);
  assert.equal(JSON.parse(String(result.output.get(indexPath))).length, 1);
  assert.equal(JSON.parse(String(result.output.get(indexPath)))[0].id, 'zeropress:search-omitted');
  for (const name of adapterPaths) assert.ok(result.output.has(name));
});

test('the unchanged native adapter never matches the sentinel with either tokenizer', async () => {
  const input = await fixture();
  const skipped = await build(input, { generateSearchIndex: false });
  const normal = await build(input);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-search-omitted-'));
  const originalFetch = globalThis.fetch;
  const segmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  const queries = ['', ' ', 'zeropress', 'search', 'omitted', 'zeropress:search-omitted', 'page', '/', 'https://example.com/', '한글', '서울', '日本語', '中文', '123', '0', '*', '.', '-', '_', '"', '🙂', 'alpha beta', 'no results'];
  try {
    const adapter = path.join(root, 'search.mjs');
    await fs.writeFile(adapter, skipped.output.get(adapterPaths[0]));
    for (const fallback of [false, true]) {
      if (fallback) Object.defineProperty(Intl, 'Segmenter', { configurable: true, writable: true, value: undefined });
      for (const [kind, output] of [['skipped', skipped], ['normal', normal]]) {
        const items = JSON.parse(String(output.output.get(indexPath)));
        globalThis.fetch = async () => ({ ok: true, json: async () => items });
        const module = await import(`${pathToFileURL(adapter).href}?kind=${kind}&fallback=${fallback}`);
        await module.preload();
        if (kind === 'skipped') {
          for (const query of queries) assert.deepEqual((await module.search(query)).results, [], query);
        } else {
          assert.ok((await module.search('ZeroPress')).results.length > 0);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (segmenter) Object.defineProperty(Intl, 'Segmenter', segmenter);
    else delete Intl.Segmenter;
    await fs.rm(root, { recursive: true, force: true });
  }
});
