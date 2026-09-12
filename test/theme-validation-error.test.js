import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeValidationError } from '../src/theme/format-theme-validation.js';

test('theme validation errors identify reports and preserve generated layout', () => {
  const error = createThemeValidationError({
    checkedFiles: 6,
    errors: [{
      code: 'INVALID_RUNTIME_VERSION',
      path: 'theme.json.runtime',
      category: 'theme_manifest',
      message: 'Unsupported runtime',
      hint: 'Update theme.json:\n\n"runtime": "0.7"',
    }],
  });

  assert.ok(error instanceof Error);
  assert.equal(error.code, 'THEME_VALIDATION_FAILED');
  assert.equal(error.message, [
    'Theme validation failed',
    'Errors: 1',
    'Checked files: 6',
    '',
    'ERROR INVALID_RUNTIME_VERSION',
    'File: theme.json',
    'Path: runtime',
    'Category: theme_manifest',
    'Reason: Unsupported runtime',
    '',
    'Hint:',
    'Update theme.json:',
    '',
    '"runtime": "0.7"',
  ].join('\n'));
});

test('theme validation reports escape diagnostic values before inserting line breaks', () => {
  const error = createThemeValidationError({
    checkedFiles: 7,
    errors: [
      {
        code: 'PATH_ESCAPE',
        path: 'assets/evil\u001B]8;;example\u0007\n\u202E.css',
        message: 'Invalid path\nERROR forged\r\u0085',
      },
      {
        code: 'INVALID_FIELD\u202E',
        path: 'theme.json.bad\nfield',
        category: 'theme_manifest\u0000',
        message: 'Invalid template',
        line: 2,
        column: 3,
        snippet: { line: '{{site.\u202Ebad}}\nERROR forged', pointer: '  ^\r\n' },
        hint: 'Use a valid field.\n\nExample\u001B\u2028',
      },
    ],
  });

  assert.doesNotMatch(error.message, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u202E]/u);
  assert.doesNotMatch(error.message, /^ERROR forged/m);
  assert.match(error.message, /\nFile: assets\/evil\\u001B]8;;example\\u0007\\u000A\\u202E\.css\n/);
  assert.match(error.message, /\nReason: Invalid path\\u000AERROR forged\\u000D\\u0085\n/);
  assert.match(error.message, /\nPath: bad\\u000Afield\n/);
  assert.match(error.message, /\n2 \| \{\{site\.\\u202Ebad\}\}\\u000AERROR forged\n/);
  assert.match(error.message, /\n\nHint:\nUse a valid field\.\n\nExample\\u001B\\u2028$/);
});
