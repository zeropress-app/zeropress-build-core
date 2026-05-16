import { parsePartialToken } from './partial-resolver.js';

const PATH_SEGMENT_SOURCE = '[a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*';
const PATH_REGEX = new RegExp(`^${PATH_SEGMENT_SOURCE}(?:\\.${PATH_SEGMENT_SOURCE})*$`);
const FOR_EXPRESSION_REGEX = new RegExp(`^([a-zA-Z_][a-zA-Z0-9_]*)\\s+in\\s+(${PATH_SEGMENT_SOURCE}(?:\\.${PATH_SEGMENT_SOURCE})*)$`);
const NUMBER_LITERAL_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COMPARISON_BLOCK_TAGS = new Set(['if_eq', 'if_neq', 'if_in', 'if_starts_with']);
const COMPARISON_ELSE_IF_TAGS = new Set(['else_if_eq', 'else_if_neq', 'else_if_in', 'else_if_starts_with']);
const COMPARISON_TAG_OPERATORS = {
  if_eq: 'eq',
  else_if_eq: 'eq',
  if_neq: 'neq',
  else_if_neq: 'neq',
  if_in: 'in',
  else_if_in: 'in',
  if_starts_with: 'starts_with',
  else_if_starts_with: 'starts_with',
};
const PARTIAL_ARG_ROOT_PATHS = new Set([
  'archive',
  'author',
  'category',
  'collection',
  'collections',
  'currentUrl',
  'language',
  'menu',
  'menus',
  'meta',
  'page',
  'pagination',
  'partial',
  'post',
  'posts',
  'route',
  'site',
  'tag',
  'taxonomies',
  'taxonomy',
  'widget',
  'widgets',
]);

function getComparisonBlockTag(token) {
  for (const tagName of COMPARISON_BLOCK_TAGS) {
    if (token.startsWith(`#${tagName} `)) {
      return tagName;
    }
  }
  return '';
}

function getComparisonElseIfTag(token) {
  for (const tagName of COMPARISON_ELSE_IF_TAGS) {
    if (token.startsWith(`#${tagName} `)) {
      return tagName;
    }
  }
  return '';
}

function tokenizeExpression(expression) {
  const tokens = [];
  let index = 0;

  while (index < expression.length) {
    while (/\s/.test(expression[index] || '')) {
      index += 1;
    }
    if (index >= expression.length) {
      break;
    }

    if (expression[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < expression.length) {
        const char = expression[index];
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          index += 1;
          tokens.push(expression.slice(start, index));
          break;
        }
        index += 1;
      }
      if (tokens[tokens.length - 1] !== expression.slice(start, index)) {
        throw new Error(`Unclosed string literal in expression: ${expression}`);
      }
      continue;
    }

    const start = index;
    while (index < expression.length && !/\s/.test(expression[index])) {
      index += 1;
    }
    tokens.push(expression.slice(start, index));
  }

  return tokens;
}

function parsePathOperand(token, tagName, expression) {
  if (!PATH_REGEX.test(token)) {
    throw new Error(`Invalid ${tagName} expression: ${expression}`);
  }
  return { kind: 'path', path: token };
}

function parseComparisonOperand(token, tagName, expression) {
  if (token.startsWith('"')) {
    try {
      const value = JSON.parse(token);
      if (typeof value !== 'string') {
        throw new Error('Expected string literal');
      }
      return { kind: 'literal', value };
    } catch {
      throw new Error(`Invalid ${tagName} expression: ${expression}`);
    }
  }

  if (token === 'true') {
    return { kind: 'literal', value: true };
  }
  if (token === 'false') {
    return { kind: 'literal', value: false };
  }
  if (token === 'null') {
    return { kind: 'literal', value: null };
  }
  if (NUMBER_LITERAL_REGEX.test(token)) {
    return { kind: 'literal', value: Number(token) };
  }
  if (PATH_REGEX.test(token)) {
    return { kind: 'path', path: token };
  }

  throw new Error(`Invalid ${tagName} expression: ${expression}`);
}

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
    const { nodes, nextIndex, stopTag } = this.parseNodes(source, 0, new Set(), PARTIAL_ARG_ROOT_PATHS);
    if (stopTag) {
      throw new Error(`Unexpected closing tag ${stopTag}`);
    }
    if (nextIndex !== source.length) {
      throw new Error('Unexpected parser termination');
    }
    return nodes;
  }

  parseNodes(source, startIndex, stopTags, partialArgScope) {
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

      const comparisonElseIfTag = getComparisonElseIfTag(token);
      if (comparisonElseIfTag) {
        if (!stopTags.has(comparisonElseIfTag)) {
          throw new Error(`Unexpected ${comparisonElseIfTag} tag`);
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
        const { name, args } = parsePartialToken(token, { allowedSingleSegmentPaths: partialArgScope });
        nodes.push({ type: 'partial', name, args });
        index = tokenEnd + 2;
        continue;
      }

      const comparisonBlockTag = getComparisonBlockTag(token);
      if (comparisonBlockTag) {
        const expression = token.slice(`#${comparisonBlockTag} `.length).trim();
        const block = this.parseComparisonBlock(source, tokenEnd + 2, comparisonBlockTag, expression, partialArgScope);
        nodes.push(block.node);
        index = block.nextIndex;
        continue;
      }

      if (token.startsWith('#if ')) {
        const expression = token.slice('#if '.length).trim();
        const block = this.parseIfBlock(source, tokenEnd + 2, expression, partialArgScope);
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
        const forScope = new Set([...partialArgScope, itemName, 'loop']);
        const forResult = this.parseNodes(source, tokenEnd + 2, new Set(['for']), forScope);
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

  parseIfBlock(source, startIndex, initialPath, partialArgScope) {
    if (!PATH_REGEX.test(initialPath)) {
      throw new Error(`Invalid if expression: ${initialPath}`);
    }

    const branches = [];
    let alternate = [];
    let nextIndex = startIndex;
    let currentPath = initialPath;

    while (true) {
      const branchResult = this.parseNodes(source, nextIndex, new Set(['else', 'else_if', 'if']), partialArgScope);
      branches.push({
        path: currentPath,
        consequent: branchResult.nodes,
      });

      if (branchResult.stopTag === 'else') {
        const elseResult = this.parseNodes(source, branchResult.nextIndex, new Set(['if']), partialArgScope);
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

  parseComparisonBlock(source, startIndex, tagName, expression, partialArgScope) {
    const initialBranch = this.parseComparisonBranchExpression(expression, tagName);
    const branches = [];
    let alternate = [];
    let nextIndex = startIndex;
    let currentBranch = initialBranch;
    const elseIfTag = `else_${tagName}`;

    while (true) {
      const branchResult = this.parseNodes(source, nextIndex, new Set(['else', elseIfTag, tagName]), partialArgScope);
      branches.push({
        operator: currentBranch.operator,
        left: currentBranch.left,
        operands: currentBranch.operands,
        consequent: branchResult.nodes,
      });

      if (branchResult.stopTag === 'else') {
        const elseResult = this.parseNodes(source, branchResult.nextIndex, new Set([tagName]), partialArgScope);
        if (elseResult.stopTag !== tagName) {
          throw new Error(`Unclosed ${tagName} block after else`);
        }
        alternate = elseResult.nodes;
        nextIndex = elseResult.nextIndex;
        break;
      }

      if (typeof branchResult.stopTag === 'string' && branchResult.stopTag.startsWith(`#${elseIfTag} `)) {
        currentBranch = this.parseComparisonBranchExpression(
          branchResult.stopTag.slice(`#${elseIfTag} `.length).trim(),
          elseIfTag,
        );
        nextIndex = branchResult.nextIndex;
        continue;
      }

      if (branchResult.stopTag === tagName) {
        nextIndex = branchResult.nextIndex;
        break;
      }

      throw new Error(`Unclosed ${tagName} block`);
    }

    return {
      node: {
        type: 'comparison',
        branches,
        alternate,
      },
      nextIndex,
    };
  }

  parseComparisonBranchExpression(expression, tagName) {
    const operator = COMPARISON_TAG_OPERATORS[tagName];
    const tokens = tokenizeExpression(expression);
    if (
      !operator
      || (operator === 'in' && tokens.length < 2)
      || (operator !== 'in' && tokens.length !== 2)
    ) {
      throw new Error(`Invalid ${tagName} expression: ${expression}`);
    }

    const left = parsePathOperand(tokens[0], tagName, expression);
    const operands = tokens.slice(1).map((token) => parseComparisonOperand(token, tagName, expression));
    return {
      operator,
      left,
      operands,
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
      case 'comparison': {
        const branch = node.branches.find((entry) => this.evaluateComparison(entry, data));
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
    const partialArgs = this.resolvePartialArgs(node.args, data);
    const partialData = {
      ...data,
      partial: {
        ...(data?.partial && typeof data.partial === 'object' ? data.partial : {}),
        ...partialArgs,
      },
    };

    return this.renderTemplate(partialTemplate, partialData, {
      ...renderOptions,
      partialStack: [...activeStack, node.name],
    });
  }

  resolvePartialArgs(args, data) {
    const resolved = {};
    for (const [key, operand] of Object.entries(args || {})) {
      if (operand?.kind === 'literal') {
        resolved[key] = operand.value;
        continue;
      }
      if (operand?.kind === 'path') {
        resolved[key] = this.resolvePath(data, operand.path);
      }
    }
    return resolved;
  }

  evaluateComparison(entry, data) {
    const left = this.evaluateOperand(entry.left, data);
    const operands = entry.operands.map((operand) => this.evaluateOperand(operand, data));

    if (entry.operator === 'eq') {
      const right = operands[0];
      return !left.missing && !right.missing && left.value === right.value;
    }

    if (entry.operator === 'neq') {
      const right = operands[0];
      return left.missing || right.missing || left.value !== right.value;
    }

    if (entry.operator === 'in') {
      if (left.missing) {
        return false;
      }
      return operands.some((operand) => !operand.missing && left.value === operand.value);
    }

    if (entry.operator === 'starts_with') {
      const right = operands[0];
      return (
        !left.missing
        && !right.missing
        && typeof left.value === 'string'
        && typeof right.value === 'string'
        && left.value.startsWith(right.value)
      );
    }

    return false;
  }

  evaluateOperand(operand, data) {
    if (operand.kind === 'literal') {
      return { value: operand.value, missing: false };
    }

    const value = this.resolvePath(data, operand.path);
    return { value, missing: value === undefined };
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
