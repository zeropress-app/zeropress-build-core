const PARTIAL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]*(?:\/[a-zA-Z_][a-zA-Z0-9_-]*)*$/;
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function parsePartialToken(token) {
  const source = String(token || '').trim();
  if (!source.startsWith('partial:')) {
    throw new Error(`Invalid partial token: ${source}`);
  }

  const expression = source.slice('partial:'.length).trim();
  const nameMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*(?:\/[a-zA-Z_][a-zA-Z0-9_-]*)*)(?:\s+|$)/.exec(expression);
  if (!nameMatch) {
    throw new Error(`Invalid partial reference: ${source}`);
  }

  const name = nameMatch[1];
  if (!PARTIAL_NAME_REGEX.test(name)) {
    throw new Error(`Invalid partial name: ${name}`);
  }

  const argsSource = expression.slice(name.length).trim();
  const args = parsePartialArgs(argsSource);

  return { name, args };
}

function parsePartialArgs(source) {
  if (!source) {
    return {};
  }

  const args = {};
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }

    if (index >= source.length) {
      break;
    }

    const keyMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(index));
    if (!keyMatch) {
      throw new Error(`Invalid partial argument syntax near "${source.slice(index)}"`);
    }

    const key = keyMatch[0];
    if (!IDENTIFIER_REGEX.test(key)) {
      throw new Error(`Invalid partial argument key: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`Duplicate partial argument: ${key}`);
    }

    index += key.length;
    if (source[index] !== '=') {
      throw new Error(`Expected "=" after partial argument "${key}"`);
    }
    index += 1;

    if (source[index] === '"') {
      let cursor = index + 1;
      let escaped = false;

      while (cursor < source.length) {
        const char = source[cursor];
        if (escaped) {
          escaped = false;
          cursor += 1;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          cursor += 1;
          continue;
        }
        if (char === '"') {
          break;
        }
        cursor += 1;
      }

      if (cursor >= source.length || source[cursor] !== '"') {
        throw new Error(`Unclosed string literal for partial argument "${key}"`);
      }

      args[key] = JSON.parse(source.slice(index, cursor + 1));
      index = cursor + 1;
      continue;
    }

    if (source.startsWith('true', index) && isValueBoundary(source, index + 4)) {
      args[key] = true;
      index += 4;
      continue;
    }

    if (source.startsWith('false', index) && isValueBoundary(source, index + 5)) {
      args[key] = false;
      index += 5;
      continue;
    }

    throw new Error(`Unsupported partial argument value for "${key}"`);
  }

  return args;
}

function isValueBoundary(source, index) {
  return index >= source.length || /\s/.test(source[index]);
}
