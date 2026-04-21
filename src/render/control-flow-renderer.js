function isWhitespace(value) {
  return /^[\s\r\n\t]*$/.test(value);
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

      if (token.startsWith('#if_eq ')) {
        const expression = token.slice('#if_eq '.length).trim();
        const match = /^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s+("(?:[^"\\]|\\.)*")$/.exec(expression);
        if (!match) {
          throw new Error(`Invalid if_eq expression: ${expression}`);
        }
        const [, path, literalSource] = match;
        const literal = JSON.parse(literalSource);
        const ifResult = this.parseNodes(source, tokenEnd + 2, new Set(['else', 'if_eq']));
        let elseNodes = [];
        let nextIndex = ifResult.nextIndex;
        if (ifResult.stopTag === 'else') {
          const elseResult = this.parseNodes(source, ifResult.nextIndex, new Set(['if_eq']));
          if (elseResult.stopTag !== 'if_eq') {
            throw new Error('Unclosed if_eq block after else');
          }
          elseNodes = elseResult.nodes;
          nextIndex = elseResult.nextIndex;
        } else if (ifResult.stopTag !== 'if_eq') {
          throw new Error('Unclosed if_eq block');
        }
        nodes.push({ type: 'if_eq', path, literal, consequent: ifResult.nodes, alternate: elseNodes });
        index = nextIndex;
        continue;
      }

      if (token.startsWith('#if ')) {
        const path = token.slice('#if '.length).trim();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(path)) {
          throw new Error(`Invalid if expression: ${path}`);
        }
        const ifResult = this.parseNodes(source, tokenEnd + 2, new Set(['else', 'if']));
        let elseNodes = [];
        let nextIndex = ifResult.nextIndex;
        if (ifResult.stopTag === 'else') {
          const elseResult = this.parseNodes(source, ifResult.nextIndex, new Set(['if']));
          if (elseResult.stopTag !== 'if') {
            throw new Error('Unclosed if block after else');
          }
          elseNodes = elseResult.nodes;
          nextIndex = elseResult.nextIndex;
        } else if (ifResult.stopTag !== 'if') {
          throw new Error('Unclosed if block');
        }
        nodes.push({ type: 'if', path, consequent: ifResult.nodes, alternate: elseNodes });
        index = nextIndex;
        continue;
      }

      if (token.startsWith('#for ')) {
        const expression = token.slice('#for '.length).trim();
        const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)$/.exec(expression);
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
      const expected = Array.from(stopTags).filter((entry) => entry !== 'else').join(', ');
      throw new Error(`Missing closing tag for ${expected}`);
    }

    return { nodes, nextIndex: source.length, stopTag: null };
  }

  renderNodes(nodes, data, renderOptions) {
    return nodes.map((node) => this.renderNode(node, data, renderOptions)).join('');
  }

  renderNode(node, data, renderOptions) {
    switch (node.type) {
      case 'text':
        return this.renderText(node.value, data, renderOptions);
      case 'if': {
        const value = this.resolvePath(data, node.path);
        return this.isTruthy(value)
          ? this.renderNodes(node.consequent, data, renderOptions)
          : this.renderNodes(node.alternate, data, renderOptions);
      }
      case 'if_eq': {
        const value = this.resolvePath(data, node.path);
        return value === node.literal
          ? this.renderNodes(node.consequent, data, renderOptions)
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
            $index: index,
          }, renderOptions))
          .join('');
      }
      default:
        return '';
    }
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
