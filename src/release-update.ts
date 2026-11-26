const releasesUrl =
  "https://api.github.com/repos/cod-editor/cod/releases?per_page=30";
const releaseDownloads = "https://github.com/cod-editor/cod/releases/download";
const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const maxResponseBytes = 1024 * 1024;

export interface ReleaseUpdate {
  version: string;
  downloadUrl: string;
}

type Version = {
  core: string[];
  preview: string | undefined;
};

function releaseComponents(tag: unknown): Version | undefined {
  if (typeof tag !== "string" || tag.length >= 128) return;
  const match = releaseTagPattern.exec(tag);
  if (match?.[0] === tag) return { core: match.slice(1, 4), preview: match[4] };
}

export function packagedReleaseTag(
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
    releaseComponents(tag)
  )
    return tag;
}

function largerNumber(part: string, other: string): boolean {
  return part.length === other.length
    ? part > other
    : part.length > other.length;
}

function newer(candidate: Version, previous: Version): boolean {
  for (const [index, part] of candidate.core.entries()) {
    const other = previous.core[index];
    if (part !== other) return largerNumber(part, other);
  }
  if (previous.preview === undefined) return false;
  return (
    candidate.preview === undefined ||
    largerNumber(candidate.preview, previous.preview)
  );
}

export function latestReleaseUpdate(
  currentTag: string,
  releases: unknown,
): ReleaseUpdate | undefined {
  const current = releaseComponents(currentTag);
  if (!current || !Array.isArray(releases))
    throw new Error("Invalid release metadata");
  let latest = current;
  let update: ReleaseUpdate | undefined;
  for (const value of releases) {
    if (!value || typeof value !== "object") continue;
    const release = value as Record<string, unknown>;
    const tag = release.tag_name;
    if (
      release.draft !== false ||
      typeof tag !== "string" ||
      !Array.isArray(release.assets)
    )
      continue;
    const components = releaseComponents(tag);
    if (!components || !newer(components, latest)) continue;
    const preview = components.preview !== undefined;
    if (
      release.prerelease !== preview ||
      (preview && current.preview === undefined)
    )
      continue;
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

export async function checkForReleaseUpdate(
  currentTag: string,
  stop: AbortSignal,
  request = fetch,
): Promise<ReleaseUpdate | undefined> {
  const response = await request(releasesUrl, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.any([stop, AbortSignal.timeout(8_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Release list unavailable");
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
      throw new Error("Release list is too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  return latestReleaseUpdate(currentTag, JSON.parse(body + decoder.decode()));
}
