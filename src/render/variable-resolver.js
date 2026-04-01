export class VariableResolver {
  static VARIABLE_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  static STANDALONE_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

  resolve(template, data) {
    let result = template.replace(VariableResolver.VARIABLE_PATTERN, (_, variablePath) => {
      const [prefix, field] = variablePath.split('.');
      const prefixData = data[prefix];

      if (!prefixData || typeof prefixData !== 'object') {
        return '';
      }

      const value = prefixData[field];
      return value == null ? '' : String(value);
    });

    result = result.replace(VariableResolver.STANDALONE_PATTERN, (match, variableName) => {
      if (variableName.startsWith('slot:')) {
        return match;
      }

      const value = data[variableName];
      return value == null ? '' : String(value);
    });

    return result;
  }
}
