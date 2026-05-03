import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import anchor from 'markdown-it-anchor';

const TOC_LEVELS = new Set([2, 3, 4]);
const ALERT_TYPES = new Map([
  ['NOTE', { className: 'note', title: 'Note' }],
  ['TIP', { className: 'tip', title: 'Tip' }],
  ['IMPORTANT', { className: 'important', title: 'Important' }],
  ['WARNING', { className: 'warning', title: 'Warning' }],
  ['CAUTION', { className: 'caution', title: 'Caution' }],
]);

export function renderDocumentContent(content, documentType = 'markdown') {
  return renderDocument(content, documentType).html;
}

export function renderDocument(content, documentType = 'markdown') {
  const normalizedContent = typeof content === 'string' ? content : '';
  const normalizedType = normalizeDocumentType(documentType);

  if (normalizedType === 'plaintext') {
    return {
      html: transformPlaintext(normalizedContent),
      toc: [],
    };
  }

  if (normalizedType === 'html') {
    return {
      html: sanitizeHtml(normalizedContent),
      toc: [],
    };
  }

  return renderMarkdownDocument(normalizedContent);
}

function renderMarkdownDocument(content) {
  const toc = [];
  const markdown = createMarkdownRenderer(toc);

  return {
    html: sanitizeHtml(markdown.render(content)),
    toc,
  };
}

function createMarkdownRenderer(toc) {
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

  markdown.use(markdownTaskLists);
  markdown.use(markdownAlerts);
  markdown.use(anchor, {
    slugify: slugify,
    callback(token, { slug, title }) {
      const level = Number(token.tag.slice(1));
      if (!TOC_LEVELS.has(level)) {
        return;
      }

      toc.push({
        level,
        id: slug,
        title,
        href: `#${slug}`,
      });
    },
  });

  return markdown;
}

function markdownTaskLists(markdown) {
  markdown.core.ruler.after('inline', 'zeropress_task_lists', (state) => {
    const listStack = [];
    const listItemStack = [];

    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];

      if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        listStack.push(index);
        continue;
      }

      if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
        listStack.pop();
        continue;
      }

      if (token.type === 'list_item_open') {
        listItemStack.push({
          index,
          listIndex: listStack[listStack.length - 1],
        });
        continue;
      }

      if (token.type === 'list_item_close') {
        listItemStack.pop();
        continue;
      }

      if (token.type !== 'inline' || listItemStack.length === 0) {
        continue;
      }

      const markerMatch = token.content.match(/^\s*\[([ xX])\](?:\s+|$)/);
      if (!markerMatch) {
        continue;
      }

      const listItem = listItemStack[listItemStack.length - 1];
      const listToken = state.tokens[listItem.listIndex];
      const listItemToken = state.tokens[listItem.index];
      if (!listToken || !listItemToken) {
        continue;
      }

      addTokenClass(listToken, 'contains-task-list');
      addTokenClass(listItemToken, 'task-list-item');

      const checkboxToken = new state.Token('html_inline', '', 0);
      const checked = markerMatch[1].toLowerCase() === 'x' ? ' checked' : '';
      checkboxToken.content = `<input class="task-list-item-checkbox" type="checkbox"${checked} disabled> `;

      const strippedContent = token.content.slice(markerMatch[0].length);
      token.content = strippedContent;
      token.children = [];
      state.md.inline.parse(strippedContent, state.md, state.env, token.children);
      token.children.unshift(checkboxToken);
    }
  });
}

function markdownAlerts(markdown) {
  markdown.core.ruler.after('inline', 'zeropress_alerts', (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== 'blockquote_open') {
        continue;
      }

      const closeIndex = findMatchingBlockquoteClose(state.tokens, index);
      if (closeIndex === -1) {
        continue;
      }

      const firstParagraph = findFirstParagraph(state.tokens, index + 1, closeIndex);
      if (!firstParagraph) {
        continue;
      }

      const inlineToken = state.tokens[firstParagraph.inlineIndex];
      const alert = stripAlertMarker(inlineToken, state);
      if (!alert) {
        continue;
      }

      token.tag = 'aside';
      token.attrSet('class', `zp-alert zp-alert--${alert.className}`);
      token.attrSet('role', 'note');
      state.tokens[closeIndex].tag = 'aside';

      if (inlineToken.content.trim() === '') {
        state.tokens.splice(firstParagraph.openIndex, 3);
      }

      state.tokens.splice(index + 1, 0, ...createAlertTitleTokens(state, alert.title));
      index += 3;
    }
  });
}

function findMatchingBlockquoteClose(tokens, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === 'blockquote_open') {
      depth += 1;
      continue;
    }

    if (tokens[index].type === 'blockquote_close') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findFirstParagraph(tokens, startIndex, endIndex) {
  if (
    startIndex + 2 < endIndex
    && tokens[startIndex].type === 'paragraph_open'
    && tokens[startIndex + 1].type === 'inline'
    && tokens[startIndex + 2].type === 'paragraph_close'
  ) {
    return {
      openIndex: startIndex,
      inlineIndex: startIndex + 1,
      closeIndex: startIndex + 2,
    };
  }

  return null;
}

function stripAlertMarker(inlineToken, state) {
  const markerMatch = inlineToken.content.match(/^\s*\[!([A-Za-z]+)\][ \t]*(?:\n)?/);
  if (!markerMatch) {
    return null;
  }

  const alertType = ALERT_TYPES.get(markerMatch[1].toUpperCase());
  if (!alertType) {
    return null;
  }

  const strippedContent = inlineToken.content.slice(markerMatch[0].length);
  inlineToken.content = strippedContent;
  inlineToken.children = [];
  state.md.inline.parse(strippedContent, state.md, state.env, inlineToken.children);

  return alertType;
}

function createAlertTitleTokens(state, title) {
  const openToken = new state.Token('paragraph_open', 'p', 1);
  openToken.attrSet('class', 'zp-alert__title');

  const inlineToken = new state.Token('inline', '', 0);
  inlineToken.content = title;
  const textToken = new state.Token('text', '', 0);
  textToken.content = title;
  inlineToken.children = [textToken];

  const closeToken = new state.Token('paragraph_close', 'p', -1);

  return [openToken, inlineToken, closeToken];
}

function addTokenClass(token, className) {
  const existingValue = token.attrGet('class') || '';
  const existingClasses = existingValue.split(/\s+/).filter(Boolean);
  if (existingClasses.includes(className)) {
    return;
  }

  token.attrJoin('class', className);
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
    'blockquote', 'aside',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'nav',
    'iframe', 'input',
  ]);

  const allowedAttributes = {
    a: new Set(['href', 'title', 'class', 'id']),
    aside: new Set(['role', 'class', 'id']),
    img: new Set(['src', 'alt', 'title', 'class', 'id', 'width', 'height']),
    iframe: new Set(['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'class']),
    input: new Set(['type', 'checked', 'disabled', 'class', 'id']),
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

        if (normalizedTag === 'input' && attributeName === 'type' && attributeValue !== 'checkbox') {
          continue;
        }

        filteredAttributes.push(`${attributeName}="${attributeValue}"`);
      }
    }

    const isSelfClosing = match.endsWith('/>') || normalizedTag === 'br' || normalizedTag === 'hr' || normalizedTag === 'img' || normalizedTag === 'input';
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
