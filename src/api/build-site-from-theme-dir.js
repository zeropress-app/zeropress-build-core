import { buildSite } from './build-site.js';
import { loadThemePackageFromDir } from '../theme/load-theme-dir.js';

export async function buildSiteFromThemeDir(input) {
  const themePackage = await loadThemePackageFromDir(input.themeDir);
  return buildSite({
    previewData: input.previewData,
    themePackage,
    writer: input.writer,
    options: input.options,
  });
}
