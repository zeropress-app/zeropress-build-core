import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';
import { createObjectPreviewDataSource } from '@zeropress/preview-data-validator';
import { createDiskWorkStore, writePreviewDataChunks, openPreviewDataSource } from '@zeropress/preview-data-validator/node';
import { renderDocumentContent } from '../src/content.js';
import { validateDataImage } from '../src/render/data-uri-images.js';
import { buildSite, buildSiteFromSource, MemoryWriter } from '../src/index.js';
import { loadThemePackageFromDir } from '../src/theme/load-theme-dir.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
// Minimal marker sequence for signature tests, not a full image-decoder test.
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
const images = html => DomUtils.findAll(n => n.name === 'img', parseDocument(html).children);
function render(content, documentType = 'html', allowDataUriImages = true) {
  const reasons = [];
  const html = renderDocumentContent(content, documentType, { allowDataUriImages, onDataUriImageRemoved: reason => reasons.push(reason) });
  return { html, reasons };
}

test('four raster types work in HTML, Markdown and reference images, only when opted in', () => {
  for (const uri of [png, jpeg, gif, webp]) {
    assert.equal(validateDataImage(uri), null);
    for (const [type, source] of [
      ['html', `<img src="${uri}" alt="example" onerror="alert(1)">`],
      ['markdown', `![example](${uri})`],
      ['markdown', `![example][image]\n\n[image]: ${uri}`],
    ]) {
      const enabled = render(source, type);
      assert.equal(images(enabled.html)[0].attribs.src, uri);
      assert.equal(images(enabled.html)[0].attribs.onerror, undefined);
      assert.deepEqual(enabled.reasons, []);
      const disabled = render(source, type, false);
      assert.equal(images(disabled.html)[0].attribs.src, undefined);
      assert.deepEqual(disabled.reasons, ['disabled']);
      assert.equal(renderDocumentContent(source, type), disabled.html);
    }
  }
});

test('invalid base64, mismatched/truncated signatures and unsupported formats are removed', () => {
  const cases = [
    [svg, 'unsupported_format'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'unsupported_format'],
    ['data:image/png,hello', 'unsupported_format'],
    [png.replace(';base64', ';charset=utf-8;base64'), 'unsupported_format'],
    [png + ' ', 'invalid_base64'], [png.slice(0, -1), 'invalid_base64'],
    [png.replace('iVBOR', 'iVB?R'), 'invalid_base64'],
    [png.replace('iVBOR', 'iVB_R'), 'invalid_base64'],
    [png.replaceAll('=', '%3D'), 'invalid_base64'],
    [png.replace('YII=', 'YIJ='), 'invalid_base64'],
    [jpeg.replace('2Q==', '2R=='), 'invalid_base64'],
    ['data:image/png;base64,====', 'invalid_base64'],
    ['data:image/png;base64,', 'invalid_base64'],
    ['data:image/png;base64,iVBORw0KGgo=', 'invalid_image'],
    [png.replace('image/png', 'image/jpeg'), 'invalid_image'],
    [webp.replace('UklGRiIA', 'UklGRiMA'), 'invalid_image'],
  ];
  for (const [uri, reason] of cases) {
    const result = render(`<img src="${uri}" alt="example">`);
    assert.equal(images(result.html)[0].attribs.src, undefined, reason);
    assert.deepEqual(result.reasons, [reason]);
  }
});

test('scheme obfuscations cannot bypass strict data validation', () => {
  for (const prefix of ['da\tta:', ' da\nta:', 'd<!--x-->ata:', 'd<!--:-->ata:', 'd<!<!--x-->--x-->ata:']) {
    const uri = prefix + 'image/svg+xml;base64,PHN2Zy8+';
    const result = render(`<img src="${uri}">`);
    assert.equal(images(result.html)[0].attribs.src, undefined);
  }
  const entity = render(`<img src="&#100;ata:image/png;base64,${png.split(',')[1]}">`);
  assert.equal(images(entity.html)[0].attribs.src, png);
  assert.equal(images(render(`<img src="${png.replace('data:image/png;base64', 'DATA:IMAGE/PNG;BASE64')}">`).html)[0].attribs.src?.startsWith('DATA:'), true);
});

test('mixed srcsets retain safe candidates and do not split a data URL at its comma', () => {
  for (const separator of [' 1x, ', ', ']) {
    const source = `<img src="/safe.png" srcset="${png}${separator}${svg} 2x, /safe.png 3x, javascript:bad 4x">`;
    const result = render(source);
    const img = images(result.html)[0];
    assert.equal(img.attribs.src, '/safe.png');
    assert.ok(img.attribs.srcset.includes(png));
    assert.match(img.attribs.srcset, /\/safe.png 3x/);
    assert.doesNotMatch(img.attribs.srcset, /svg|javascript/);
    assert.deepEqual(result.reasons, ['unsupported_format']);
    assert.equal(render(source, 'html', false).html, renderDocumentContent(source, 'html'));
  }
  const malformed = render(`<img srcset="${png} (1x, 2x), ${svg} 3x, /safe.png 4x">`);
  assert.doesNotMatch(images(malformed.html)[0].attribs.srcset, /data:/);
  assert.equal(images(malformed.html)[0].attribs.srcset, '/safe.png 4x');
});

test('links, iframe/media/source attributes and CSS do not gain data URL permissions', () => {
  const result = render(`<a href="${png}">link</a><iframe src="${png}"></iframe><video src="${png}" poster="${png}"><source src="${png}" srcset="${png} 1x"></video><p style="background:url(${png})">text</p><img src="javascript:alert(1)">`);
  assert.doesNotMatch(result.html, /data:|javascript:|background/);
  assert.deepEqual(result.reasons, []);
});

test('code/plaintext examples and rejected Markdown syntax retain their existing meaning', () => {
  for (const source of [`\`![example](${png})\``, `\`\`\`html\n<img src="${png}">\n\`\`\``, `![example](${svg})`]) {
    const result = render(source, 'markdown');
    assert.equal(images(result.html).length, 0);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.html, renderDocumentContent(source, 'markdown'));
  }
  const result = render(`<img src="${png}">`, 'plaintext');
  assert.equal(images(result.html).length, 0);
  assert.deepEqual(result.reasons, []);
});

test('large payload validation avoids full-image decoding and does not mutate shared defaults', () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  Buffer.from([255, 216, 255]).copy(bytes); bytes[bytes.length - 2] = 255; bytes[bytes.length - 1] = 217;
  const uri = 'data:image/jpeg;base64,' + bytes.toString('base64');
  const original = Buffer.from;
  try {
    Buffer.from = function(value, encoding, ...args) {
      assert.notEqual(encoding, 'base64', 'must not decode the complete image');
      return original(value, encoding, ...args);
    };
    assert.equal(validateDataImage(uri), null);
  } finally { Buffer.from = original; }
  render(`<img src="${png}">`);
  assert.equal(images(renderDocumentContent(`<img src="${png}">`, 'html'))[0].attribs.src, undefined);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-image-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = JSON.parse(await fs.readFile(new URL('./fixtures/default-preview-data.json', import.meta.url)));
  const themePackage = await loadThemePackageFromDir(fileURLToPath(new URL('./fixtures/golden-theme', import.meta.url)));
  return { dir, data, themePackage };
}

test('object/chunk builds agree, warnings aggregate once per body and contain no payload', async t => {
  const { dir, data, themePackage } = await fixture(t);
  const logs = ['log', 'warn', 'error'].map(name => t.mock.method(console, name, () => {}));
  data.content.posts[0].content = `<img src="${png}"><img src="${svg}"><img srcset="${png} 1x, /invalid.png (2x, 3x), /safe.png 4x">`;
  data.content.pages[0].content = `<img src="${png}">`;
  data.site.front_page = { type: 'page', page_path: 'about' };
  data.site.post_index = { enabled: false };
  const before = structuredClone(data);
  const file = path.join(dir, 'data.json');
  await writePreviewDataChunks(createObjectPreviewDataSource(data), file, { targetBytes: 1200 });
  for (const options of [{}, { reportDataUriImages: true }, { allowDataUriImages: true }]) {
    const a = new MemoryWriter(), b = new MemoryWriter();
    const expected = await buildSite({ previewData: data, themePackage, writer: a, options });
    const source = await openPreviewDataSource(file), workStore = await createDiskWorkStore({ directory: dir });
    try {
      const actual = await buildSiteFromSource({ source, workStore, themePackage, writer: b, options });
      assert.deepEqual(actual, expected); assert.deepEqual(b.getFiles(), a.getFiles());
      const warnings = actual.warnings.filter(w => w.code === 'DATA_URI_IMAGES_REMOVED');
      assert.equal(warnings.length, Object.keys(options).length ? 1 : 0);
      if (warnings.length) {
        assert.equal(warnings[0].count, options.allowDataUriImages ? 1 : 4);
        assert.equal(warnings[0].documentCount, options.allowDataUriImages ? 1 : 2);
        assert.doesNotMatch(JSON.stringify(warnings), /iVBOR|PHN2|data:/);
      }
      const search = a.getFiles().find(f => f.path === '_zeropress/search.json').content;
      assert.doesNotMatch(search, /iVBOR|PHN2/);
    } finally { await source.close(); await workStore.close(); }
  }
  assert.deepEqual(data, before);
  for (const logger of logs) assert.equal(logger.mock.callCount(), 0);
});

test('warning samples are bounded and body/structured-media protections still run', async t => {
  const { data, themePackage } = await fixture(t);
  data.content.posts = Array.from({ length: 24 }, (_, i) => ({ ...data.content.posts[0], public_id: i + 1, slug: `image-${i}`, content: `<img src="${png}">` }));
  const result = await buildSite({ previewData: data, themePackage, writer: new MemoryWriter(), options: { reportDataUriImages: true } });
  const warning = result.warnings.find(w => w.code === 'DATA_URI_IMAGES_REMOVED');
  assert.equal(warning.count, 24); assert.equal(warning.documentCount, 24); assert.equal(warning.affected.length, 10);
  const writer = new MemoryWriter();
  await assert.rejects(() => buildSite({ previewData: data, themePackage, writer, options: { allowDataUriImages: true, maxBodyBytes: 32 } }), { code: 'CONTENT_BODY_TOO_LARGE' });
  assert.equal(writer.getFiles().length, 0);
  data.content.posts[0].featured_image = png;
  await assert.rejects(() => buildSite({ previewData: data, themePackage, writer, options: { allowDataUriImages: true } }));
  assert.equal(writer.getFiles().length, 0);
});

test('invalid options fail before source iteration and direct content rendering', async () => {
  for (const value of [null, 0, 'true']) {
    for (const name of ['allowDataUriImages', 'reportDataUriImages']) {
      await assert.rejects(() => buildSiteFromSource({ options: { [name]: value }, source: { records() { assert.fail('read'); } } }), TypeError);
    }
    assert.throws(() => renderDocumentContent('', 'html', { allowDataUriImages: value }), TypeError);
  }
});


test('malformed srcsets never log their URLs or Data URI payloads', (t) => {
  const logs = ['log', 'warn', 'error'].map(name => t.mock.method(console, name, () => {}));
  for (const options of [undefined, { onDataUriImageRemoved() {} }, { allowDataUriImages: true }]) {
    for (const documentType of ['html', 'markdown']) {
      for (const [srcset, expected] of [
        [`${png} (1x, 2x), /safe.png 4x`, '/safe.png 4x'],
        [`${png} 1x, /invalid.png (2x, 3x), /safe.png 4x`, options?.allowDataUriImages ? `${png} 1x, /safe.png 4x` : '/safe.png 4x'],
        [`/invalid.png 1x 2x, ${png} 0w, /safe.png 4x`, '/safe.png 4x'],
      ]) {
        const html = renderDocumentContent(`<img srcset="${srcset}">`, documentType, options);
        assert.equal(images(html)[0].attribs.srcset, expected);
        const media = renderDocumentContent(`<picture><source srcset="${srcset}"><img src="/safe.png"></picture>`, documentType, options);
        const source = DomUtils.findAll(n => n.name === 'source', parseDocument(media).children)[0];
        assert.equal(source.attribs.srcset, '/safe.png 4x');
      }
    }
  }
  for (const logger of logs) assert.equal(logger.mock.callCount(), 0, 'rendering must not write to the console');
});

test('srcset descriptor filtering preserves valid candidates and removes malformed ones silently', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  for (const descriptor of ['', '1x', '0x', '.5x', '1e2x', '640w', '640w 480h', '480h 640w']) {
    const source = `<img srcset="${png} ${descriptor}, /safe.png 4x">`;
    const output = images(render(source).html)[0].attribs.srcset;
    assert.ok(output.includes(png), descriptor);
    assert.match(output, /\/safe.png 4x$/);
  }
  for (const descriptor of ['0w', '0h', '-1x', '+1x', '1.x', '1q', '1x 2x', '2w 3w', '1x 2w', '2w 1x', '1x 2h', '2h 1x', '2h 3h', '(1x, 2x)', '(1x, (2x))', '1x\u00a02x']) {
    assert.equal(images(render(`<img srcset="${png} ${descriptor}, /safe.png 4x">`).html)[0].attribs.srcset, '/safe.png 4x', descriptor);
  }
  assert.equal(images(render(`<img srcset="${png} (1x, 2x">`).html)[0].attribs.srcset, undefined);
  assert.equal(log.mock.callCount(), 0);
});
