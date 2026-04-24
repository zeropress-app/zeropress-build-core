import { SlotResolver } from './slot-resolver.js';
import { VariableResolver } from './variable-resolver.js';
import { ControlFlowRenderer } from './control-flow-renderer.js';

export class ZeroPressEngine {
  constructor() {
    this.slotResolver = new SlotResolver();
    this.variableResolver = new VariableResolver();
    this.controlFlowRenderer = new ControlFlowRenderer({
      resolvePath: (data, path) => this.variableResolver.resolvePath(data, path),
      renderText: (value, data, renderOptions) => this.variableResolver.resolve(value, data, renderOptions),
    });
    this.themePackage = null;
  }

  initialize(themePackage) {
    this.themePackage = themePackage;
  }

  async render(templateName, data, context) {
    if (!this.themePackage) {
      throw new Error('Theme package not initialized');
    }

    const template = this.themePackage.templates.get(templateName);
    if (!template) {
      throw new Error(`Template "${templateName}" not found`);
    }

    const layout = this.themePackage.templates.get('layout');
    if (!layout) {
      throw new Error('Template "layout" not found');
    }

    const renderData = this.combineRenderData(data, context);
    const renderedContent = this.renderTemplate(template, renderData);
    const layoutWithSlots = this.slotResolver.resolve(layout, this.themePackage.partials, renderedContent);
    return this.renderTemplate(layoutWithSlots, renderData);
  }

  combineRenderData(data, context) {
    return {
      ...data,
      site: context.site,
      currentUrl: context.currentUrl,
      language: context.language,
    };
  }

  renderTemplate(template, data) {
    if (this.themePackage?.metadata?.runtime !== '0.5') {
      throw new Error(`Unsupported theme runtime: ${this.themePackage?.metadata?.runtime || 'unknown'}`);
    }

    return this.controlFlowRenderer.render(template, data, {
      escapeValues: true,
      rawPaths: new Set(['meta.head_tags']),
      rawPathPrefixes: new Set(['meta']),
      partials: this.themePackage.partials,
    });
  }
}
