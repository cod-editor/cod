import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import {
  sitePermissionNames,
  type SitePermission,
  type SitePolicy,
  type SiteRequest,
} from "./permission-types.ts";
interface Pending extends SiteRequest {
  contents: WebContents;
  callback: (allowed: boolean) => void;
  cleanup: () => void;
}
interface Options {
  session: Session;
  owner: (contents: WebContents) => string | undefined;
  policies: () => SitePolicy[];
  save: (policy: SitePolicy) => Promise<void>;
  changed: (pending: SiteRequest[]) => void;
  denied: (contentsId: number, permission: string) => void;
}
export function webOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Site permissions require an HTTP or HTTPS origin");
  return url.origin;
}
function permissionKeys(
  permission: string,
  mediaTypes?: string[],
): SitePermission[] {
  if (permission === "media")
    return (mediaTypes?.length ? mediaTypes : ["audio", "video"]).flatMap(
      (type) =>
        type === "audio"
          ? ["microphone" as const]
          : type === "video"
            ? ["camera" as const]
            : [],
    );
  return Object.hasOwn(sitePermissionNames, permission)
    ? [permission as SitePermission]
    : [];
}
/** Requests are bound to the requesting origin, embedding origin and live page. */
export class SitePermissions {
  private pending = new Map<string, Pending>();
  private once = new Map<number, Set<string>>();
  private disposed = false;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    options.session.setPermissionCheckHandler(
      (contents, permission, origin, details) => {
        if (this.disposed) return false;
        try {
          const requesting = webOrigin(
            details.securityOrigin || details.requestingUrl || origin,
          );
          const top = webOrigin(
            contents?.getURL() || details.embeddingOrigin || requesting,
          );
          const keys = permissionKeys(
            permission,
            details.mediaType && details.mediaType !== "unknown"
              ? [details.mediaType]
              : undefined,
          );
          if (!keys.length || (contents && !options.owner(contents)))
            return false;
          return keys.every((key) =>
            this.allowed(contents?.id, requesting, top, key),
          );
        } catch {
          return false;
        }
      },
    );
    options.session.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        try {
          const browserId = options.owner(contents);
          const origin = webOrigin(
            (details as Electron.MediaAccessPermissionRequest).securityOrigin ||
              details.requestingUrl,
          );
          const topOrigin = webOrigin(contents.getURL());
          const permissions = permissionKeys(
            permission,
            (details as Electron.MediaAccessPermissionRequest).mediaTypes,
          );
          if (this.disposed || !browserId || !permissions.length) {
            callback(false);
            options.denied(contents.id, permission);
            return;
          }
          if (
            permissions.some(
              (key) => this.policy(origin, topOrigin, key) === "block",
            )
          ) {
            callback(false);
            return;
          }
          if (
            permissions.every((key) =>
              this.allowed(contents.id, origin, topOrigin, key),
            )
          ) {
            callback(true);
            return;
          }
          if (
            [...this.pending.values()].filter(
              (item) => item.browserId === browserId,
            ).length >= 8
          ) {
            callback(false);
            return;
          }
          const id = randomUUID();
          const cancel = () => this.finish(id, false);
          const timer = setTimeout(cancel, 120_000);
          contents.on("did-start-navigation", cancel);
          contents.once("destroyed", cancel);
          const cleanup = () => {
            clearTimeout(timer);
            contents.removeListener("did-start-navigation", cancel);
            contents.removeListener("destroyed", cancel);
          };
          this.pending.set(id, {
            id,
            browserId,
            origin,
            topOrigin,
            permissions,
            contents,
            callback,
            cleanup,
          });
          this.notify();
        } catch {
          callback(false);
        }
      },
    );
  }
  private key(origin: string, top: string, permission: SitePermission) {
    return JSON.stringify([origin, top, permission]);
  }
  private policy(origin: string, top: string, permission: SitePermission) {
    return this.options
      .policies()
      .find(
        (item) =>
          item.origin === origin &&
          item.topOrigin === top &&
          item.permission === permission,
      )?.decision;
  }
  private allowed(
    contentsId: number | undefined,
    origin: string,
    top: string,
    permission: SitePermission,
  ) {
    const policy = this.policy(origin, top, permission);
    if (
      contentsId === undefined &&
      permission === "notifications" &&
      policy !== "block"
    )
      return (
        policy === "allow" ||
        [...this.once.values()].some((grants) =>
          grants.has(this.key(origin, top, permission)),
        )
      );
    return (
      policy === "allow" ||
      (policy !== "block" &&
        contentsId !== undefined &&
        !!this.once.get(contentsId)?.has(this.key(origin, top, permission)))
    );
  }
  private notify() {
    this.options.changed(
      [...this.pending.values()].map(
        ({ id, browserId, origin, topOrigin, permissions }) => ({
          id,
          browserId,
          origin,
          topOrigin,
          permissions,
        }),
      ),
    );
  }
  private finish(id: string, allowed: boolean) {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    item.cleanup();
    item.callback(allowed);
    this.notify();
  }
  async answer(id: string, decision: string) {
    if (!["allow-once", "allow", "block"].includes(decision))
      throw new Error("Permission decision must be allow-once, allow or block");
    const item = this.pending.get(id);
    if (!item) throw new Error("Permission request is no longer active");
    if (decision !== "allow-once")
      for (const permission of item.permissions)
        await this.options.save({
          origin: item.origin,
          topOrigin: item.topOrigin,
          permission,
          decision: decision as "allow" | "block",
        });
    if (!this.pending.has(id)) return { answered: false };
    if (decision === "allow-once") {
      let grants = this.once.get(item.contents.id);
      if (!grants) {
        grants = new Set();
        this.once.set(item.contents.id, grants);
        const clear = () => {
          grants!.clear();
        };
        item.contents.on("did-start-navigation", clear);
        item.contents.once("destroyed", () => {
          this.once.delete(item.contents.id);
        });
      }
      for (const permission of item.permissions)
        grants.add(this.key(item.origin, item.topOrigin, permission));
    }
    this.finish(id, decision !== "block");
    return { answered: true };
  }
  revoke(origin: string, top: string, permission: SitePermission) {
    for (const grants of this.once.values())
      grants.delete(this.key(origin, top, permission));
  }
  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.finish(id, false);
    this.once.clear();
  }
}
