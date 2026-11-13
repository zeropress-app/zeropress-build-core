// This policy applies only to body <img> URLs, never arbitrary data: resources.
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SPACE = /[\t\n\f\r ]/;

export function assertDataUriOptions(options = {}) {
  for (const name of ['allowDataUriImages', 'reportDataUriImages']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw new TypeError(`${name} must be a boolean`);
    }
  }
}

function isDataUri(value) {
  // The common case does not copy the payload. Unusual URLs use the same
  // normalization as the sanitizer; a colon can itself occur inside a comment.
  if (/^data:/i.test(value)) return true;
  let prefix = value.replace(/[\x00-\x20]+/g, '');
  for (;;) {
    const start = prefix.indexOf('<!--');
    const end = start < 0 ? -1 : prefix.indexOf('-->', start + 4);
    if (end < 0) break;
    prefix = prefix.slice(0, start) + prefix.slice(end + 3);
  }
  return /^data:/i.test(prefix);
}

export function validateDataImage(value) {
  const header = /^data:image\/(png|jpeg|gif|webp);base64,/i.exec(value);
  if (!header) return 'unsupported_format';
  const start = header[0].length;
  const length = value.length - start;
  if (!length || length % 4 !== 0) return 'invalid_base64';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  // A linear scan avoids decoding or re-encoding the complete image. In
  // particular, permissive base64 decoders must not silently discard input.
  for (let i = start; i < value.length - padding; i++) {
    if (BASE64.indexOf(value[i]) < 0) return 'invalid_base64';
  }
  const last = BASE64.indexOf(value[value.length - padding - 1]);
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) return 'invalid_base64';
  const bytes = length / 4 * 3 - padding;
  const byte = (index) => {
    const at = start + Math.floor(index / 3) * 4;
    const shift = index % 3;
    const a = BASE64.indexOf(value[at + shift]);
    const b = BASE64.indexOf(value[at + shift + 1]);
    return ((a << (2 + shift * 2)) | (b >> (4 - shift * 2))) & 255;
  };
  const matches = (at, signature) => signature.every((value, i) => byte(at + i) === value);
  const ascii = (at, text) => matches(at, Array.from(text, c => c.charCodeAt(0)));
  const u32le = at => byte(at) + byte(at + 1) * 256 + byte(at + 2) * 65536 + byte(at + 3) * 16777216;
  let valid = false;
  switch (header[1].toLowerCase()) {
    case 'png':
      valid = bytes >= 45 && matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
        && matches(8, [0, 0, 0, 13]) && ascii(12, 'IHDR')
        && matches(bytes - 12, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
      break;
    case 'jpeg':
      valid = bytes >= 4 && matches(0, [255, 216, 255]) && matches(bytes - 2, [255, 217]);
      break;
    case 'gif':
      valid = bytes >= 14 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) && byte(bytes - 1) === 59;
      break;
    case 'webp':
      valid = bytes >= 20 && ascii(0, 'RIFF') && u32le(4) === bytes - 8 && ascii(8, 'WEBP')
        && (ascii(12, 'VP8 ') || ascii(12, 'VP8L') || ascii(12, 'VP8X'))
        && u32le(16) > 0 && u32le(16) <= bytes - 20;
      break;
  }
  return valid ? null : 'invalid_image';
}

// Match the descriptor forms accepted by sanitize-html's srcset parser. Reject
// malformed candidates here because that parser logs the entire attribute on
// failure, potentially exposing embedded image data. Scheme checks and valid
// candidate serialization still belong to the sanitizer.
function validSrcsetDescriptors(value) {
  let width, density, height;
  for (const descriptor of value.split(/[\t\n\f\r ]+/).filter(Boolean)) {
    const suffix = descriptor.slice(-1);
    const number = descriptor.slice(0, -1);
    if ((suffix === 'w' || suffix === 'h') && /^\d+$/.test(number)) {
      const size = Number(number);
      if (!size || density || (suffix === 'w' ? width : height)) return false;
      if (suffix === 'w') width = size;
      else height = size;
    } else if (suffix === 'x' && /^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(number)) {
      const size = Number(number);
      // Preserve the existing parser's treatment of zero density as absent.
      if (size < 0 || width || density || height) return false;
      density = size;
    } else return false;
  }
  return true;
}

// Preserve candidate boundaries, including commas inside data URLs and parens.
function filterSrcset(value, keep) {
  const candidates = [];
  let pos = 0;
  while (pos < value.length) {
    while (pos < value.length && (SPACE.test(value[pos]) || value[pos] === ',')) pos++;
    const start = pos;
    while (pos < value.length && !SPACE.test(value[pos])) pos++;
    let end = pos;
    while (end > start && value[end - 1] === ',') end--;
    const url = value.slice(start, end);
    let descriptors = '';
    if (end === pos) {
      let parentheses = false;
      while (pos < value.length) {
        const char = value[pos++];
        if (char === ')' && parentheses) parentheses = false;
        else if (char === '(') parentheses = true;
        else if (char === ',' && !parentheses) break;
      }
      descriptors = value.slice(end, pos).replace(/,$/, '');
    }
    if (url && keep(url) && validSrcsetDescriptors(descriptors)) candidates.push(value.slice(start, pos).replace(/,+$/, ''));
  }
  return candidates.join(', ');
}

export function dataImageSanitizerOptions(base, options) {
  const allow = options.allowDataUriImages === true;
  const report = options.onDataUriImageRemoved;
  const keep = value => {
    if (!isDataUri(value)) return true;
    const reason = allow ? validateDataImage(value) : 'disabled';
    if (!reason) return true;
    report?.(reason);
    return false;
  };
  return {
    ...base,
    // Even with this tag-specific scheme allowance, every data URL must pass
    // the transform first. No other tag gains a data: scheme allowance.
    allowedSchemesByTag: { ...base.allowedSchemesByTag, ...(allow ? { img: ['http', 'https', 'data'] } : {}) },
    transformTags: {
      ...base.transformTags,
      img(tagName, attributes) {
        const attribs = { ...attributes };
        if (attribs.src && !keep(attribs.src)) delete attribs.src;
        if (attribs.srcset) {
          const filtered = filterSrcset(attribs.srcset, keep);
          if (filtered) attribs.srcset = filtered;
          else delete attribs.srcset;
        }
        return { tagName, attribs };
      },
      source(tagName, attributes) {
        const attribs = { ...attributes };
        if (attribs.srcset) {
          // <source> keeps its existing scheme policy; only suppress malformed
          // candidates so the dependency cannot log their payloads either.
          const filtered = filterSrcset(attribs.srcset, () => true);
          if (filtered) attribs.srcset = filtered;
          else delete attribs.srcset;
        }
        return { tagName, attribs };
      },
    },
  };
}

export function createDataImageWarningCollector(options) {
  const enabled = options.reportDataUriImages ?? options.allowDataUriImages ?? false;
  let count = 0;
  const reasons = {};
  const affected = [];
  let documentCount = 0;
  return {
    forDocument(collection, record) {
      let recorded = false;
      return {
        allowDataUriImages: options.allowDataUriImages,
        ...(enabled ? { onDataUriImageRemoved(reason) {
          count++;
          reasons[reason] = (reasons[reason] || 0) + 1;
          if (!recorded) {
            recorded = true;
            documentCount++;
            // Only stable numeric IDs are retained, never content or URLs.
            if (affected.length < 10) affected.push({ collection, ...(record.public_id === undefined ? {} : { publicId: record.public_id }) });
          }
        } } : {}),
      };
    },
    warnings() {
      return count ? [{
        code: 'DATA_URI_IMAGES_REMOVED', count, documentCount, reasons, affected,
        message: `Removed ${count} body image URL(s) from ${documentCount} document(s): ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(', ')}. `
          + (options.allowDataUriImages ? 'Use valid PNG, JPEG, GIF or WebP Base64 images, or external image files.' : 'Use external image files, or opt in with --allow-data-uri-images for validated PNG, JPEG, GIF and WebP Base64 images.'),
      }] : [];
    },
  };
}
