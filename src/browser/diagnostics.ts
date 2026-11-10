import type { WebContents } from "electron";

const routes = new Set([
  ...["tracker.yandex.ru", "tracker.yandex.com"].flatMap((host) =>
    ["/", "/auth/callback"].map((path) => `https://${host}${path}`),
  ),
  ...[
    "auth.cloud.yandex.ru",
    "auth.cloud.yandex.com",
    "auth.yandex.cloud",
  ].flatMap((host) =>
    [
      "/oauth/authorize",
      "/tmgrdfrend/showcaptcha",
      "/tmgrdfrend/showcaptchafast",
      "/tmgrdfrend/checkcaptchafast",
    ].map((path) => `https://${host}${path}`),
  ),
]);
export function diagnosticRoute(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16384) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return;
    const route = `${url.origin}${url.pathname}`;
    return routes.has(route) ? route : undefined;
  } catch {
    return;
  }
}
const errors = new Set([
  "net::ERR_TOO_MANY_REDIRECTS",
  "net::ERR_ABORTED",
  "net::ERR_CERT_AUTHORITY_INVALID",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_TIMED_OUT",
  "net::ERR_EMPTY_RESPONSE",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_BLOCKED_BY_CLIENT",
  "net::ERR_INTERNET_DISCONNECTED",
]);
const reasons = new Set([
  "SecureOnly",
  "NotOnPath",
  "DomainMismatch",
  "SameSiteStrict",
  "SameSiteLax",
  "SameSiteUnspecifiedTreatedAsLax",
  "SameSiteNoneInsecure",
  "UserPreferences",
  "ThirdPartyPhaseout",
  "ThirdPartyBlockedInFirstPartySet",
  "SyntaxError",
  "InvalidDomain",
  "InvalidPrefix",
  "UnknownError",
]);
type State =
  "recording" | "stopped" | "expired" | "limit" | "scope-left" | "detached";
interface Entry {
  elapsedMs: number;
  kind: string;
  route: string;
  request: number;
  status?: number;
  error?: string;
  repeated?: boolean;
  protocol?: string;
  cached?: boolean;
  serviceWorker?: boolean;
  blockedCookies?: number;
  reasons?: string[];
}
export class DiagnosticCapture {
  readonly report: {
    state: State;
    startedAt: number;
    expiresAt: number;
    limit: number;
    events: Entry[];
  };
  private requests = new Map<string, { route: string; ordinal: number }>();
  private ordinal = 0;
  private now: () => number;
  constructor(now = Date.now, ttl = 45000, limit = 200) {
    this.now = now;
    this.report = {
      state: "recording",
      startedAt: now(),
      expiresAt: now() + ttl,
      limit,
      events: [],
    };
  }
  stop(state: State = "stopped") {
    if (this.report.state === "recording") this.report.state = state;
    this.requests.clear();
  }
  read() {
    if (this.now() >= this.report.expiresAt) this.stop("expired");
    return structuredClone(this.report);
  }
  private add(event: Omit<Entry, "elapsedMs">) {
    this.report.events.push({
      ...event,
      elapsedMs: Math.max(0, this.now() - this.report.startedAt),
    });
    if (this.report.events.length >= this.report.limit) this.stop("limit");
  }
  // CDP payloads are transient: only explicitly selected, bounded fields survive here.
  accept(method: string, data: any) {
    if (
      this.read().state !== "recording" ||
      !data ||
      typeof data.requestId !== "string"
    )
      return;
    const prior = this.requests.get(data.requestId);
    if (method === "Network.requestWillBeSent") {
      if (data.type !== "Document") return;
      const route = diagnosticRoute(data.request?.url);
      if (!route) {
        this.requests.delete(data.requestId);
        return;
      }
      const request = prior?.ordinal ?? ++this.ordinal;
      if (data.redirectResponse && prior) {
        const status = data.redirectResponse.status;
        this.add({
          kind: "redirect",
          route: prior.route,
          request,
          ...(Number.isInteger(status) && status >= 100 && status <= 599
            ? { status }
            : {}),
          repeated:
            diagnosticRoute(data.redirectResponse.url) === prior.route &&
            data.redirectResponse.url === data.request.url,
        });
        if (this.report.state !== "recording") return;
      }
      this.requests.set(data.requestId, {
        route,
        ordinal: request,
      });
      this.add({ kind: "request", route, request });
    } else if (prior) {
      const base = { route: prior.route, request: prior.ordinal };
      if (
        method === "Network.responseReceived" &&
        diagnosticRoute(data.response?.url) === prior.route
      ) {
        const { status, protocol } = data.response;
        this.add({
          ...base,
          kind: "response",
          ...(Number.isInteger(status) && status >= 100 && status <= 599
            ? { status }
            : {}),
          protocol: ["h2", "h3", "http/1.1", "http/1.0"].includes(protocol)
            ? protocol
            : "other",
          cached: data.response.fromDiskCache === true,
          serviceWorker: data.response.fromServiceWorker === true,
        });
      } else if (method === "Network.loadingFailed") {
        this.add({
          ...base,
          kind: "failure",
          error: errors.has(data.errorText) ? data.errorText : "NETWORK_ERROR",
        });
        this.requests.delete(data.requestId);
      } else if (
        method === "Network.responseReceivedExtraInfo" &&
        Array.isArray(data.blockedCookies) &&
        data.blockedCookies.length
      ) {
        const safeReasons = new Set<string>();
        for (const cookie of data.blockedCookies.slice(0, 100))
          for (const reason of (Array.isArray(cookie.blockedReasons)
            ? cookie.blockedReasons
            : []
          ).slice(0, 30))
            safeReasons.add(reasons.has(reason) ? reason : "Other");
        this.add({
          ...base,
          kind: "blocked-cookies",
          blockedCookies: Math.min(100, data.blockedCookies.length),
          reasons: [...safeReasons].sort(),
        });
      } else if (method === "Network.loadingFinished")
        this.requests.delete(data.requestId);
    }
  }
}

export class BrowserDiagnostics {
  private capture?: DiagnosticCapture;
  private timer?: ReturnType<typeof setTimeout>;
  private owned = false;
  private contents: WebContents;
  private restoredFailureUrl: () => string | undefined;
  constructor(
    contents: WebContents,
    restoredFailureUrl: () => string | undefined = () => undefined,
  ) {
    this.contents = contents;
    this.restoredFailureUrl = restoredFailureUrl;
  }
  async start() {
    if (this.owned || this.contents.debugger.isAttached())
      throw new Error("Browser debugger already attached");
    const nativeUrl = this.contents.getURL();
    const scopeUrl =
      nativeUrl === "about:blank" ? this.restoredFailureUrl() : nativeUrl;
    if (!diagnosticRoute(scopeUrl))
      throw new Error(
        "Diagnostics require a public Tracker authorization route",
      );
    this.capture = new DiagnosticCapture();
    try {
      this.contents.debugger.attach("1.3");
      this.owned = true;
      this.contents.debugger.on("message", this.message);
      this.contents.debugger.on("detach", this.detached);
      this.contents.on("did-start-navigation", this.navigation);
      this.contents.on("did-redirect-navigation", this.navigation);
      this.contents.once("destroyed", this.dispose);
      this.timer = setTimeout(() => this.stop("expired"), 45000);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.contents.debugger.sendCommand("Network.enable"),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("timeout")), 5000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      return this.read();
    } catch {
      this.stop();
      throw new Error("Browser diagnostics could not start");
    }
  }
  read() {
    if (!this.capture) throw new Error("Browser diagnostics have not started");
    return this.capture.read();
  }
  stop(state: State = "stopped") {
    this.capture?.stop(state);
    if (this.timer) clearTimeout(this.timer);
    this.contents.debugger.removeListener("message", this.message);
    this.contents.debugger.removeListener("detach", this.detached);
    this.contents.removeListener("did-start-navigation", this.navigation);
    this.contents.removeListener("did-redirect-navigation", this.navigation);
    this.contents.removeListener("destroyed", this.dispose);
    if (this.owned) {
      this.owned = false;
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
    }
    return this.capture ? this.read() : undefined;
  }
  dispose = () => {
    this.stop();
    this.capture = undefined;
  };
  private detached = () => {
    this.owned = false;
    this.stop("detached");
  };
  private navigation = (
    _event: Electron.Event,
    url: string,
    _inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !diagnosticRoute(url)) this.stop("scope-left");
  };
  private message = (_event: Electron.Event, method: string, data: unknown) => {
    this.capture?.accept(method, data);
    if (this.capture && this.capture.report.state !== "recording")
      this.stop(this.capture.report.state);
  };
}
