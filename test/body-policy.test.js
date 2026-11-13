import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createObjectPreviewDataSource } from '@zeropress/preview-data-validator';
import { createDiskWorkStore } from '@zeropress/preview-data-validator/node';
import { buildSite, buildSiteFromSource, MemoryWriter } from '../src/index.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';

for (const bytes of [262143, 262144, 262145, 1048575, 1048576, 1048577]) {
  test(`body preflight preserves object/source parity at ${bytes} bytes`, async t => {
    const data = JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url)));
    const themePackage = await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url)));
    data.content.pages[0].content = '<p>' + 'x'.repeat(bytes - 7) + '</p>';
    data.content.pages[0].discoverability = 'delist';
    data.site.front_page = { type: 'page', page_path: data.content.pages[0].slug };
    data.site.post_index = { enabled: false };
    data.site.search = { enabled: false };
    const workStore = await createDiskWorkStore(); t.after(() => workStore.close());
    const a = new MemoryWriter(), b = new MemoryWriter();
    const object = () => buildSite({ previewData: data, themePackage, writer: a, options: { maxBodyBytes: 1048576 } });
    const source = () => buildSiteFromSource({ source: createObjectPreviewDataSource(data), workStore, themePackage, writer: b, options: { maxBodyBytes: 1048576 } });
    if (bytes > 1048576) {
      await assert.rejects(object, { code: 'CONTENT_BODY_TOO_LARGE' });
      await assert.rejects(source, { code: 'CONTENT_BODY_TOO_LARGE' });
      assert.equal(a.getFiles().length, 0); assert.equal(b.getFiles().length, 0);
    } else {
      const expected = await object(), actual = await source();
      assert.deepEqual(actual, expected); assert.deepEqual(b.getFiles(), a.getFiles());
      const warnings = actual.warnings.filter(w => w.code === 'CONTENT_BODY_LARGE');
      assert.equal(warnings.length, bytes >= 262144 ? 1 : 0);
      if (warnings.length) assert.equal(warnings[0].count, 1);
    }
  });
}

test('default and null maxima preserve larger input through object and source rendering', async t => {
  const data = JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url)));
  const themePackage = await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url)));
  data.site.search = { enabled: false };
  for (const bytes of [4194303, 4194304, 4194305]) {
    data.content.pages[0].content = '<p>' + 'x'.repeat(bytes - 7) + '</p>';
    data.content.pages[0].document_type = 'html';
    const store = await createDiskWorkStore();
    try {
      const a = new MemoryWriter(), b = new MemoryWriter();
      const expected = await buildSite({ previewData: data, themePackage, writer: a });
      const actual = await buildSiteFromSource({ source: createObjectPreviewDataSource(data), workStore: store, themePackage, writer: b, options: { maxBodyBytes: null } });
      assert.deepEqual(actual, expected); assert.deepEqual(b.getFiles(), a.getFiles());
      assert.equal(actual.warnings.find(w => w.code === 'CONTENT_BODY_LARGE').maxBodyBytes, bytes);
      assert.ok(a.getFiles().some(f => f.content.includes(data.content.pages[0].content)));
      const writer = new MemoryWriter();
      const build = () => buildSite({ previewData: data, themePackage, writer, options: { maxBodyBytes: 4194304 } });
      if (bytes > 4194304) {
        await assert.rejects(build, { code: 'CONTENT_BODY_TOO_LARGE' }); assert.equal(writer.getFiles().length, 0);
      } else await build();
    } finally { await store.close(); }
  }
});
test('invalid body options fail before source iteration and work-store writes', async () => {
  const source = { records() { assert.fail('source read'); } }, workStore = { put() { assert.fail('store write'); } };
  for (const maxBodyBytes of [0, -1, 0.5, NaN, Infinity, true, '1', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => buildSite({ options: { maxBodyBytes } }), TypeError);
    await assert.rejects(() => buildSiteFromSource({ source, workStore, options: { maxBodyBytes } }), TypeError);
  }
});
