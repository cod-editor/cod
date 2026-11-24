import { browserLabel, isBrowserHome } from "./browser-label";
import { actionRow, uiSwitch, icon } from "../ui-kit";
import { isInsecureSite } from "../browser/address";
import { browserDownloads } from "./browser-downloads";
import { updateSiteRequests, sitePermissions } from "./browser-permissions";
import { addressSuggestions } from "./browser-address";
import type { AppState, BrowserState } from "../types";
import type { Invoke } from "./contracts";
import { createBrowserHome } from "./browser-home";

function untrustedCertificate(record: BrowserState): boolean {
  return (
    !record.agentPage &&
    !record.httpFallback &&
    record.url.startsWith("https://") &&
    /\bERR_CERT_(AUTHORITY_INVALID|SELF_SIGNED_LOCAL_NETWORK)\b/.test(
      record.error ?? "",
    )
  );
}

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
  const zoomTimers = new WeakMap<
    HTMLOutputElement,
    ReturnType<typeof setTimeout>
  >();
  const homes = new Map<string, ReturnType<typeof createBrowserHome>>();
  let browserLayoutPending = false;
  function scheduleBrowserLayout(): void {
    if (browserLayoutPending) return;
    browserLayoutPending = true;
    requestAnimationFrame(() => {
      browserLayoutPending = false;
      flushBrowserLayout();
    });
  }
  type CaptureSession = { dialog: HTMLDialogElement; opening?: number };
  let nextOpening = 0;
  const overviewBackdropDeadline = 100; // Bound capture, decode and the paint handoff.
  let captureSession: CaptureSession | null = null;
  const openBackdropDialog = () =>
    document.querySelector<HTMLDialogElement>(
      "dialog[open][data-browser-backdrop]",
    );
  const passesCapture = (
    previous: HTMLDialogElement,
    next: HTMLDialogElement | null,
  ) =>
    previous.dataset.browserBackdrop === "prepare" &&
    next?.dataset.browserBackdrop === "connection";
  const backdrops = new Map<
    HTMLImageElement,
    { pageUrl: string; objectUrl: string }
  >();
  function removeBackdrop(image: HTMLImageElement, objectUrl: string) {
    image.remove();
    URL.revokeObjectURL(objectUrl);
    backdrops.delete(image);
  }
  function updateBrowserBackdrops(
    dialog: HTMLDialogElement | null,
    visibleSlots: Map<string, HTMLElement>,
  ): void {
    const previous = captureSession?.dialog;
    if (!dialog && !previous) return;
    const handoff = !!previous && passesCapture(previous, dialog);
    const state = getState();
    const workspace = state.workspaces.find(
      ({ id }) => id === state.activeWorkspaceId,
    );
    const browser = (id: string) =>
      getState().browsers.find((record) => record.id === id);
    for (const [image, { pageUrl, objectUrl }] of backdrops) {
      const id = image.parentElement?.dataset.browserId ?? "";
      const source = browser(id);
      if (
        !dialog ||
        (dialog !== previous && !handoff) ||
        visibleSlots.get(id) !== image.parentElement ||
        source?.workspaceId !== workspace?.id ||
        source?.url !== pageUrl
      )
        removeBackdrop(image, objectUrl);
    }
    if (dialog === previous) return;
    if (handoff && captureSession && dialog) {
      captureSession.dialog = dialog;
      return;
    }
    captureSession = null;
    if (!dialog || !workspace) return;
    if (dialog.dataset.browserBackdrop === "preserve") return;
    const session = { dialog };
    captureSession = session;
    void captureBrowserBackdrops(session, visibleSlots).catch(() => undefined);
  }
  async function captureBrowserBackdrops(
    session: CaptureSession,
    slots: Map<string, HTMLElement>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const state = getState();
    const workspace = state.workspaces.find(
      ({ id }) => id === state.activeWorkspaceId,
    );
    const overview = session.opening !== undefined;
    const targets = state.browsers
      .filter(
        (item) =>
          item.workspaceId === workspace?.id &&
          !item.agentPage &&
          (overview || item.paneId === workspace?.activePaneId) &&
          slots.has(item.id),
      )
      .sort(
        (a, b) =>
          Number(b.paneId === workspace?.activePaneId) -
          Number(a.paneId === workspace?.activePaneId),
      )
      .slice(0, overview ? 4 : 1)
      .map(({ id }) => id);
    if (!overview && !targets.length) return false;
    const captures = await window.cod.browserOverviewBackdrop(
      targets,
      session.opening,
    );
    const stillCurrent = () =>
      !signal?.aborted &&
      captureSession === session &&
      getState().activeWorkspaceId === workspace?.id &&
      (openBackdropDialog() === session.dialog ||
        passesCapture(session.dialog, openBackdropDialog()));
    if (!stillCurrent()) return false;
    const images = await Promise.all(
      captures.map(async ({ id, url, bytes }) => {
        const target = slots.get(id);
        if (!target) return false;
        const validSource = () => {
          const source = getState().browsers.find((record) => record.id === id);
          return (
            stillCurrent() &&
            panes.contains(target) &&
            !target.hidden &&
            !!target.getClientRects().length &&
            !source?.agentPage &&
            source?.url === url &&
            source.workspaceId === workspace?.id
          );
        };
        if (!validSource()) return false;
        const image = document.createElement("img");
        image.className = "browser-overview-backdrop";
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        const objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
        );
        image.src = objectUrl;
        try {
          if (overview) await image.decode();
          if (validSource()) {
            backdrops.set(image, { pageUrl: url, objectUrl });
            target.append(image);
            return true;
          }
        } catch {
          // A missing frame leaves the ordinary empty browser backdrop.
        }
        URL.revokeObjectURL(objectUrl);
        return false;
      }),
    );
    return images.some(Boolean);
  }
  function visibleSlots() {
    return new Map(
      [...panes.querySelectorAll<HTMLElement>(".browser-content")]
        .filter((element) => !element.hidden && element.getClientRects().length)
        .map((element) => [element.dataset.browserId!, element]),
    );
  }
  function flushBrowserLayout(): void {
    const dialog = openBackdropDialog();
    // The native layer remains visible while the replacement frame is staged.
    // Only the opening handoff can hide it during this interval.
    if (dialog?.hasAttribute("data-browser-preparing")) return;
    const slots = visibleSlots();
    updateBrowserBackdrops(dialog, slots);
    const rectangles = document.querySelector("dialog[open]")
      ? []
      : [...slots].map(([id, element]) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { id, x, y, width, height };
        });
    window.cod.browserLayout(rectangles);
  }
  async function stageBrowserBackdrop(
    dialog: HTMLDialogElement,
  ): Promise<void> {
    const slots = visibleSlots();
    if (!slots.size && !getState().browsers.some((item) => item.visible))
      return;
    for (const [image, { objectUrl }] of backdrops)
      removeBackdrop(image, objectUrl);
    const session = { dialog, opening: ++nextOpening };
    captureSession = session;
    dialog.dataset.browserPreparing = "";
    const deadline = new AbortController();
    const expired = new Promise<void>((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    const timer = window.setTimeout(
      () => deadline.abort(),
      overviewBackdropDeadline,
    );
    try {
      await Promise.race([
        captureBrowserBackdrops(session, slots, deadline.signal)
          .then((painted) => {
            if (painted)
              return new Promise<void>((resolve) =>
                // Give the decoded image a paint before removing the native view.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
          })
          .catch(() => undefined),
        expired,
      ]);
    } finally {
      window.clearTimeout(timer);
      deadline.abort();
    }
    if (!dialog.open || captureSession !== session) return;
    updateBrowserBackdrops(dialog, visibleSlots());
    const hidden = await window.cod.browserHideForOverview(session.opening);
    if (!dialog.open || captureSession !== session) return;
    if (!hidden) throw new Error("Overview native layout was superseded");
    delete dialog.dataset.browserPreparing;
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
    container.setAttribute("aria-label", browserLabel(record));
    const address = container.querySelector<HTMLInputElement>(
      'input[aria-label="Address"]',
    )!;
    if (document.activeElement !== address)
      address.value = record.url === "about:blank" ? "" : record.url;
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back"]',
    )!.disabled = !record.canGoBack;
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Forward"]',
    )!.disabled = !record.canGoForward;
    const browserActions = container.querySelector("browser-action-list");
    browserActions?.toggleAttribute(
      "hidden",
      Boolean(record.temporaryCertificate),
    );
    if (record.nativeTabId)
      browserActions?.setAttribute("tab", String(record.nativeTabId));
    const blocking = container.querySelector<HTMLButtonElement>(
      '[aria-label="Ad blocking"]',
    )!;
    blocking.hidden = Boolean(record.temporaryCertificate);
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
    const insecure = container.querySelector<HTMLElement>(".browser-insecure")!;
    insecure.textContent = record.temporaryCertificate
      ? "Certificate not verified"
      : "Not secure";
    insecure.hidden = !(
      !record.agentPage &&
      (record.temporaryCertificate || (!failed && isInsecureSite(record.url)))
    );
    if (insecure.hidden) address.removeAttribute("aria-describedby");
    else address.setAttribute("aria-describedby", insecure.id);
    const atHome = isBrowserHome(record);
    const home = homes.get(record.id)!;
    home.element.hidden = !atHome;
    if (atHome) home.update();
    container.querySelector<HTMLElement>(".browser-content")!.hidden =
      failed || atHome;
    const failure = container.querySelector<HTMLElement>(".browser-failure")!;
    failure.hidden = !failed;
    const fallback = failed ? record.httpFallback : undefined;
    const certificate = untrustedCertificate(record);
    const certificateOffer = certificate ? record.certificateOffer : undefined;
    const previous =
      record.lastSuccessfulUrl && record.lastSuccessfulUrl !== record.url;
    const recover = failure.querySelector<HTMLButtonElement>(
      "[data-browser-recover]",
    )!;
    recover.hidden = !failed || !(previous || fallback);
    recover.textContent = previous
      ? "Return to previous page"
      : "Return to Home";
    const proceed = failure.querySelector<HTMLButtonElement>(
      "[data-browser-http]",
    )!;
    proceed.hidden = !fallback;
    proceed.dataset.offer = fallback?.id ?? "";
    failure.querySelector<HTMLButtonElement>(
      "[data-browser-system-browser]",
    )!.hidden =
      !certificate ||
      Boolean(certificateOffer) ||
      Boolean(record.temporaryCertificate);
    const continueCertificate = failure.querySelector<HTMLButtonElement>(
      "[data-browser-continue-certificate]",
    )!;
    continueCertificate.hidden = !certificateOffer;
    continueCertificate.dataset.offer = certificateOffer ?? "";
    failure.querySelector<HTMLButtonElement>("[data-browser-retry]")!.hidden =
      Boolean(fallback);
    const title = fallback
      ? "Secure connection unavailable"
      : certificate
        ? "Certificate not trusted"
        : "Page could not load";
    failure.setAttribute("aria-label", title);
    failure.querySelector("h2")!.textContent = title;
    const error = record.error ?? "";
    failure.querySelector("p")!.textContent = fallback
      ? "Opening this site over HTTP would leave your connection unencrypted."
      : certificate
        ? certificateOffer
          ? "Cod doesn't trust this site's certificate issuer. If you trust the site, open a temporary tab with separate cookies. Closing the tab removes the exception."
          : record.temporaryCertificate
            ? "This certificate could not be accepted in the temporary tab."
            : "Cod doesn't trust this site's certificate issuer. Your system browser can show the warning and available options."
        : error.includes("ERR_TOO_MANY_REDIRECTS")
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
      const url = new URL(fallback?.url ?? record.url);
      if (fallback) displayUrl = url.origin;
      else if (url.protocol === "file:") displayUrl = decodeURI(url.pathname);
      else if (url.protocol === "http:" || url.protocol === "https:")
        displayUrl = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      /* Never echo an unparsed address containing credentials or tokens. */
    }
    failure.querySelector("code")!.textContent = displayUrl;
    updateSiteRequests(
      container.querySelector<HTMLElement>(".browser-permission-requests")!,
      record.permissionRequests ?? [],
      invoke,
    );
    const downloads = container.querySelector<HTMLButtonElement>(
      "[aria-label=Downloads]",
    );
    if (downloads) downloads.hidden = !getState().browserDownloads?.length;
    scheduleBrowserLayout();
    container.querySelector<HTMLElement>(".browser-status")!.textContent = [
      record.agentPage ? (record.error ?? "") : "",
      record.permissionDenied ?? "",
      record.temporaryNavigationBlocked
        ? "Open a regular tab to visit another site."
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
    address.value = record.url === "about:blank" ? "" : record.url;
    address.placeholder = "Search or enter address";
    address.spellcheck = false;
    const insecure = document.createElement("span");
    insecure.id = `browser-insecure-${record.id}`;
    insecure.className = "browser-insecure";
    insecure.textContent = "Not secure";
    insecure.hidden = true;
    const zoom = document.createElement("output");
    zoom.className = "browser-zoom-notice";
    zoom.setAttribute("aria-label", "Page zoom");
    zoom.hidden = true;
    navigation.append(insecure, address, zoom);
    const suggestions = addressSuggestions(
      address,
      invoke,
      (url, search) => {
        void invoke("browser.navigate", { id: record.id, url, search }).catch(
          () => {},
        );
      },
      scheduleBrowserLayout,
      () => {
        const url = getState().browsers.find(
          (item) => item.id === record.id,
        )?.url;
        return url === "about:blank" ? "" : (url ?? "");
      },
    );
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
      const checkbox = uiSwitch();
      label.append("Block ads on this site", checkbox);
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
      actions.append(
        paneButton("Site permissions", async () => {
          dialog.close();
          await sitePermissions(
            invoke,
            getState().browsers.find((b) => b.id === record.id)?.url,
          );
        }),
        retry,
        done,
      );
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
    const downloads = paneButton("Downloads", async () => {
      browserDownloads(invoke);
    });
    downloads.type = "button";
    downloads.classList.add("icon-button");
    downloads.setAttribute("aria-label", "Downloads");
    downloads.title = "Downloads";
    downloads.replaceChildren(icon("download"));
    downloads.hidden = !getState().browserDownloads?.length;
    navigation.append(downloads);
    const actions = document.createElement("browser-action-list");
    actions.addEventListener(
      "click",
      () => window.cod.browserSelect(record.id),
      {
        capture: true,
      },
    );
    actions.setAttribute("partition", "persist:cod-browser");
    navigation.append(actions);
    navigation.addEventListener("submit", (event) => {
      event.preventDefault();
      container.querySelector(".action-error")?.remove();
      suggestions.close();
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
    const systemBrowser = paneButton("Open in system browser", async () => {
      const current = getState().browsers.find(({ id }) => id === record.id);
      if (current && untrustedCertificate(current))
        await invoke("browser.open-external", { url: current.url });
    });
    const continueCertificate = paneButton("Open in temporary tab", () =>
      invoke("browser.continue-certificate", {
        id: record.id,
        offer: continueCertificate.dataset.offer,
      }),
    );
    const proceed = paneButton("Open over HTTP", () =>
      invoke("browser.http-fallback", {
        id: record.id,
        offer: proceed.dataset.offer,
      }),
    );
    retry.dataset.browserRetry = "";
    recover.dataset.browserRecover = "";
    systemBrowser.dataset.browserSystemBrowser = "";
    continueCertificate.dataset.browserContinueCertificate = "";
    proceed.dataset.browserHttp = "";
    failure.append(
      failureTitle,
      error,
      url,
      actionRow(retry, recover, continueCertificate, systemBrowser, proceed),
    );
    const home = createBrowserHome(getState, invoke, (url) => {
      void invoke("browser.navigate", { id: record.id, url });
    });
    homes.set(record.id, home);
    const permissionRequests = document.createElement("div");
    permissionRequests.className = "browser-permission-requests";
    permissionRequests.hidden = true;
    body.append(
      navigation,
      permissionRequests,
      suggestions.element,
      home.element,
      content,
      failure,
      message,
    );
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
    showZoom(id: string, zoomPercent: number) {
      const zoom = browserPanes
        .get(id)
        ?.querySelector<HTMLOutputElement>(".browser-zoom-notice");
      if (!zoom) return;
      clearTimeout(zoomTimers.get(zoom));
      zoom.hidden = false;
      zoom.value = `${zoomPercent}%`;
      zoomTimers.set(
        zoom,
        setTimeout(() => {
          zoom.hidden = true;
          zoom.value = "";
        }, 1800),
      );
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
        if (!getState().browsers.some((b) => b.id === id)) {
          browserPanes.delete(id);
          homes.delete(id);
        }
    },
    layout: scheduleBrowserLayout,
    stageBrowserBackdrop,
    focusNative(id: string) {
      // These ordered IPC sends apply visibility before focus. A closed dialog
      // must not depend on a future observer/rAF to restore its native origin.
      flushBrowserLayout();
      window.cod.browserFocus(id);
    },
    dispose() {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleBrowserLayout);
      document.removeEventListener("scroll", scheduleBrowserLayout, true);
      for (const [image, { objectUrl }] of backdrops)
        removeBackdrop(image, objectUrl);
      captureSession = null;
      browserPanes.clear();
      homes.clear();
      window.cod.browserLayout([]);
    },
  };
}
