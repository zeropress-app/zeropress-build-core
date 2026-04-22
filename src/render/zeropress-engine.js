import { SlotResolver } from './slot-resolver.js';
import { VariableResolver } from './variable-resolver.js';
import { ControlFlowRenderer } from './control-flow-renderer.js';
import { PartialResolver } from './partial-resolver.js';

export class ZeroPressEngine {
  constructor() {
    this.slotResolver = new SlotResolver();
    this.partialResolver = new PartialResolver();
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
    const renderedContent = this.renderTemplate(this.expandPartials(template), renderData);
    const layoutWithSlots = this.slotResolver.resolve(layout, this.themePackage.partials, renderedContent);
    return this.renderTemplate(this.expandPartials(layoutWithSlots), renderData);
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
    if (this.themePackage?.metadata?.runtime === '0.4') {
      return this.controlFlowRenderer.render(template, data, {
        escapeValues: true,
        rawPaths: new Set(['meta.head_tags']),
        rawPathPrefixes: new Set(['meta']),
      });
    }

    return this.variableResolver.resolve(template, data);
  }

  expandPartials(template) {
    if (this.themePackage?.metadata?.runtime !== '0.4') {
      return template;
    }

    return this.partialResolver.resolve(template, this.themePackage.partials);
  }
}
