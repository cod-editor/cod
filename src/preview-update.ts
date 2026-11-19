const releasesUrl =
  "https://api.github.com/repos/cod-editor/cod/releases?per_page=30";
const releaseDownloads = "https://github.com/cod-editor/cod/releases/download";
const previewTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/;
const maxResponseBytes = 1024 * 1024;

export interface PreviewUpdate {
  version: string;
  downloadUrl: string;
}

function previewComponents(tag: unknown): string[] | undefined {
  return typeof tag === "string" && tag.length < 128
    ? previewTagPattern.exec(tag)?.slice(1)
    : undefined;
}

export function packagedPreviewTag(
  packaged: boolean,
  platform: string,
  architecture: string,
  version: string,
): string | undefined {
  const tag = `v${version}`;
  if (
    packaged &&
    platform === "darwin" &&
    architecture === "arm64" &&
    previewComponents(tag)
  )
    return tag;
}

function newer(components: string[], previous: string[]): boolean {
  for (const [index, part] of components.entries()) {
    const other = previous[index];
    if (part.length !== other.length) return part.length > other.length;
    if (part !== other) return part > other;
  }
  return false;
}

export function latestPreviewUpdate(
  currentTag: string,
  releases: unknown,
): PreviewUpdate | undefined {
  let latest = previewComponents(currentTag);
  if (!latest || !Array.isArray(releases))
    throw new Error("Invalid preview release metadata");
  let update: PreviewUpdate | undefined;
  for (const value of releases) {
    if (!value || typeof value !== "object") continue;
    const release = value as Record<string, unknown>;
    const tag = release.tag_name;
    if (
      release.draft !== false ||
      release.prerelease !== true ||
      typeof tag !== "string" ||
      !Array.isArray(release.assets)
    )
      continue;
    const components = previewComponents(tag);
    if (!components || !newer(components, latest)) continue;
    const version = tag.slice(1);
    const name = `Cod-${version}-macOS-arm64.dmg`;
    const downloadUrl = `${releaseDownloads}/${tag}/${name}`;
    const available = release.assets.some((asset: unknown) => {
      if (!asset || typeof asset !== "object") return false;
      const candidate = asset as Record<string, unknown>;
      return (
        candidate.name === name &&
        candidate.state === "uploaded" &&
        typeof candidate.size === "number" &&
        Number.isSafeInteger(candidate.size) &&
        candidate.size > 0 &&
        candidate.browser_download_url === downloadUrl
      );
    });
    if (available) {
      latest = components;
      update = { version, downloadUrl };
    }
  }
  return update;
}

export async function checkForPreviewUpdate(
  currentTag: string,
  stop: AbortSignal,
  request = fetch,
): Promise<PreviewUpdate | undefined> {
  const response = await request(releasesUrl, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.any([stop, AbortSignal.timeout(8_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Preview release list unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw new Error("Preview release list is too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  return latestPreviewUpdate(currentTag, JSON.parse(body + decoder.decode()));
}
