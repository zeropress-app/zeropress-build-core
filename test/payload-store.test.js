import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayloadManager } from '../src/api/source-state.js';

test('prepared payload cache is bounded and evicted bodies are replayed without changing metadata', async () => {
  const stored = new Map(); let reads = 0, next = 0;
  const store = {
    async put(value) { const ref = { offset: next++, bytes: 16 * 1024 * 1024 }; stored.set(ref,value); return ref; },
    async get(ref) { reads++; return stored.get(ref); },
  };
  const payloads = createPayloadManager(store), rows = [];
  for (let i=0;i<3;i++) rows.push(await payloads.prepare({ title: `Record ${i}`, html: `<p>${i}</p>`, excerpt: '', data: { i } }));
  const originalKeys = rows.map(row=>Object.keys(row));
  assert.equal((await payloads.hydrate(rows[0])).html,'<p>0</p>');
  await payloads.hydrate(rows[1]); await payloads.hydrate(rows[2]);
  assert.ok(payloads.stats.peakCacheBytes <= 32 * 1024 * 1024);
  assert.equal(reads,3);
  assert.equal((await payloads.hydrate(rows[0])).data.i,0);
  assert.equal(reads,4,'Evicted content must be loaded again');
  assert.deepEqual(rows.map(row=>Object.keys(row)),originalKeys);
  payloads.clear();
  await payloads.hydrate(rows[0]); assert.equal(reads,5);
});
