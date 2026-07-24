export function formatThemeValidationFailure(validation) {
  const blocks = [
    [
      'Theme validation failed',
      `Errors: ${validation.errors.length}`,
      `Checked files: ${validation.checkedFiles}`,
    ].join('\n'),
    ...validation.errors.map((issue) => formatThemeValidationIssue(issue)),
  ];
  return blocks.join('\n\n');
}

function formatThemeValidationIssue(issue) {
  if (!issue) {
    return 'Reason: Unknown error';
  }

  const lines = [`ERROR ${issue.code || 'THEME_VALIDATION_ERROR'}`];
  const location = splitIssuePath(issue.path);
  if (location.file) {
    lines.push(`File: ${location.file}`);
  }
  if (location.path) {
    lines.push(`Path: ${location.path}`);
  }
  if (Number.isInteger(issue.line) && Number.isInteger(issue.column)) {
    lines.push(`Line: ${issue.line}, Column: ${issue.column}`);
  }
  if (issue.category) {
    lines.push(`Category: ${issue.category}`);
  }
  lines.push(`Reason: ${issue.message || 'Unknown error'}`);
  if (issue.snippet) {
    const lineLabel = Number.isInteger(issue.line) ? String(issue.line) : '';
    lines.push('', `${lineLabel} | ${issue.snippet.line}`, `${' '.repeat(lineLabel.length)} | ${issue.snippet.pointer}`);
  }
  if (issue.hint) {
    lines.push('', 'Hint:', issue.hint);
  }

  return lines.join('\n');
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
