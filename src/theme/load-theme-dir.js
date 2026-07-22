import {
  validateThemeFiles,
  validateThemePackageLimits,
} from '@zeropress/theme-validator';

const TEXT_FILE_EXTENSIONS = new Set(['.html', '.json', '.css', '.js', '.txt', '.svg', '.xml']);

export async function loadThemePackageFromDir(themeDir) {
  const fs = await import('node:fs/promises');
  const { constants: fsConstants } = await import('node:fs');
  const path = await import('node:path');

  const rootStat = await fs.lstat(themeDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Theme directory must be a real directory and must not be a symbolic link: ${themeDir}`);
  }
  const canonicalThemeDir = await fs.realpath(themeDir);
  const confirmedRootStat = await fs.lstat(themeDir);
  if (confirmedRootStat.isSymbolicLink() || !confirmedRootStat.isDirectory()) {
    throw new Error(`Theme directory must be a real directory and must not be a symbolic link: ${themeDir}`);
  }

  const fileMap = new Map();
  const packageState = {
    entryCount: 0,
    fileSizes: new Map(),
    pathEntries: [],
    seenCanonicalPaths: new Map(),
  };
  await readThemeDir(
    fs,
    fsConstants,
    path,
    canonicalThemeDir,
    canonicalThemeDir,
    fileMap,
    packageState,
  );

  const validation = await validateThemeFiles(fileMap, {
    entryCount: packageState.entryCount,
    pathEntries: packageState.pathEntries,
  });
  if (!validation.ok) {
    throw new Error(formatThemeValidationFailure(validation));
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

function formatThemeValidationFailure(validation) {
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

async function readThemeDir(fs, fsConstants, path, rootDir, currentDir, fileMap, packageState) {
  const entries = [];
  const directory = await fs.opendir(currentDir);
  for await (const entry of directory) {
    packageState.entryCount += 1;
    assertThemePackageLimits(packageState);
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const rawRelativePath = path.relative(rootDir, fullPath);
    const relativePath = rawRelativePath.replace(/\\/g, '/');
    if (entry.name.includes('\\')) {
      throw createThemePathError(
        'PATH_ESCAPE',
        rawRelativePath,
        `Backslashes are not allowed in theme package paths: ${rawRelativePath}`,
        packageState.fileSizes.size,
      );
    }
    const collisionKey = relativePath.normalize('NFC').toLowerCase();
    const existingPath = packageState.seenCanonicalPaths.get(collisionKey);
    if (existingPath !== undefined) {
      throw createThemePathError(
        'THEME_PATH_COLLISION',
        relativePath,
        `Theme package path collision: '${relativePath}' conflicts with '${existingPath}' after NFC and case normalization`,
        packageState.fileSizes.size,
      );
    }
    packageState.seenCanonicalPaths.set(collisionKey, relativePath);
    const stat = await fs.lstat(fullPath);
    const isSymlink = stat.isSymbolicLink();
    packageState.pathEntries.push({ path: relativePath, isSymlink });

    if (isSymlink) {
      continue;
    }

    if (stat.isDirectory()) {
      await readThemeDir(fs, fsConstants, path, rootDir, fullPath, fileMap, packageState);
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    const noFollow = fsConstants.O_NOFOLLOW || 0;
    let handle;
    try {
      handle = await fs.open(fullPath, fsConstants.O_RDONLY | noFollow);
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        continue;
      }
      packageState.fileSizes.set(relativePath, openedStat.size);
      assertThemePackageLimits(packageState);

      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_FILE_EXTENSIONS.has(ext)) {
        fileMap.set(relativePath, await handle.readFile('utf8'));
      } else {
        fileMap.set(relativePath, new Uint8Array(await handle.readFile()));
      }
    } catch (error) {
      if (error?.code === 'ELOOP') {
        packageState.pathEntries[packageState.pathEntries.length - 1].isSymlink = true;
        continue;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

function createThemePathError(code, filePath, message, checkedFiles) {
  return new Error(formatThemeValidationFailure({
    errors: [{
      code,
      path: filePath,
      message,
      severity: 'error',
      category: 'theme_package_paths',
    }],
    checkedFiles,
  }));
}

function assertThemePackageLimits(packageState) {
  const errors = validateThemePackageLimits(packageState.fileSizes, {
    entryCount: packageState.entryCount,
  });
  if (errors.length === 0) {
    return;
  }

  throw new Error(formatThemeValidationFailure({
    errors,
    checkedFiles: packageState.fileSizes.size,
  }));
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new TextEncoder().encode(String(value));
}
