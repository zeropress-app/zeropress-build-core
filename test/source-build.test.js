import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createObjectPreviewDataSource } from '@zeropress/preview-data-validator';
import { createDiskWorkStore, writePreviewDataChunks, openPreviewDataSource } from '@zeropress/preview-data-validator/node';
import { buildSite, buildSiteFromSource, MemoryWriter } from '../src/index.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';

async function fixture() {
  return {
    previewData: JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url))),
    themePackage: await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url))),
  };
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-build-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

for (const mode of ['normal', 'skip', 'disabled', 'empty', 'front-page']) {
  test(`chunk source matches object API bytes and warnings: ${mode}`, async (t) => {
    const dir = await setup(t), input = await fixture();
    if (mode === 'disabled') input.previewData.site.search = { enabled: false };
    if (mode === 'empty') { input.previewData.content.posts = []; input.previewData.content.pages = []; }
    else {
      const post = input.previewData.content.posts[0];
      post.excerpt = 'Explicit excerpt 한글 😀';
      post.meta = JSON.parse('{"sample":"meta","__proto__":null}');
      post.data = { flag: false, rows: ['one', 'two'] };
      input.previewData.collections = { chosen: { items: [{ type: 'post', slug: post.slug }, { type: 'page', path: input.previewData.content.pages[0].slug }] } };
      input.themePackage.templates.set('post', '{{post.content}}|{{post.html}}|{{post.excerpt}}|{{post.meta.sample}}|{{post.data.flag}}|{{#for item in collections.chosen.items}}{{item.excerpt}}/{{item.meta.sample}}/{{item.data.flag}};{{/for}}');
    }
    if (mode === 'front-page') { input.previewData.site.front_page = { type: 'page', page_path: input.previewData.content.pages[0].slug }; input.previewData.site.post_index = { enabled: false }; }
    const before = structuredClone(input.previewData);
    const options = { generateSearchIndex: mode !== 'skip' };
    const expectedWriter = new MemoryWriter();
    const expected = await buildSite({ ...input, options, writer: expectedWriter });
    const file = path.join(dir, 'input.json');
    await writePreviewDataChunks(createObjectPreviewDataSource(input.previewData), file, { targetBytes: 1200 });
    const source = await openPreviewDataSource(file), workStore = await createDiskWorkStore({ directory: dir });
    const writer = new MemoryWriter();
    try {
      const actual = await buildSiteFromSource({ source, workStore, themePackage: input.themePackage, options, writer });
      assert.deepEqual(actual, expected);
      assert.deepEqual(writer.getFiles(), expectedWriter.getFiles());
      assert.deepEqual(input.previewData, before);
    } finally { await source.close(); await workStore.close(); }
  });
}

test('source validation failure leaves the writer unused', async (t) => {
  const dir = await setup(t), input = await fixture();
  input.previewData.content.posts[1].slug = input.previewData.content.posts[0].slug;
  const workStore = await createDiskWorkStore({ directory: dir });
  let writes = 0;
  try {
    await assert.rejects(() => buildSiteFromSource({ source: createObjectPreviewDataSource(input.previewData), workStore, themePackage: input.themePackage, writer: { async write() { writes++; } } }), /DUPLICATE_POST_SLUG/);
    assert.equal(writes, 0);
  } finally { await workStore.close(); }
});

test('streamed sitemap matches fallback bytes and reports incomplete writer consumption', async () => {
  const input = await fixture(), expectedWriter = new MemoryWriter();
  const expected = await buildSite({ ...input, writer: expectedWriter });
  const files = [], streamed = [];
  const writer = {
    async write(file) { files.push(file); },
    async writeStream(file) {
      const parts = [];
      for await (const part of file.content) parts.push(part);
      streamed.push({ path: file.path, parts: parts.length });
      files.push({ ...file, content: parts.join('') });
    },
  };
  assert.deepEqual(await buildSite({ ...input, writer }), expected);
  assert.deepEqual(files, expectedWriter.getFiles());
  assert.ok(streamed[0].parts > 2);
  await assert.rejects(() => buildSite({ ...input, writer: { ...writer, async writeStream() {} } }), /did not consume/);
});


for (const collection of ['posts', 'pages']) {
  test(`opaque falsy work-store references preserve ${collection} payloads`, async () => {
    const input = await fixture();
    const record = input.previewData.content[collection][0];
    record.content = '<p>Opaque reference content 한글 😀</p>';
    record.excerpt = 'Explicit excerpt';
    record.meta = { sample: 'opaque metadata' };
    record.data = { flag: false, rows: ['one', 'two'] };
    const type = collection === 'posts' ? 'post' : 'page';
    input.themePackage.templates.set(type, `{{${type}.content}}|{{${type}.html}}|{{${type}.excerpt}}|{{${type}.meta.sample}}|{{${type}.data.flag}}`);
    const before = structuredClone(input.previewData);
    const expectedWriter = new MemoryWriter();
    const expected = await buildSite({ ...input, writer: expectedWriter });
    const target = collection === 'posts' ? 0 : input.previewData.content.posts.length;
    for (const reference of [0, '', false, null, undefined, NaN, 0n]) {
      const values = new Map();
      const workStore = {
        async put(value) {
          const key = values.size === target ? reference : {};
          values.set(key, structuredClone(value));
          return key;
        },
        async get(key) {
          assert.ok(values.has(key), 'restore the exact opaque reference');
          return structuredClone(values.get(key));
        },
      };
      const writer = new MemoryWriter();
      const actual = await buildSiteFromSource({
        source: createObjectPreviewDataSource(input.previewData), workStore,
        themePackage: input.themePackage, writer,
      });
      assert.deepEqual(actual, expected, `reference: ${String(reference)}`);
      assert.deepEqual(writer.getFiles(), expectedWriter.getFiles(), `reference: ${String(reference)}`);
      assert.deepEqual(input.previewData, before);
    }
  });
}
