export class SlotResolver {
  static SLOT_PATTERN = /\{\{slot:([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

  resolve(template, partials, content) {
    return template.replace(SlotResolver.SLOT_PATTERN, (_, slotName) => {
      if (slotName === 'content') {
        return content;
      }

      const partialContent = partials.get(slotName);
      return partialContent !== undefined ? partialContent : '';
    });
  }
}
