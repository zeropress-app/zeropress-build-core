export class PartialResolver {
  static PARTIAL_PATTERN = /\{\{partial:([a-zA-Z_][a-zA-Z0-9_-]*(?:\/[a-zA-Z_][a-zA-Z0-9_-]*)*)\}\}/g;

  resolve(template, partials) {
    return this.resolveTemplate(String(template || ''), partials, []);
  }

  resolveTemplate(template, partials, activeStack) {
    return template.replace(PartialResolver.PARTIAL_PATTERN, (_, partialName) => {
      if (!partials.has(partialName)) {
        throw new Error(`Partial "${partialName}" not found`);
      }

      if (activeStack.includes(partialName)) {
        const cycle = [...activeStack, partialName].join(' -> ');
        throw new Error(`Circular partial reference detected: ${cycle}`);
      }

      const partialContent = partials.get(partialName);
      return this.resolveTemplate(String(partialContent || ''), partials, [...activeStack, partialName]);
    });
  }
}
