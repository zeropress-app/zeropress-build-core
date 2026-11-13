import { normalizeBodyPolicy } from '@zeropress/preview-data-validator/content-policy';
import { buildSite, buildSiteFromSource } from './build-site.js';
import { loadThemePackageFromDir } from '../theme/load-theme-dir.js';

export async function buildSiteFromThemeDir(input) {
  normalizeBodyPolicy(input.options);
  const themePackage = await loadThemePackageFromDir(input.themeDir);
  return buildSite({
    previewData: input.previewData,
    themePackage,
    writer: input.writer,
    options: input.options,
  });
}

export async function buildSiteFromSourceAndThemeDir(input) {
  normalizeBodyPolicy(input.options);
  const themePackage = await loadThemePackageFromDir(input.themeDir);
  return buildSiteFromSource({ ...input, themePackage });
}
