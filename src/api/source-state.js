import { createPreviewDataValidationSession, PREVIEW_CONTENT_COLLECTIONS } from '@zeropress/preview-data-validator';
import { assertSourceCollections, assertValidation } from '@zeropress/preview-data-validator/chunks';

const RAW = Symbol('raw document payload');
const STORED = Symbol('prepared document payload');
const PAYLOAD_FIELDS = ['content', 'html', 'toc', 'excerpt', 'meta', 'data'];
const CACHE_BYTES = 32 * 1024 * 1024;

export async function readSourceCatalog(source, workStore) {
  if (!source || typeof source.records !== 'function' || !workStore?.put || !workStore?.get) {
    throw new Error('buildSiteFromSource requires a replayable source and a workStore with put/get');
  }
  assertSourceCollections(source.collections);
  const validation = createPreviewDataValidationSession(source.header);
  assertValidation(validation.headerResult);
  const content = {};
  for (const collection of PREVIEW_CONTENT_COLLECTIONS.filter((key) => source.collections.includes(key))) {
    content[collection] = [];
    for await (const entry of source.records(collection)) {
      if (entry.index !== content[collection].length) throw new Error(`Nonsequential source index: ${collection}`);
      try { assertValidation(validation.add(collection, entry.value)); }
      catch (error) {
        if (entry.location) error.message += ` (${entry.location.file}, record ${entry.location.index})`;
        throw error;
      }
      if (collection === 'posts' || collection === 'pages') {
        const { content: body, excerpt, meta, data, ...fields } = entry.value;
        const payload = { content: body, ...(Object.hasOwn(entry.value, 'excerpt') ? { excerpt } : {}), ...(meta !== undefined ? { meta } : {}), ...(data !== undefined ? { data } : {}) };
        content[collection].push({ ...fields, content: '', ...(collection === 'posts' ? { excerpt: '' } : {}), [RAW]: await workStore.put(payload) });
      } else content[collection].push(entry.value);
    }
  }
  assertValidation(validation.finish());
  return { ...source.header, content };
}

export function createPayloadManager(store) {
  if (!store) return null;
  const cache = new Map();
  let cacheBytes = 0;
  const stats = { peakCacheBytes: 0, preparedRecords: 0 };
  async function payload(reference) {
    if (cache.has(reference)) {
      const entry = cache.get(reference); cache.delete(reference); cache.set(reference, entry);
      return entry.value;
    }
    const value = await store.get(reference);
    // Disk references carry encoded bytes. Unknown host stores are not cached.
    const bytes = reference?.bytes;
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= CACHE_BYTES) {
      while (cacheBytes + bytes > CACHE_BYTES && cache.size) {
        const [key, entry] = cache.entries().next().value; cache.delete(key); cacheBytes -= entry.bytes;
      }
      cache.set(reference, { bytes, value }); cacheBytes += bytes;
      stats.peakCacheBytes = Math.max(stats.peakCacheBytes, cacheBytes);
    }
    return value;
  }
  return {
    stats,
    async raw(record) {
      if (!Object.hasOwn(record, RAW)) return record;
      const restored = { ...record, ...await store.get(record[RAW]) };
      delete restored[RAW];
      return restored;
    },
    async prepare(record) {
      const fields = PAYLOAD_FIELDS.filter((key) => Object.hasOwn(record, key));
      const value = Object.fromEntries(fields.map((key) => [key, record[key]]));
      const ref = await store.put(value);
      const compact = { ...record };
      for (const key of fields) delete compact[key];
      compact[STORED] = { ref, fields };
      stats.preparedRecords++;
      return compact;
    },
    async hydrate(value) {
      // Traverse synchronous metadata without allocating an async continuation
      // for every pagination entry/property. Only stored payloads require I/O.
      const seen = new WeakMap();
      const reads = [];
      function visit(item) {
        if (!item || typeof item !== 'object') return item;
        if (seen.has(item)) return seen.get(item);
        const result = Array.isArray(item) ? [] : {};
        seen.set(item, result);
        for (const key of Object.keys(item)) Object.defineProperty(result, key, {
          value: visit(item[key]), enumerable: true, configurable: true, writable: true,
        });
        const descriptor = item[STORED];
        if (descriptor) reads.push(async () => {
          const restored = await payload(descriptor.ref);
          // Payloads are JSON values, so no private storage pointers live inside them.
          for (const key of descriptor.fields) Object.defineProperty(result, key, {
            value: restored[key], enumerable: true, configurable: true, writable: true,
          });
        });
        return result;
      }
      const result = visit(value);
      // Keep disk reads bounded even when a theme exposes a large collection.
      for (const read of reads) await read();
      return result;
    },
    clear() { cache.clear(); cacheBytes = 0; },
  };
}

export function inheritStoredFields(result, source, fields) {
  if (source[STORED]) result[STORED] = { ref: source[STORED].ref, fields: fields.filter((key) => source[STORED].fields.includes(key)) };
  return result;
}
