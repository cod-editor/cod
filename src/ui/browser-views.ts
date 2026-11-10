import type { AppState, BrowserState } from "../types";
import type { Invoke } from "./contracts";
import { icon } from "./controls";
export function createBrowserViews(
  panes: HTMLElement,
  getState: () => AppState,
  invoke: Invoke,
  paneButton: (
    label: string,
    action: () => Promise<unknown>,
  ) => HTMLButtonElement,
) {
  const browserPanes = new Map<string, HTMLElement>();
  let browserLayoutPending = false;
  function scheduleBrowserLayout(): void {
    if (browserLayoutPending) return;
    browserLayoutPending = true;
    requestAnimationFrame(() => {
      browserLayoutPending = false;
      const rectangles = document.querySelector("dialog[open]")
        ? []
        : [...panes.querySelectorAll<HTMLElement>(".browser-content")]
            .filter((element) => !element.hidden)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                id: element.dataset.browserId!,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            });
      window.cod.browserLayout(rectangles);
    });
  }
  const resizeObserver = new ResizeObserver(scheduleBrowserLayout);
  resizeObserver.observe(panes);
  const mutationObserver = new MutationObserver(scheduleBrowserLayout);
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  window.addEventListener("resize", scheduleBrowserLayout);
  document.addEventListener("scroll", scheduleBrowserLayout, true);
  function updateBrowserPane(
    container: HTMLElement,
    record: BrowserState,
  ): void {
    container.setAttribute("aria-label", record.title || record.url);
    const address = container.querySelector<HTMLInputElement>(
      'input[aria-label="Address"]',
    )!;
    if (document.activeElement !== address) address.value = record.url;
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back"]',
    )!.disabled = !record.canGoBack;
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Forward"]',
    )!.disabled = !record.canGoForward;
    const browserActions = container.querySelector("browser-action-list");
    if (record.nativeTabId)
      browserActions?.setAttribute("tab", String(record.nativeTabId));
    const blocking = container.querySelector<HTMLButtonElement>(
      '[aria-label="Ad blocking"]',
    )!;
    const warning = !!(
      record.addons?.adblock.error || record.addons?.bitwarden.error
    );
    blocking.dataset.warning = String(warning);
    blocking.title = warning
      ? "Site protection needs attention"
      : "Site protection";
    blocking.setAttribute(
      "aria-pressed",
      String(
        record.addons?.adblock.status === "ready" &&
          record.addons.adblock.enabled,
      ),
    );
    const failed = !!record.error && !record.agentPage;
    container.querySelector<HTMLElement>(".browser-content")!.hidden = failed;
    const failure = container.querySelector<HTMLElement>(".browser-failure")!;
    failure.hidden = !failed;
    failure.querySelector<HTMLButtonElement>("[data-browser-recover]")!.hidden =
      !failed ||
      !record.lastSuccessfulUrl ||
      record.lastSuccessfulUrl === record.url;
    const error = record.error ?? "";
    failure.querySelector("p")!.textContent = error.includes(
      "ERR_TOO_MANY_REDIRECTS",
    )
      ? "The site redirected too many times."
      : error.includes("ERR_NAME_NOT_RESOLVED")
        ? "The site's address could not be found."
        : error.includes("ERR_INTERNET_DISCONNECTED")
          ? "There is no internet connection."
          : error.includes("ERR_CONNECTION_REFUSED")
            ? "The site refused the connection."
            : error.includes("ERR_TIMED_OUT") ||
                error.includes("ERR_CONNECTION_TIMED_OUT")
              ? "The site took too long to respond."
              : error.includes("ERR_CERT_")
                ? "A secure connection to this site could not be established."
                : "The page could not be opened. You can retry or enter another address.";
    let displayUrl = "Requested page";
    try {
      const url = new URL(record.url);
      if (url.protocol === "http:" || url.protocol === "https:")
        displayUrl = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      /* Never echo an unparsed address containing credentials or tokens. */
    }
    failure.querySelector("code")!.textContent = displayUrl;
    scheduleBrowserLayout();
    container.querySelector<HTMLElement>(".browser-status")!.textContent = [
      record.agentPage ? (record.error ?? "") : "",
      record.permissionDenied ?? "",
      record.download
        ? `Download ${record.download.status}: ${record.download.path ?? record.download.basename}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const message = container.querySelector<HTMLElement>(".browser-status")!;
    if (record.agentPage) {
      message.setAttribute("aria-label", "Agent page status");
      const status = record.agentPage.submission?.status;
      message.textContent =
        status === "sending"
          ? "Sending response"
          : status === "completed"
            ? "Response sent"
            : status === "uncertain"
              ? "Delivery uncertain. Do not resend the response."
              : (record.agentPage.error ?? record.error ?? "");
    }
    message.hidden = !message.textContent;
  }
  function createBrowserPane(
    container: HTMLElement,
    record: BrowserState,
  ): void {
    container.dataset.browserPane = record.id;
    const navigation = document.createElement("form");
    navigation.className = "browser-navigation";
    navigation.hidden = !!record.agentPage;
    for (const [label, op] of [
      ["Back", "back"],
      ["Forward", "forward"],
      ["Reload", "reload"],
    ] as const) {
      const button = paneButton(label, () =>
        invoke(`browser.${op}`, { id: record.id }),
      );
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.classList.add("icon-button");
      button.replaceChildren(icon(op));
      navigation.append(button);
    }
    const address = document.createElement("input");
    address.setAttribute("aria-label", "Address");
    address.value = record.url;
    address.spellcheck = false;
    navigation.append(address);
    const blocking = paneButton("Ad blocking", async () => {
      const dialog = document.createElement("dialog");
      dialog.className = "browser-protection";
      dialog.setAttribute("aria-label", "Site protection");
      const title = document.createElement("h2");
      title.textContent = "Site protection";
      const status = document.createElement("div");
      status.setAttribute("role", "region");
      status.setAttribute("aria-label", "Browser add-on status");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      label.append(checkbox, "Block ads on this site");
      const refresh = () => {
        const current = getState().browsers.find((b) => b.id === record.id);
        const adblock = current?.addons?.adblock;
        checkbox.disabled = adblock?.status !== "ready";
        checkbox.checked = adblock?.enabled ?? false;
        status.replaceChildren();
        const addStatus = (
          heading: string,
          detail?: string,
          technical = false,
        ) => {
          const section = document.createElement("section");
          const title = document.createElement("p");
          title.className = "protection-status-title";
          title.textContent = heading;
          section.append(title);
          if (detail) {
            const text = document.createElement("p");
            text.textContent = detail;
            if (technical) {
              const details = document.createElement("details");
              const summary = document.createElement("summary");
              summary.textContent = "Setup details";
              details.append(summary, text);
              section.append(details);
            } else section.append(text);
          }
          status.append(section);
        };
        if (adblock?.error) {
          const detail = adblock.error.replace(
            /^(Blocking unavailable\.\s*|Update failed; using last-known-good filters\.\s*)/i,
            "",
          );
          addStatus(
            adblock.status === "ready"
              ? "Filter update failed. Saved filters remain active."
              : "Ad blocking unavailable",
            detail,
          );
        } else if (adblock?.status !== "ready")
          addStatus("Filters are loading...");
        const bitwarden = current?.addons?.bitwarden;
        if (bitwarden?.error)
          addStatus(
            "Bitwarden unavailable",
            bitwarden.error.replace(/^Bitwarden unavailable:\s*/i, ""),
            true,
          );
        retry.hidden = !adblock?.error;
      };
      checkbox.onchange = async () => {
        checkbox.disabled = true;
        try {
          await invoke(
            "browser.blocking",
            { id: record.id, enabled: checkbox.checked },
            { reportError: false },
          );
          refresh();
        } catch (error) {
          refresh();
          status.textContent = String(error);
        }
      };
      const retry = paneButton("Retry filter update", async () => {
        status.textContent = "Updating filters...";
        try {
          await invoke(
            "browser.blocking-retry",
            { id: record.id },
            { reportError: false },
          );
          refresh();
        } catch (error) {
          status.textContent = String(error);
        }
      });
      const done = paneButton("Done", async () => dialog.close());
      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      actions.append(retry, done);
      dialog.append(title, label, status, actions);
      refresh();
      document.body.append(dialog);
      dialog.showModal();
      const rect = blocking.getBoundingClientRect();
      dialog.style.left = `${Math.max(4, Math.min(rect.right - dialog.offsetWidth, innerWidth - dialog.offsetWidth - 4))}px`;
      dialog.style.top = `${rect.bottom + 4}px`;
      dialog.onclose = () => {
        dialog.remove();
        if (blocking.isConnected) blocking.focus();
      };
    });
    blocking.setAttribute("aria-label", "Ad blocking");
    blocking.title = "Ad blocking";
    blocking.classList.add("icon-button");
    blocking.replaceChildren(icon("shield"));
    navigation.append(blocking);
    const actions = document.createElement("browser-action-list");
    actions.addEventListener(
      "click",
      () => window.cod.browserSelect(record.id),
      {
        capture: true,
      },
    );
    actions.setAttribute("partition", "persist:cod-browser");
    actions.setAttribute("alignment", "bottom right");
    navigation.append(actions);
    navigation.addEventListener("submit", (event) => {
      event.preventDefault();
      void invoke("browser.navigate", {
        id: record.id,
        url: address.value,
      }).catch(() => undefined);
    });
    const body = document.createElement("div");
    body.className = "pane-body browser-body";
    const content = document.createElement("div");
    content.className = "browser-content";
    content.dataset.browserId = record.id;
    content.setAttribute("role", "region");
    content.setAttribute("aria-label", "Browser content");
    const message = document.createElement("div");
    message.className = "browser-status";
    message.setAttribute("role", "status");
    const failure = document.createElement("section");
    failure.className = "browser-failure";
    failure.setAttribute("aria-label", "Page could not load");
    const failureTitle = document.createElement("h2");
    failureTitle.textContent = "Page could not load";
    const error = document.createElement("p");
    const url = document.createElement("code");
    const retry = paneButton("Reload page", () =>
      invoke("browser.reload", { id: record.id }),
    );
    const recover = paneButton("Return to previous page", () =>
      invoke("browser.recover", { id: record.id }),
    );
    recover.dataset.browserRecover = "";
    failure.append(failureTitle, error, url, retry, " ", recover);
    body.append(navigation, content, failure, message);
    container.append(body);
    browserPanes.set(record.id, container);
    updateBrowserPane(container, record);
  }

  return {
    create: createBrowserPane,
    update(record: BrowserState, active: boolean) {
      const view = browserPanes.get(record.id);
      if (view) {
        view.dataset.active = String(active);
        updateBrowserPane(view, record);
      }
      return view;
    },
    focusAddress(id: string) {
      const input = browserPanes
        .get(id)
        ?.querySelector<HTMLInputElement>('input[aria-label="Address"]');
      input?.focus();
      input?.select();
    },
    reconcile() {
      for (const id of browserPanes.keys())
        if (!getState().browsers.some((b) => b.id === id))
          browserPanes.delete(id);
    },
    layout: scheduleBrowserLayout,
    dispose() {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleBrowserLayout);
      document.removeEventListener("scroll", scheduleBrowserLayout, true);
      browserPanes.clear();
      window.cod.browserLayout([]);
    },
  };
}
