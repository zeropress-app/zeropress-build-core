import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import anchor from 'markdown-it-anchor';

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(value, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(value, { language }).value;
      } catch {
        return value;
      }
    }

    try {
      return hljs.highlightAuto(value).value;
    } catch {
      return value;
    }
  },
});

markdown.use(anchor, {
  permalink: anchor.permalink.headerLink(),
  slugify: slugify,
});

export function renderDocumentContent(content, documentType = 'markdown') {
  const normalizedContent = typeof content === 'string' ? content : '';
  const normalizedType = normalizeDocumentType(documentType);

  if (normalizedType === 'plaintext') {
    return transformPlaintext(normalizedContent);
  }

  if (normalizedType === 'html') {
    return sanitizeHtml(normalizedContent);
  }

  return sanitizeHtml(markdown.render(normalizedContent));
}

function normalizeDocumentType(value) {
  return value === 'plaintext' || value === 'html' ? value : 'markdown';
}

function transformPlaintext(content) {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return '';
  }

  return paragraphs.map((entry) => `<p>${entry}</p>`).join('\n');
}

function sanitizeHtml(html) {
  const allowedTags = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'u', 's', 'code', 'pre',
    'a', 'img',
    'ul', 'ol', 'li',
    'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'nav',
    'iframe',
  ]);

  const allowedAttributes = {
    a: new Set(['href', 'title', 'class', 'id']),
    img: new Set(['src', 'alt', 'title', 'class', 'id', 'width', 'height']),
    iframe: new Set(['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'class']),
    '*': new Set(['class', 'id']),
  };

  const safeUriPattern = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const sanitized = stripped.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g, (match, tag, attributeString) => {
    const normalizedTag = tag.toLowerCase();

    if (match.startsWith('</')) {
      return allowedTags.has(normalizedTag) ? `</${normalizedTag}>` : '';
    }

    if (!allowedTags.has(normalizedTag)) {
      return '';
    }

    const tagAllowedAttributes = allowedAttributes[normalizedTag] || new Set();
    const globalAllowedAttributes = allowedAttributes['*'];
    const filteredAttributes = [];

    if (attributeString) {
      const attributePattern = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
      let attributeMatch;

      while ((attributeMatch = attributePattern.exec(attributeString)) !== null) {
        const attributeName = attributeMatch[1].toLowerCase();
        const attributeValue = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';

        if (!tagAllowedAttributes.has(attributeName) && !globalAllowedAttributes.has(attributeName)) {
          continue;
        }

        if ((attributeName === 'href' || attributeName === 'src') && !safeUriPattern.test(attributeValue)) {
          continue;
        }

        filteredAttributes.push(`${attributeName}="${attributeValue}"`);
      }
    }

    const isSelfClosing = match.endsWith('/>') || normalizedTag === 'br' || normalizedTag === 'hr' || normalizedTag === 'img';
    const attributeSuffix = filteredAttributes.length > 0 ? ` ${filteredAttributes.join(' ')}` : '';
    return isSelfClosing ? `<${normalizedTag}${attributeSuffix} />` : `<${normalizedTag}${attributeSuffix}>`;
  });

  return sanitized
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith('<') && part.endsWith('>')) {
        return part;
      }

      return part.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    })
    .join('');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
