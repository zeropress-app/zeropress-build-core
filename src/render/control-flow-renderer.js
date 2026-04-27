import { parsePartialToken } from './partial-resolver.js';

const PATH_SEGMENT_SOURCE = '[a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*';
const PATH_REGEX = new RegExp(`^${PATH_SEGMENT_SOURCE}(?:\\.${PATH_SEGMENT_SOURCE})*$`);
const FOR_EXPRESSION_REGEX = new RegExp(`^([a-zA-Z_][a-zA-Z0-9_]*)\\s+in\\s+(${PATH_SEGMENT_SOURCE}(?:\\.${PATH_SEGMENT_SOURCE})*)$`);
const IF_EQ_EXPRESSION_REGEX = new RegExp(`^(${PATH_SEGMENT_SOURCE}(?:\\.${PATH_SEGMENT_SOURCE})*)\\s+("(?:[^"\\\\]|\\\\.)*")$`);

export class ControlFlowRenderer {
  constructor(options = {}) {
    this.resolvePath = typeof options.resolvePath === 'function'
      ? options.resolvePath
      : ((data, path) => path.split('.').reduce((current, segment) => {
        if (current == null || typeof current !== 'object') {
          return undefined;
        }
        return current[segment];
      }, data));
    this.renderText = typeof options.renderText === 'function'
      ? options.renderText
      : ((value) => value);
  }

  render(template, data, renderOptions = {}) {
    return this.renderTemplate(template, data, {
      ...renderOptions,
      partialStack: Array.isArray(renderOptions.partialStack) ? renderOptions.partialStack : [],
    });
  }

  renderTemplate(template, data, renderOptions) {
    const nodes = this.parse(template);
    return this.renderNodes(nodes, data, renderOptions);
  }

  parse(template) {
    const source = String(template || '');
    const { nodes, nextIndex, stopTag } = this.parseNodes(source, 0, new Set());
    if (stopTag) {
      throw new Error(`Unexpected closing tag ${stopTag}`);
    }
    if (nextIndex !== source.length) {
      throw new Error('Unexpected parser termination');
    }
    return nodes;
  }

  parseNodes(source, startIndex, stopTags) {
    const nodes = [];
    let index = startIndex;

    while (index < source.length) {
      const nextDelimiter = source.indexOf('{{', index);
      if (nextDelimiter === -1) {
        nodes.push({ type: 'text', value: source.slice(index) });
        return { nodes, nextIndex: source.length, stopTag: null };
      }

      if (nextDelimiter > index) {
        nodes.push({ type: 'text', value: source.slice(index, nextDelimiter) });
      }

      if (source.startsWith('{{!--', nextDelimiter)) {
        const end = source.indexOf('--}}', nextDelimiter + 5);
        if (end === -1) {
          throw new Error('Unclosed block comment');
        }
        const commentBody = source.slice(nextDelimiter + 5, end);
        if (commentBody.includes('{{!--')) {
          throw new Error('Nested block comments are not allowed');
        }
        index = end + 4;
        continue;
      }

      if (source.startsWith('{{!', nextDelimiter)) {
        const end = source.indexOf('}}', nextDelimiter + 3);
        if (end === -1) {
          throw new Error('Unclosed inline comment');
        }
        index = end + 2;
        continue;
      }

      const tokenEnd = source.indexOf('}}', nextDelimiter + 2);
      if (tokenEnd === -1) {
        throw new Error('Unclosed template tag');
      }

      const rawToken = source.slice(nextDelimiter, tokenEnd + 2);
      const token = source.slice(nextDelimiter + 2, tokenEnd).trim();

      if (token.startsWith('/')) {
        const tagName = token.slice(1).trim();
        if (!stopTags.has(tagName)) {
          throw new Error(`Unexpected closing tag /${tagName}`);
        }
        return { nodes, nextIndex: tokenEnd + 2, stopTag: tagName };
      }

      if (token === '#else') {
        if (!stopTags.has('else')) {
          throw new Error('Unexpected else tag');
        }
        return { nodes, nextIndex: tokenEnd + 2, stopTag: 'else' };
      }

      if (token.startsWith('#else_if_eq ')) {
        if (!stopTags.has('else_if_eq')) {
          throw new Error('Unexpected else_if_eq tag');
        }
        return { nodes, nextIndex: tokenEnd + 2, stopTag: token };
      }

      if (token.startsWith('#else_if ')) {
        if (!stopTags.has('else_if')) {
          throw new Error('Unexpected else_if tag');
        }
        return { nodes, nextIndex: tokenEnd + 2, stopTag: token };
      }

      if (token.startsWith('partial:')) {
        const { name, args } = parsePartialToken(token);
        nodes.push({ type: 'partial', name, args });
        index = tokenEnd + 2;
        continue;
      }

      if (token.startsWith('#if_eq ')) {
        const expression = token.slice('#if_eq '.length).trim();
        const block = this.parseIfEqBlock(source, tokenEnd + 2, expression);
        nodes.push(block.node);
        index = block.nextIndex;
        continue;
      }

      if (token.startsWith('#if ')) {
        const expression = token.slice('#if '.length).trim();
        const block = this.parseIfBlock(source, tokenEnd + 2, expression);
        nodes.push(block.node);
        index = block.nextIndex;
        continue;
      }

      if (token.startsWith('#for ')) {
        const expression = token.slice('#for '.length).trim();
        const match = FOR_EXPRESSION_REGEX.exec(expression);
        if (!match) {
          throw new Error(`Invalid for expression: ${expression}`);
        }
        const [, itemName, path] = match;
        const forResult = this.parseNodes(source, tokenEnd + 2, new Set(['for']));
        if (forResult.stopTag !== 'for') {
          throw new Error('Unclosed for block');
        }
        nodes.push({ type: 'for', itemName, path, body: forResult.nodes });
        index = forResult.nextIndex;
        continue;
      }

      nodes.push({ type: 'text', value: rawToken });
      index = tokenEnd + 2;
    }

    if (stopTags.size > 0) {
      const expected = Array.from(stopTags).join(', ');
      throw new Error(`Missing closing tag for ${expected}`);
    }

    return { nodes, nextIndex: source.length, stopTag: null };
  }

  parseIfBlock(source, startIndex, initialPath) {
    if (!PATH_REGEX.test(initialPath)) {
      throw new Error(`Invalid if expression: ${initialPath}`);
    }

    const branches = [];
    let alternate = [];
    let nextIndex = startIndex;
    let currentPath = initialPath;

    while (true) {
      const branchResult = this.parseNodes(source, nextIndex, new Set(['else', 'else_if', 'if']));
      branches.push({
        path: currentPath,
        consequent: branchResult.nodes,
      });

      if (branchResult.stopTag === 'else') {
        const elseResult = this.parseNodes(source, branchResult.nextIndex, new Set(['if']));
        if (elseResult.stopTag !== 'if') {
          throw new Error('Unclosed if block after else');
        }
        alternate = elseResult.nodes;
        nextIndex = elseResult.nextIndex;
        break;
      }

      if (typeof branchResult.stopTag === 'string' && branchResult.stopTag.startsWith('#else_if ')) {
        currentPath = branchResult.stopTag.slice('#else_if '.length).trim();
        if (!PATH_REGEX.test(currentPath)) {
          throw new Error(`Invalid else_if expression: ${currentPath}`);
        }
        nextIndex = branchResult.nextIndex;
        continue;
      }

      if (branchResult.stopTag === 'if') {
        nextIndex = branchResult.nextIndex;
        break;
      }

      throw new Error('Unclosed if block');
    }

    return {
      node: {
        type: 'if',
        branches,
        alternate,
      },
      nextIndex,
    };
  }

  parseIfEqBlock(source, startIndex, expression) {
    const initialBranch = this.parseIfEqBranchExpression(expression, 'if_eq');
    const branches = [];
    let alternate = [];
    let nextIndex = startIndex;
    let currentBranch = initialBranch;

    while (true) {
      const branchResult = this.parseNodes(source, nextIndex, new Set(['else', 'else_if_eq', 'if_eq']));
      branches.push({
        path: currentBranch.path,
        literal: currentBranch.literal,
        consequent: branchResult.nodes,
      });

      if (branchResult.stopTag === 'else') {
        const elseResult = this.parseNodes(source, branchResult.nextIndex, new Set(['if_eq']));
        if (elseResult.stopTag !== 'if_eq') {
          throw new Error('Unclosed if_eq block after else');
        }
        alternate = elseResult.nodes;
        nextIndex = elseResult.nextIndex;
        break;
      }

      if (typeof branchResult.stopTag === 'string' && branchResult.stopTag.startsWith('#else_if_eq ')) {
        currentBranch = this.parseIfEqBranchExpression(
          branchResult.stopTag.slice('#else_if_eq '.length).trim(),
          'else_if_eq',
        );
        nextIndex = branchResult.nextIndex;
        continue;
      }

      if (branchResult.stopTag === 'if_eq') {
        nextIndex = branchResult.nextIndex;
        break;
      }

      throw new Error('Unclosed if_eq block');
    }

    return {
      node: {
        type: 'if_eq',
        branches,
        alternate,
      },
      nextIndex,
    };
  }

  parseIfEqBranchExpression(expression, tagName) {
    const match = IF_EQ_EXPRESSION_REGEX.exec(expression);
    if (!match) {
      throw new Error(`Invalid ${tagName} expression: ${expression}`);
    }

    const [, path, literalSource] = match;
    return {
      path,
      literal: JSON.parse(literalSource),
    };
  }

  renderNodes(nodes, data, renderOptions) {
    return nodes.map((node) => this.renderNode(node, data, renderOptions)).join('');
  }

  renderNode(node, data, renderOptions) {
    switch (node.type) {
      case 'text':
        return this.renderText(node.value, data, renderOptions);
      case 'if': {
        const branch = node.branches.find((entry) => this.isTruthy(this.resolvePath(data, entry.path)));
        return branch
          ? this.renderNodes(branch.consequent, data, renderOptions)
          : this.renderNodes(node.alternate, data, renderOptions);
      }
      case 'if_eq': {
        const branch = node.branches.find((entry) => this.resolvePath(data, entry.path) === entry.literal);
        return branch
          ? this.renderNodes(branch.consequent, data, renderOptions)
          : this.renderNodes(node.alternate, data, renderOptions);
      }
      case 'for': {
        const items = this.resolvePath(data, node.path);
        if (!Array.isArray(items) || items.length === 0) {
          return '';
        }
        return items
          .map((item, index) => this.renderNodes(node.body, {
            ...data,
            [node.itemName]: item,
            loop: {
              first: index === 0,
              last: index === items.length - 1,
              index,
            },
          }, renderOptions))
          .join('');
      }
      case 'partial':
        return this.renderPartial(node, data, renderOptions);
      default:
        return '';
    }
  }

  renderPartial(node, data, renderOptions) {
    const partials = renderOptions?.partials;
    if (!partials || !partials.has(node.name)) {
      throw new Error(`Partial "${node.name}" not found`);
    }

    const activeStack = Array.isArray(renderOptions?.partialStack) ? renderOptions.partialStack : [];
    if (activeStack.includes(node.name)) {
      const cycle = [...activeStack, node.name].join(' -> ');
      throw new Error(`Circular partial reference detected: ${cycle}`);
    }

    const partialTemplate = String(partials.get(node.name) || '');
    const partialData = {
      ...data,
      partial: { ...node.args },
    };

    return this.renderTemplate(partialTemplate, partialData, {
      ...renderOptions,
      partialStack: [...activeStack, node.name],
    });
  }

  isTruthy(value) {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'string') {
      return value.length > 0;
    }
    return Boolean(value);
  }
}
