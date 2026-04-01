import { SlotResolver } from './slot-resolver.js';
import { VariableResolver } from './variable-resolver.js';

export class ZeroPressEngine {
  constructor() {
    this.slotResolver = new SlotResolver();
    this.variableResolver = new VariableResolver();
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

    const renderedContent = this.variableResolver.resolve(template, this.combineRenderData(data, context));
    const layoutWithSlots = this.slotResolver.resolve(layout, this.themePackage.partials, renderedContent);
    return this.variableResolver.resolve(layoutWithSlots, this.combineRenderData(data, context));
  }

  combineRenderData(data, context) {
    return {
      ...data,
      site: context.site,
      currentUrl: context.currentUrl,
      language: context.language,
    };
  }
}
