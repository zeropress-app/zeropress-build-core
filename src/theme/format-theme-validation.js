const UNSAFE_TERMINAL_CHARACTER_REGEX = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export function createThemeValidationError(validation) {
  return Object.assign(new Error(formatThemeValidationFailure(validation)), {
    code: 'THEME_VALIDATION_FAILED',
  });
}

export function formatThemeValidationFailure(validation) {
  const blocks = [
    [
      'Theme validation failed',
      `Errors: ${validation.errors.length}`,
      `Checked files: ${toTerminalSafeText(validation.checkedFiles)}`,
    ].join('\n'),
    ...validation.errors.map((issue) => formatThemeValidationIssue(issue)),
  ];
  return blocks.join('\n\n');
}

function formatThemeValidationIssue(issue) {
  if (!issue) {
    return 'Reason: Unknown error';
  }

  const lines = [`ERROR ${toTerminalSafeText(issue.code || 'THEME_VALIDATION_ERROR')}`];
  const location = splitIssuePath(issue.path);
  if (location.file) {
    lines.push(`File: ${toTerminalSafeText(location.file)}`);
  }
  if (location.path) {
    lines.push(`Path: ${toTerminalSafeText(location.path)}`);
  }
  if (Number.isInteger(issue.line) && Number.isInteger(issue.column)) {
    lines.push(`Line: ${issue.line}, Column: ${issue.column}`);
  }
  if (issue.category) {
    lines.push(`Category: ${toTerminalSafeText(issue.category)}`);
  }
  lines.push(`Reason: ${toTerminalSafeText(issue.message || 'Unknown error')}`);
  if (issue.snippet) {
    const lineLabel = Number.isInteger(issue.line) ? String(issue.line) : '';
    lines.push('', `${lineLabel} | ${toTerminalSafeText(issue.snippet.line)}`, `${' '.repeat(lineLabel.length)} | ${toTerminalSafeText(issue.snippet.pointer)}`);
  }
  if (issue.hint) {
    lines.push('', 'Hint:', String(issue.hint).split('\n').map(toTerminalSafeText).join('\n'));
  }

  return lines.join('\n');
}

function toTerminalSafeText(value) {
  return String(value ?? '').replace(UNSAFE_TERMINAL_CHARACTER_REGEX, (character) => (
    `\\u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  ));
}

function splitIssuePath(issuePath) {
  const normalizedPath = String(issuePath || '');
  if (normalizedPath.startsWith('theme.json.')) {
    return {
      file: 'theme.json',
      path: normalizedPath.slice('theme.json.'.length),
    };
  }

  return { file: normalizedPath, path: '' };
}
