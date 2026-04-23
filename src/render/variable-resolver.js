export class VariableResolver {
  static MENU_PATTERN = /\{\{menu:([a-z][a-z0-9_-]{0,63})\}\}/g;
  static VARIABLE_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\}\}/g;
  static STANDALONE_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

  resolve(template, data, options = {}) {
    let result = template.replace(VariableResolver.MENU_PATTERN, (_, menuId) => {
      return this.renderMenu(data?.menus?.[menuId]);
    });

    result = result.replace(VariableResolver.VARIABLE_PATTERN, (_, variablePath) => {
      const value = this.resolvePath(data, variablePath);
      return this.renderValue(value, variablePath, options);
    });

    result = result.replace(VariableResolver.STANDALONE_PATTERN, (match, variableName) => {
      if (variableName.startsWith('slot:')) {
        return match;
      }

      const value = data[variableName];
      return this.renderValue(value, variableName, options);
    });

    return result;
  }

  resolvePath(data, variablePath) {
    const segments = variablePath.split('.');
    let current = data;

    for (const segment of segments) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }

      current = current[segment];
    }

    return current;
  }

  renderMenu(menu) {
    if (!menu || !Array.isArray(menu.items) || menu.items.length === 0) {
      return '';
    }

    return `<ul>${menu.items.map((item) => this.renderMenuItem(item)).join('')}</ul>`;
  }

  renderMenuItem(item) {
    if (!item || typeof item !== 'object') {
      return '';
    }

    const title = this.escapeHtml(String(item.title || ''));
    const url = this.escapeHtml(String(item.url || ''));
    const target = item.target === '_blank' ? '_blank' : '_self';
    const rel = target === '_blank' ? ' rel="noreferrer noopener"' : '';
    const children = Array.isArray(item.children) && item.children.length > 0
      ? `<ul>${item.children.map((child) => this.renderMenuItem(child)).join('')}</ul>`
      : '';

    return `<li><a href="${url}" target="${target}"${rel}>${title}</a>${children}</li>`;
  }

  renderValue(value, variablePath, options = {}) {
    if (value == null) {
      return '';
    }

    const stringValue = String(value);
    if (options.escapeValues !== true) {
      return stringValue;
    }

    if (this.shouldRenderRaw(variablePath, options)) {
      return stringValue;
    }

    return this.escapeHtml(stringValue);
  }

  shouldRenderRaw(variablePath, options = {}) {
    if (options.rawPaths instanceof Set && options.rawPaths.has(variablePath)) {
      return true;
    }

    if (options.rawPathPrefixes instanceof Set) {
      for (const prefix of options.rawPathPrefixes) {
        if (variablePath === prefix || variablePath.startsWith(`${prefix}.`)) {
          return true;
        }
      }
    }

    const lastSegment = variablePath.split('.').pop();
    if (lastSegment === 'html' || lastSegment?.endsWith('_html')) {
      return true;
    }

    if (lastSegment?.endsWith('_url')) {
      return true;
    }

    return false;
  }

  escapeHtml(value) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
