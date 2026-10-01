// Work on rendering copies only; validation and exported Preview Data keep the full tree.
export function prepareRenderMenus(menus, slots = {}) {
  const rendered = { ...menus };
  const warnings = [];

  for (const [menuId, slot] of Object.entries(slots)) {
    if (slot.max_depth === undefined || !Object.hasOwn(menus, menuId)) continue;
    const maxDepth = slot.max_depth;
    const items = [];
    const stack = [{ source: menus[menuId].items, output: items, depth: 1 }];
    let actualDepth = 0;
    let omittedItems = 0;

    while (stack.length) {
      const { source, output, depth } = stack.pop();
      for (const item of source) {
        actualDepth = Math.max(actualDepth, depth);
        const children = [];
        if (depth <= maxDepth) {
          output.push({ ...item, children });
        } else {
          omittedItems += 1;
        }
        if (item.children.length) {
          stack.push({ source: item.children, output: children, depth: depth + 1 });
        }
      }
    }

    rendered[menuId] = { ...menus[menuId], items };
    if (omittedItems > 0) {
      warnings.push({
        code: 'MENU_MAX_DEPTH_EXCEEDED',
        message: `Menu "${menuId}" reaches depth ${actualDepth}; the theme supports ${maxDepth}. ${omittedItems} deeper item(s) were omitted from rendering.`,
        menuId,
        maxDepth,
        actualDepth,
        omittedItems,
      });
    }
  }

  return { menus: rendered, warnings };
}
