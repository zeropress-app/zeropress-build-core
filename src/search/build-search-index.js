const WARNING_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 5000;

const OMITTED_INDEX_JSON = `${JSON.stringify([{
  id: 'zeropress:search-omitted',
  type: 'page',
  title: '',
  url: '/',
  excerpt: '',
  headings: [],
  categories: [],
  tags: [],
  published_at_iso: '',
  updated_at_iso: '',
  content_text: '',
}], null, 2)}\n`;

// createItem stays lazy: skip/count limits must not extract searchable body text.
export function buildSearchIndex({ documents, createItem, generateSearchIndex = true }) {
  const recordCount = documents.length;
  if (recordCount === 0) return { json: '[]\n', warnings: [] };
  if (generateSearchIndex === false) return skippedIndex('requested', recordCount);
  if (recordCount > MAX_RECORDS) return skippedIndex('record_limit', recordCount);

  const chunks = [];
  // Opening "[\n" and closing "\n]\n", including the final newline.
  let byteLength = 5;
  for (const document of documents) {
    const item = createItem(document);
    const separatorBytes = chunks.length === 0 ? 0 : 2;
    const remaining = MAX_BYTES - byteLength - separatorBytes;
    const itemBytes = measureItemBytes(item, remaining);
    if (itemBytes >= remaining) return skippedIndex('size_limit', recordCount);

    // Only serialize a record after proving it fits. Indentation matches the
    // original JSON.stringify(items, null, 2) output byte for byte.
    chunks.push('  ' + JSON.stringify(item, null, 2).replaceAll('\n', '\n  '));
    byteLength += separatorBytes + itemBytes;
  }

  const warnings = byteLength >= WARNING_BYTES ? [{
    code: 'NATIVE_SEARCH_INDEX_LARGE',
    message: `Native search index is ${byteLength} bytes (${recordCount} searchable records). Consider an external search index such as Pagefind for larger sites.`,
    byteLength,
    recordCount,
  }] : [];
  return { json: `[\n${chunks.join(',\n')}\n]\n`, warnings };
}

function skippedIndex(reason, recordCount) {
  const explanation = {
    requested: 'Native search indexing was skipped by request.',
    record_limit: `Native search indexing was skipped because it exceeds ${MAX_RECORDS} searchable records.`,
    size_limit: 'Native search indexing was skipped because the index reached the 5 MiB size limit.',
  }[reason];
  return {
    json: OMITTED_INDEX_JSON,
    warnings: [{
      code: 'NATIVE_SEARCH_INDEX_SKIPPED',
      message: `${explanation} Native search will return no results (${recordCount} searchable records). Use an external search index such as Pagefind.`,
      reason,
      recordCount,
    }],
  };
}

// Search records contain only strings and arrays of strings. Count the JSON
// representation with two-space indentation, stopping at the remaining budget.
// In particular, never stringify a potentially oversized string to measure it.
function measureItemBytes(item, limit) {
  let bytes = 2; // Indent the record inside the outer array.
  const add = (size) => {
    bytes += size;
    return bytes < limit;
  };
  const string = (value) => {
    // UTF-8 JSON is never shorter than its input's UTF-16 length plus quotes.
    if (value.length + 2 >= limit - bytes || !add(2)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      let size;
      if (code === 0x22 || code === 0x5c) {
        size = 2;
      } else if (code < 0x20) {
        size = [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      } else if (code < 0x80) {
        size = 1;
      } else if (code < 0x800) {
        size = 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        const next = value.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          size = 4;
          index += 1;
        } else {
          size = 6; // Well-formed JSON escapes unpaired UTF-16 surrogates.
        }
      } else {
        size = 3;
      }
      if (!add(size)) return false;
    }
    return true;
  };

  if (!add(2)) return limit; // "{\n"
  const entries = Object.entries(item);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    if (index > 0 && !add(2)) return limit; // ",\n"
    if (!add(4) || !string(key) || !add(2)) return limit; // indent, key, ": "
    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (!add(2)) return limit;
      } else {
        if (!add(2)) return limit; // "[\n"
        for (let entry = 0; entry < value.length; entry += 1) {
          if (entry > 0 && !add(2)) return limit;
          if (!add(6) || !string(value[entry])) return limit;
        }
        if (!add(6)) return limit; // "\n    ]"
      }
    } else if (!string(value)) {
      return limit;
    }
  }
  return add(4) ? bytes : limit; // "\n  }"
}
