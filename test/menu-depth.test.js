import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DomUtils, parseDocument } from 'htmlparser2';
import { buildSite, MemoryWriter } from '../src/index.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';
import { prepareRenderMenus } from '../src/render/menus.js';

const item = (title, children = []) => ({ title, url: '/' + title + '/', target: '_self', children });
const deep = [item('one', [item('two', [item('three', [item('four'), item('four-other', [item('five')])])])])];

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return value;
}

test('render menus keep the boundary, count every omitted descendant, and preserve the input', () => {
  const menus = freeze({
    primary: { name: 'Primary', items: structuredClone(deep) },
    footer: { name: 'Footer', items: structuredClone(deep) },
    untouched: { name: 'Untouched', items: structuredClone(deep) },
    empty: { name: 'Empty', items: [] },
  });
  const original = structuredClone(menus);
  const result = prepareRenderMenus(menus, { primary: { max_depth: 3 }, footer: { max_depth: 1 }, empty: { max_depth: 1 }, missing: { max_depth: 1 } });
  assert.deepEqual(result.menus.primary.items, [item('one', [item('two', [item('three')])])]);
  assert.deepEqual(result.menus.footer.items, [item('one')]);
  assert.deepEqual(result.menus.untouched, original.untouched);
  assert.deepEqual(result.menus.empty.items, []);
  assert.deepEqual(result.warnings.map(({ message, ...rest }) => rest), [
    { code: 'MENU_MAX_DEPTH_EXCEEDED', menuId: 'primary', maxDepth: 3, actualDepth: 5, omittedItems: 3 },
    { code: 'MENU_MAX_DEPTH_EXCEEDED', menuId: 'footer', maxDepth: 1, actualDepth: 5, omittedItems: 5 },
  ]);
  assert.deepEqual(menus, original);
  for (const max_depth of [5, 10, 11, Number.MAX_SAFE_INTEGER, undefined]) {
    const unchanged = prepareRenderMenus(menus, { primary: { max_depth } });
    assert.deepEqual(unchanged.menus, menus);
    assert.deepEqual(unchanged.warnings, []);
  }
});

test('all page contexts and menu helpers use the same clipped tree and return one warning per menu', async () => {
  const themePackage = await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url)));
  const previewData = JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url)));
  previewData.menus.primary.items = structuredClone(deep);
  themePackage.metadata.menu_slots = { primary: { title: 'Primary', max_depth: 3 } };
  themePackage.partials.set('header', `<nav id="direct">
    {{#for item in menus.primary.items}}<a href="{{item.url}}">{{item.title}}</a>
      {{#for child in item.children}}<a href="{{child.url}}">{{child.title}}</a>
        {{#for leaf in child.children}}<a href="{{leaf.url}}">{{leaf.title}}</a>
          {{#for excess in leaf.children}}<a href="{{excess.url}}">{{excess.title}}</a>{{/for}}
        {{/for}}
      {{/for}}
    {{/for}}</nav><nav id="helper">{{menu:primary}}</nav>`);
  const writer = new MemoryWriter();
  const before = structuredClone(previewData);
  freeze(previewData);
  const result = await buildSite({ previewData, themePackage, writer });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].omittedItems, 3);
  const pages = writer.getFiles().filter(file => file.contentType === 'text/html');
  assert.ok(pages.length > 6, 'Exercise index, post, page, taxonomy, archive and 404 routes');
  for (const page of pages) {
    const dom = parseDocument(String(page.content));
    const links = id => DomUtils.getElementsByTagName('a', DomUtils.getElementById(id, dom.children).children).map(node => node.attribs.href);
    assert.deepEqual(links('direct'), ['/one/', '/two/', '/three/'], page.path);
    assert.deepEqual(links('helper'), links('direct'), page.path);
  }
  assert.deepEqual(previewData, before);
  themePackage.metadata.menu_slots.primary.max_depth = 5;
  const unlimited = await buildSite({ previewData, themePackage, writer: new MemoryWriter() });
  assert.deepEqual(unlimited.warnings, []);
});

test('depth clipping does not bypass Preview Data validation for omitted descendants', async () => {
  const themePackage = await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url)));
  themePackage.metadata.menu_slots = { primary: { title: 'Primary', max_depth: 1 } };
  const previewData = JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url)));
  previewData.menus.primary.items = [item('Valid', [{ ...item('Invalid'), url: 'javascript:alert(1)' }])];
  await assert.rejects(() => buildSite({ previewData, themePackage, writer: new MemoryWriter() }), /Invalid preview-data/);
});
