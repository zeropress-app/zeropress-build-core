import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex } from '../src/search/build-search-index.js';

const MiB = 1024 * 1024;
const omitted = [{
  id: 'zeropress:search-omitted', type: 'page', title: '', url: '/', excerpt: '',
  headings: [], categories: [], tags: [], published_at_iso: '', updated_at_iso: '', content_text: '',
}];
const record = (content_text = '') => ({
  id: 'post:example', type: 'post', title: 'Example', url: '/posts/example/', excerpt: '',
  headings: [], categories: [], tags: [], published_at_iso: '', updated_at_iso: '', content_text,
});
const encode = (items) => JSON.stringify(items, null, 2) + '\n';
const build = (documents, generateSearchIndex) => buildSearchIndex({
  documents, createItem: (item) => item, generateSearchIndex,
});

function expectSkipped(result, reason, recordCount) {
  assert.equal(result.json, encode(omitted));
  assert.equal(result.warnings.length, 1);
  const { message, ...warning } = result.warnings[0];
  assert.deepEqual(warning, { code: 'NATIVE_SEARCH_INDEX_SKIPPED', reason, recordCount });
  assert.match(message, /Native search will return no results/);
  assert.match(message, /Pagefind/);
}

test('JSON output is byte-identical for all UTF-16 code units, escaped arrays and multiple records', () => {
  const allCodeUnits = Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join('');
  const items = [
    { ...record(allCodeUnits.repeat(12)), headings: ['한글', '🙂', '"\\\n', '\ud800', '\udfff'], tags: ['one', 'two'], categories: ['Example'] },
    record('ending\nline'),
  ];
  const expected = encode(items);
  const result = build(items);
  assert.ok(result.json === expected, 'Output must be byte-identical to JSON.stringify(items, null, 2) + newline');
  assert.ok(Buffer.byteLength(expected) >= 2 * MiB);
  assert.deepEqual(result.warnings.map(({ message, ...rest }) => rest), [{
    code: 'NATIVE_SEARCH_INDEX_LARGE', byteLength: Buffer.byteLength(expected), recordCount: 2,
  }]);
  assert.deepEqual(build(items, true), result);
});

test('2 MiB and 5 MiB boundaries include UTF-8, JSON escaping, indentation and final newline', () => {
  for (const boundary of [2 * MiB, 5 * MiB]) {
    for (const delta of [-1, 0, 1]) {
      const target = boundary + delta;
      const items = [
        { ...record('한글🙂é"\\\b\f\n\r\t\0\u001f\u2028\u2029\ud800!\udfff'), headings: ['First', '두 번째'], tags: ['🙂'], categories: ['Example'] },
        record(),
      ];
      items[1].content_text = 'x'.repeat(target - Buffer.byteLength(encode(items)));
      const expected = encode(items);
      assert.equal(Buffer.byteLength(expected), target);
      const result = build(items);
      if (target >= 5 * MiB) {
        expectSkipped(result, 'size_limit', 2);
      } else {
        assert.ok(result.json === expected, 'Output must be byte-identical to JSON.stringify(items, null, 2) + newline');
        assert.deepEqual(result.warnings.map(({ message, ...rest }) => rest), target >= 2 * MiB ? [{
          code: 'NATIVE_SEARCH_INDEX_LARGE', byteLength: target, recordCount: 2,
        }] : []);
      }
    }
  }
});

test('5000 real records are allowed, and count/requested limits do not build any records', () => {
  const documents = Array.from({ length: 5000 }, (_, index) => index);
  let calls = 0;
  const createItem = (index) => {
    calls += 1;
    return { ...record(), id: `post:example-${index}` };
  };
  const allowed = buildSearchIndex({ documents, createItem });
  assert.equal(JSON.parse(allowed.json).length, 5000);
  assert.equal(calls, 5000);
  assert.deepEqual(allowed.warnings, []);

  const never = () => { throw new Error('Must not extract or serialize skipped records'); };
  const tooMany = [...documents, 5000];
  expectSkipped(buildSearchIndex({ documents: tooMany, createItem: never }), 'record_limit', 5001);
  expectSkipped(buildSearchIndex({ documents: tooMany, createItem: never, generateSearchIndex: false }), 'requested', 5001);
  expectSkipped(buildSearchIndex({ documents: [0], createItem: never, generateSearchIndex: false }), 'requested', 1);
  for (const generateSearchIndex of [undefined, true, false]) {
    assert.deepEqual(buildSearchIndex({ documents: [], createItem: never, generateSearchIndex }), { json: '[]\n', warnings: [] });
  }
});

test('a single oversized string is rejected before JSON serialization, including escape expansion', () => {
  for (const item of [record('x'.repeat(5 * MiB)), record('한'.repeat(2 * MiB)), { ...record(), headings: ['"'.repeat(3 * MiB)] }]) {
    Object.defineProperty(item, 'toJSON', { value() { throw new Error('Oversized record was serialized'); } });
    expectSkipped(build([item]), 'size_limit', 1);
  }
});

test('size limit stops processing later records and discards earlier chunks without a duplicate warning', () => {
  let calls = 0;
  const result = buildSearchIndex({
    documents: [0, 1, 2],
    createItem: () => {
      calls += 1;
      assert.ok(calls <= 2, 'Do not process records after the limit');
      return record('x'.repeat(2.5 * MiB));
    },
  });
  assert.equal(calls, 2);
  expectSkipped(result, 'size_limit', 3);
  assert.equal(Object.hasOwn(result.warnings[0], 'byteLength'), false);
});
