import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('buildSite normalizes long comments URLs without excessive backtracking', () => {
  // Isolate the build so a synchronous regexp regression cannot hang the suite.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { parseDocument, DomUtils } from 'htmlparser2';
    import { buildSiteFromThemeDir, MemoryWriter } from './src/index.js';

    const previewData = JSON.parse(await readFile('test/fixtures/default-preview-data.json', 'utf8'));
    const endpoint = 'https://comments.example.com/a' + '/'.repeat(500_000) + 'b';
    previewData.site.comments.api_base_url = endpoint + '///';
    const writer = new MemoryWriter();
    await buildSiteFromThemeDir({ previewData, themeDir: 'test/fixtures/golden-theme', writer });
    const html = writer.getFiles().find((file) => file.path === 'posts/hello-zeropress/index.html').content;
    const mount = DomUtils.findOne((node) => Object.hasOwn(node.attribs, 'data-zp-comments'), parseDocument(html).children);
    assert.equal(mount.attribs['data-zp-comments-api-base-url'], endpoint);
  `], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
