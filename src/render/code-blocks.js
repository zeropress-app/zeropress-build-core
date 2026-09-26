import hljs from 'highlight.js';
import { parseDocument } from 'htmlparser2';

const MAX_HIGHLIGHT_LENGTH = 100_000;
const LANGUAGE_CLASS = /^(?:language|lang)-([a-z\d_+-]+)$/i;

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function languageOf(attributes) {
  for (const token of (attributes?.class || '').split(/\s+/)) {
    const match = LANGUAGE_CLASS.exec(token);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function attributesHtml(attributes) {
  return Object.entries(attributes).map(([name, value]) => (
    ` ${name}="${escapeHtml(value).replace(/"/g, '&quot;')}"`
  )).join('');
}

function codeText(children) {
  const stack = [...children].reverse();
  const parts = [];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'text') parts.push(node.data);
    else if (node.name === 'br') parts.push('\n');
    else if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        stack.push(node.children[index]);
      }
    }
  }
  return parts.join('');
}

function highlight(text, language, autoDetect) {
  if (text.length <= MAX_HIGHLIGHT_LENGTH && !['mermaid', 'none', 'text', 'plaintext'].includes(language)) {
    try {
      const result = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : !language && autoDetect ? hljs.highlightAuto(text).value : null;
      if (result !== null) return result.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    } catch {
      // A highlighting failure must preserve the readable code sample.
    }
  }
  return escapeHtml(text);
}

/** Normalize sanitized code blocks without reserializing unrelated authored HTML. */
export function renderCodeBlocks(html, { autoDetect = false } = {}) {
  if (!/<pre[\s>]/i.test(html)) return html;
  const document = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const stack = [...document.children].reverse();
  const replacements = [];
  while (stack.length) {
    const node = stack.pop();
    if (node.name === 'pre') {
      const code = node.children.find((child) => child.name === 'code');
      const language = languageOf(code?.attribs) || languageOf(node.attribs);
      if (!code && !language) continue;
      const onlyCode = code && node.children.every((child) => (
        child === code || (child.type === 'text' && !child.data.trim())
      ));
      const text = codeText(onlyCode ? code.children : node.children);
      const attributes = { ...(code?.attribs || {}) };
      if (language) {
        attributes.class = [
          ...(attributes.class || '').split(/\s+/).filter((token) => token && !LANGUAGE_CLASS.test(token)),
          `language-${language}`,
        ].join(' ');
      }
      replacements.push({
        start: node.startIndex,
        end: node.endIndex + 1,
        html: `<pre${attributesHtml(node.attribs)}><code${attributesHtml(attributes)}>${highlight(text, language, autoDetect)}</code></pre>`,
      });
      continue;
    }
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
    }
  }
  const parts = [];
  let start = 0;
  for (const replacement of replacements) {
    parts.push(html.slice(start, replacement.start), replacement.html);
    start = replacement.end;
  }
  parts.push(html.slice(start));
  return parts.join('');
}
