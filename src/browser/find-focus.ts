/** Fixed scripts execute in a private world; no page content crosses the bridge. */
export const findFocusWorld = 1001;
export const captureFindFocus = `(() => {
  const key = Symbol.for('cod.find.focus');
  if (globalThis[key]) return;
  const element = document.activeElement;
  const selection = document.getSelection();
  globalThis[key] = {
    document, element,
    start: typeof element?.selectionStart === 'number' ? element.selectionStart : null,
    end: typeof element?.selectionEnd === 'number' ? element.selectionEnd : null,
    direction: element?.selectionDirection,
    ranges: selection ? Array.from({length: selection.rangeCount}, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  };
})()`;
export const restoreFindFocus = `(() => {
  const key = Symbol.for('cod.find.focus');
  const saved = globalThis[key];
  delete globalThis[key];
  if (!saved || saved.document !== document || !saved.element?.isConnected || saved.element.ownerDocument !== document) return;
  saved.element.focus({preventScroll: true});
  if (saved.start !== null && typeof saved.element.setSelectionRange === 'function') {
    saved.element.setSelectionRange(saved.start, saved.end, saved.direction);
  } else if (saved.ranges.every(range => range.startContainer.isConnected && range.endContainer.isConnected && range.startContainer.ownerDocument === document && range.endContainer.ownerDocument === document)) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    for (const range of saved.ranges) selection?.addRange(range);
  }
})()`;
