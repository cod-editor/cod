import type { BrowserState } from "../types.ts";

import { isBrowserHome } from "../browser/view-state.ts";

export function browserLabel(browser: BrowserState): string {
  return isBrowserHome(browser) ? "Home" : browser.title || browser.url;
}
