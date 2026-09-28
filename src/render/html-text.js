import { parseDocument } from 'htmlparser2';

const NON_VISIBLE_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const TEXT_BOUNDARY_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'aside', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'div', 'nav',
]);

/** Extract plain text with entities decoded once; escape it when rendering HTML. */
export function extractHtmlText(html, { omitLeadingHeading } = {}) {
  const document = parseDocument(String(html || ''), { decodeEntities: true });
  return collectText(document.children, omitLeadingHeading);
}

function collectText(nodes, omitLeadingHeading) {
  const pending = [...nodes].reverse();
  const parts = [];
  let hasVisibleText = false;
  let foundHeading = false;

  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    if (node.type === 'text') {
      parts.push(node.data);
      hasVisibleText ||= node.data.trim() !== '';
      continue;
    }
    if (node.type !== 'tag' || NON_VISIBLE_TAGS.has(node.name)) continue;

    if (node.name === 'h1' && !foundHeading) {
      foundHeading = true;
      if (
        !hasVisibleText
        && omitLeadingHeading !== undefined
        && collectText(node.children).normalize('NFC')
          === normalizeText(String(omitLeadingHeading)).normalize('NFC')
      ) {
        parts.push(' ');
        continue;
      }
    }

    if (TEXT_BOUNDARY_TAGS.has(node.name)) {
      parts.push(' ');
      pending.push(' ');
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
  }

  return normalizeText(parts.join(''));
}

function normalizeText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}
