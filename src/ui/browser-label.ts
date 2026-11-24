import type { BrowserState } from "../types.ts";

export function isBrowserHome(browser: BrowserState): boolean {
  return browser.url === "about:blank" && !browser.agentPage && !browser.error;
}

export function browserLabel(browser: BrowserState): string {
  return isBrowserHome(browser) ? "Home" : browser.title || browser.url;
}
