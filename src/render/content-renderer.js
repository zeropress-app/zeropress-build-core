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
const ADMONITION_CONTAINER_TYPES = new Map([
  ['NOTE', { className: 'note', title: 'Note' }],
  ['INFO', { className: 'note', title: 'Info' }],
  ['TIP', { className: 'tip', title: 'Tip' }],
  ['IMPORTANT', { className: 'important', title: 'Important' }],
  ['WARNING', { className: 'warning', title: 'Warning' }],
  ['CAUTION', { className: 'caution', title: 'Caution' }],
  ['DANGER', { className: 'caution', title: 'Danger' }],
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
    linkify: false,
    typographer: true,
    breaks: false,
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

  markdown.use(markdownAdmonitionContainers);
  markdown.use(markdownTaskLists);
  markdown.use(markdownAlerts);
  markdown.use(markdownTableAlignmentClasses);
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

function markdownAdmonitionContainers(markdown) {
  markdown.block.ruler.before('fence', 'zeropress_admonition_containers', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false;
    }

    const opener = parseAdmonitionContainerOpener(getLineText(state, startLine));
    if (!opener) {
      return false;
    }

    const alert = ADMONITION_CONTAINER_TYPES.get(opener.type.toUpperCase());
    if (!alert) {
      return false;
    }

    const closeLine = findAdmonitionContainerClose(state, startLine + 1, endLine, opener.markerLength);
    if (closeLine === -1) {
      return false;
    }

    if (silent) {
      return true;
    }

    const openToken = state.push('admonition_container_open', 'aside', 1);
    openToken.block = true;
    openToken.markup = opener.markup;
    openToken.map = [startLine, closeLine + 1];
    openToken.attrSet('class', `zp-alert zp-alert--${alert.className}`);
    openToken.attrSet('role', 'note');

    state.tokens.push(...createAlertTitleTokens(state, alert.title));
    state.md.block.tokenize(state, startLine + 1, closeLine);

    const closeToken = state.push('admonition_container_close', 'aside', -1);
    closeToken.block = true;
    closeToken.markup = opener.markup;

    state.line = closeLine + 1;
    return true;
  }, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
}

function getLineText(state, line) {
  const start = state.bMarks[line] + state.tShift[line];
  const end = state.eMarks[line];
  return state.src.slice(start, end);
}

function parseAdmonitionContainerOpener(lineText) {
  const match = /^(:{3,})[ \t]*([A-Za-z][A-Za-z0-9_-]*)(?=$|[ \t[\{])/.exec(lineText);
  if (!match) {
    return null;
  }

  return {
    markup: match[1],
    markerLength: match[1].length,
    type: match[2],
  };
}

function findAdmonitionContainerClose(state, startLine, endLine, markerLength) {
  let fenceMarker = '';
  let fenceLength = 0;

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = getLineText(state, line);

    if (fenceMarker) {
      const fenceClose = new RegExp(`^${escapeRegExp(fenceMarker)}{${fenceLength},}[ \\t]*$`).exec(lineText);
      if (fenceClose) {
        fenceMarker = '';
        fenceLength = 0;
      }
      continue;
    }

    const fenceOpen = /^(`{3,}|~{3,})/.exec(lineText);
    if (fenceOpen) {
      fenceMarker = fenceOpen[1][0];
      fenceLength = fenceOpen[1].length;
      continue;
    }

    const closeMatch = /^(:{3,})[ \t]*$/.exec(lineText);
    if (closeMatch && closeMatch[1].length >= markerLength) {
      return line;
    }
  }

  return -1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markdownTableAlignmentClasses(markdown) {
  for (const tokenName of ['th_open', 'td_open']) {
    markdown.renderer.rules[tokenName] = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const styleIndex = token.attrIndex('style');
      if (styleIndex >= 0) {
        const styleValue = token.attrs[styleIndex][1] || '';
        const match = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*;?\s*$/i.exec(styleValue);
        if (match) {
          token.attrs.splice(styleIndex, 1);
          addTokenClass(token, `zp-align-${match[1].toLowerCase()}`);
        }
      }

      return self.renderToken(tokens, index, options);
    };
  }
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
      const isChecked = markerMatch[1].toLowerCase() === 'x';
      const checked = isChecked ? ' checked' : '';
      const label = isChecked ? 'Completed task' : 'Incomplete task';
      checkboxToken.content = `<input class="task-list-item-checkbox" type="checkbox"${checked} disabled aria-label="${label}"> `;

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

      const titleTokens = createAlertTitleTokens(state, alert.title);
      state.tokens.splice(index + 1, 0, ...titleTokens);
      index += titleTokens.length;
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
  const token = new state.Token('html_block', '', 0);
  token.block = true;
  token.content = `<p class="zp-alert__title">${escapeHtml(title)}</p>`;
  return [token];
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
  const escaped = escapeHtml(content);

  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return '';
  }

  return paragraphs.map((entry) => `<p>${entry}</p>`).join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHtml(html) {
  const allowedTags = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'u', 's', 'code', 'pre',
    'a', 'img',
    'ul', 'ol', 'li',
    'blockquote', 'aside',
    'figure', 'figcaption', 'picture', 'source',
    'video', 'audio', 'track',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'nav',
    'iframe', 'input',
  ]);

  const allowedAttributes = {
    a: new Set(['href', 'title', 'class', 'id', 'target', 'rel']),
    aside: new Set(['role', 'class', 'id']),
    img: new Set(['src', 'srcset', 'sizes', 'alt', 'title', 'class', 'id', 'width', 'height', 'loading', 'decoding']),
    iframe: new Set(['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'class', 'title']),
    input: new Set(['type', 'checked', 'disabled', 'class', 'id', 'aria-label']),
    source: new Set(['src', 'srcset', 'sizes', 'type', 'media', 'width', 'height', 'class', 'id']),
    video: new Set(['src', 'controls', 'controlslist', 'autoplay', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'width', 'height', 'class', 'id', 'title']),
    audio: new Set(['src', 'controls', 'controlslist', 'autoplay', 'loop', 'muted', 'preload', 'class', 'id', 'title']),
    track: new Set(['src', 'kind', 'srclang', 'label', 'default', 'class', 'id']),
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
    let anchorTarget = '';
    let anchorRel = '';

    if (attributeString) {
      const attributePattern = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
      let attributeMatch;

      while ((attributeMatch = attributePattern.exec(attributeString)) !== null) {
        const attributeName = attributeMatch[1].toLowerCase();
        const attributeValue = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';

        if (!tagAllowedAttributes.has(attributeName) && !globalAllowedAttributes.has(attributeName)) {
          continue;
        }

        if ((attributeName === 'href' || attributeName === 'src' || attributeName === 'poster') && !safeUriPattern.test(attributeValue)) {
          continue;
        }

        if (normalizedTag === 'a' && attributeName === 'target') {
          const target = sanitizeAnchorTarget(attributeValue);
          if (!target) {
            continue;
          }
          anchorTarget = target;
          continue;
        }

        if (normalizedTag === 'a' && attributeName === 'rel') {
          const rel = sanitizeRelList(attributeValue);
          if (!rel) {
            continue;
          }
          anchorRel = rel;
          continue;
        }

        if (attributeName === 'srcset' && !isSafeSrcset(attributeValue, safeUriPattern)) {
          continue;
        }

        if (attributeName === 'controlslist') {
          const controlsList = sanitizeControlsList(attributeValue);
          if (!controlsList) {
            continue;
          }
          filteredAttributes.push(`${attributeName}="${controlsList}"`);
          continue;
        }

        if (normalizedTag === 'input' && attributeName === 'type' && attributeValue !== 'checkbox') {
          continue;
        }

        filteredAttributes.push(`${attributeName}="${attributeValue}"`);
      }
    }

    if (normalizedTag === 'a') {
      if (anchorTarget) {
        filteredAttributes.push(`target="${anchorTarget}"`);
      }
      if (anchorTarget === '_blank') {
        anchorRel = ensureBlankTargetRel(anchorRel);
      }
      if (anchorRel) {
        filteredAttributes.push(`rel="${anchorRel}"`);
      }
    }

    const isSelfClosing = match.endsWith('/>') || normalizedTag === 'br' || normalizedTag === 'hr' || normalizedTag === 'img' || normalizedTag === 'input' || normalizedTag === 'source' || normalizedTag === 'track';
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

function sanitizeAnchorTarget(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized === '_blank' ? '_blank' : '';
}

function sanitizeRelList(value) {
  const allowedTokens = new Set(['noopener', 'noreferrer', 'nofollow', 'ugc', 'sponsored', 'external']);
  const tokens = String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter((token, index, allTokens) => (
      allowedTokens.has(token)
      && allTokens.indexOf(token) === index
    ));

  return tokens.join(' ');
}

function ensureBlankTargetRel(value) {
  const tokens = String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  for (const requiredToken of ['noopener', 'noreferrer']) {
    if (!tokens.includes(requiredToken)) {
      tokens.push(requiredToken);
    }
  }

  return tokens.join(' ');
}

function sanitizeControlsList(value) {
  const allowedTokens = new Set(['nodownload', 'nofullscreen', 'noremoteplayback']);
  const tokens = String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter((token, index, allTokens) => (
      allowedTokens.has(token)
      && allTokens.indexOf(token) === index
    ));

  return tokens.join(' ');
}

function isSafeSrcset(value, safeUriPattern) {
  const candidates = String(value)
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  return candidates.length > 0 && candidates.every((candidate) => {
    const [url] = candidate.split(/\s+/);
    return Boolean(url) && safeUriPattern.test(url);
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
