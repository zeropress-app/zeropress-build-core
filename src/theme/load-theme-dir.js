import { validateThemeFiles } from '@zeropress/theme-validator';

const TEXT_FILE_EXTENSIONS = new Set(['.html', '.json', '.css', '.js', '.txt', '.svg', '.xml']);

export async function loadThemePackageFromDir(themeDir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const fileMap = new Map();
  await readThemeDir(fs, path, themeDir, themeDir, fileMap);

  const validation = await validateThemeFiles(fileMap);
  if (!validation.ok) {
    throw new Error(`Theme validation failed:\n${formatThemeValidationIssue(validation.errors[0])}`);
  }

  const rawThemeJson = String(fileMap.get('theme.json'));
  const themeJson = JSON.parse(rawThemeJson);
  const manifest = validation.manifest;
  if (!manifest) {
    throw new Error('Theme validation failed: normalized manifest not available');
  }
  const templates = new Map();
  const partials = new Map();
  const assets = new Map();

  for (const [filePath, value] of fileMap.entries()) {
    if (filePath === 'theme.json') {
      continue;
    }

    if (filePath.startsWith('partials/') && filePath.endsWith('.html')) {
      const partialName = filePath.replace(/^partials\//, '').replace(/\.html$/, '');
      partials.set(partialName, String(value));
      continue;
    }

    if (filePath.startsWith('assets/')) {
      const assetPath = filePath.replace(/^assets\//, '');
      assets.set(assetPath, toUint8Array(value));
      continue;
    }

    if (filePath.endsWith('.html') && !filePath.includes('/')) {
      const templateName = filePath.replace(/\.html$/, '');
      templates.set(templateName, String(value));
    }
  }

  return {
    metadata: {
      ...manifest,
      thumbnail: themeJson.thumbnail,
    },
    templates,
    partials,
    assets,
  };
}

function formatThemeValidationIssue(issue) {
  if (!issue) {
    return 'Reason: Unknown error';
  }

  const lines = [];
  if (issue.path) {
    lines.push(`File: ${issue.path}`);
  }
  if (Number.isInteger(issue.line) && Number.isInteger(issue.column)) {
    lines.push(`Line: ${issue.line}, Column: ${issue.column}`);
  }
  if (issue.category) {
    lines.push(`Category: ${issue.category}`);
  }
  if (issue.code) {
    lines.push(`Code: ${issue.code}`);
  }
  lines.push(`Reason: ${issue.message || 'Unknown error'}`);
  if (issue.hint) {
    lines.push('', 'Hint:', issue.hint);
  }

  return lines.join('\n');
}

async function readThemeDir(fs, path, rootDir, currentDir, fileMap) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await readThemeDir(fs, path, rootDir, fullPath, fileMap);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      fileMap.set(relativePath, await fs.readFile(fullPath, 'utf8'));
    } else {
      fileMap.set(relativePath, new Uint8Array(await fs.readFile(fullPath)));
    }
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new TextEncoder().encode(String(value));
}
