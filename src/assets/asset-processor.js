import { createHash } from 'node:crypto';

export class AssetProcessor {
  async processCSS(css) {
    return css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>+~])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim();
  }

  async processJavaScript(js) {
    return js;
  }

  generateAssetHash(content) {
    const hash = createHash('sha256');
    hash.update(content);
    return hash.digest('hex').substring(0, 8);
  }

  updateAssetReferences(html, assetMap) {
    let updatedHtml = html;

    for (const [original, hashed] of assetMap.entries()) {
      const cssRegex = new RegExp(`href=["']${escapeRegex(original)}["']`, 'g');
      updatedHtml = updatedHtml.replace(cssRegex, `href="${hashed}"`);

      const srcRegex = new RegExp(`src=["']${escapeRegex(original)}["']`, 'g');
      updatedHtml = updatedHtml.replace(srcRegex, `src="${hashed}"`);

      const urlRegex = new RegExp(`url\\(["']?${escapeRegex(original)}["']?\\)`, 'g');
      updatedHtml = updatedHtml.replace(urlRegex, `url("${hashed}")`);
    }

    return updatedHtml;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
