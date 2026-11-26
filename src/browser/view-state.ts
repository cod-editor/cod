import type { BrowserState } from "../types.ts";

export function isBrowserHome(browser: BrowserState): boolean {
  return browser.url === "about:blank" && !browser.agentPage && !browser.error;
}

export function isBrowserFailure(browser: BrowserState): boolean {
  return Boolean(browser.error && !browser.agentPage);
}
