/** Reconcile owned chat/editor views without replacing live interaction targets.
 * Callers key action identity (request, option, profile) and bind handlers to stable
 * resource IDs. Mutable state is read from the feature store when an action runs.
 */
export function reconcileView(
  current: HTMLElement,
  next: HTMLElement,
  retained?: ReadonlyMap<Node, Node>,
): void {
  syncAttributes(current, next);
  if (
    current instanceof HTMLTextAreaElement &&
    next instanceof HTMLTextAreaElement
  ) {
    if (current.value !== next.value) current.value = next.value;
    current.disabled = next.disabled;
    current.placeholder = next.placeholder;
    return;
  }
  if (current instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (current.value !== next.value) current.value = next.value;
    current.disabled = next.disabled;
    current.checked = next.checked;
    return;
  }
  const oldChildren = [...current.childNodes];
  const used = new Set<Node>();
  let cursor = current.firstChild;
  for (const child of [...next.childNodes]) {
    const key = identity(child);
    const preserved = retained?.get(child);
    const match =
      preserved?.parentNode === current
        ? preserved
        : oldChildren.find(
            (old) =>
              !used.has(old) &&
              identity(old) === key &&
              old.nodeType === child.nodeType,
          );
    let resolved = preserved ?? child;
    if (match) used.add(match);
    if (match && !preserved) {
      resolved = match;
      if (match instanceof HTMLElement && child instanceof HTMLElement)
        reconcileView(match, child, retained);
      else if (
        match.nodeType === Node.TEXT_NODE &&
        match.textContent !== child.textContent
      ) {
        const previous = match.textContent ?? "",
          value = child.textContent ?? "";
        if (value.startsWith(previous))
          (match as Text).appendData(value.slice(previous.length));
        else match.textContent = value;
      } else if (!match.isEqualNode(child)) resolved = child;
    }
    if (match && resolved !== match && match.parentNode === current) {
      if (cursor === match) cursor = match.nextSibling;
      current.removeChild(match);
    }
    if (resolved === child && retained?.size) restoreRetained(child, retained);
    if (resolved !== cursor) current.insertBefore(resolved, cursor);
    cursor = resolved.nextSibling;
  }
  for (const old of oldChildren)
    if (!used.has(old) && old.parentNode === current) old.remove();
  if (current instanceof HTMLSelectElement && next instanceof HTMLSelectElement)
    current.value = next.value;
}
// A message can move between the live activity row and the final transcript.
function restoreRetained(root: Node, retained: ReadonlyMap<Node, Node>): void {
  for (const [placeholder, content] of retained)
    if (root.contains(placeholder))
      placeholder.parentNode?.replaceChild(content, placeholder);
}

function identity(node: Node): string {
  if (!(node instanceof Element)) return String(node.nodeType);
  for (const key of [
    "data-workspace-id",
    "data-message-id",
    "data-tool-id",
    "data-focus-key",
  ]) {
    const value = node.getAttribute(key);
    if (value !== null) return `${node.tagName}:${key}:${value}`;
  }
  return [
    node.tagName,
    node.getAttribute("data-message-id"),
    node.getAttribute("data-workspace-id"),
    node.getAttribute("data-tool-id"),
    node.getAttribute("data-focus-key"),
    node.getAttribute("aria-label"),
    node.getAttribute("href"),
    node.getAttribute("src"),
    node.className,
    node instanceof HTMLButtonElement ? node.textContent : "",
  ].join("|");
}
function syncAttributes(current: HTMLElement, next: HTMLElement): void {
  const preserveOpen = current instanceof HTMLDetailsElement;
  for (const attr of [...current.attributes])
    if (
      !(preserveOpen && attr.name === "open") &&
      !next.hasAttribute(attr.name)
    )
      current.removeAttribute(attr.name);
  for (const attr of [...next.attributes])
    if (
      !(preserveOpen && attr.name === "open") &&
      current.getAttribute(attr.name) !== attr.value
    )
      current.setAttribute(attr.name, attr.value);
}
