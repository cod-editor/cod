const releasesUrl =
  "https://api.github.com/repos/cod-editor/cod/releases?per_page=30";
const releasesPage = "https://github.com/cod-editor/cod/releases";
const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const maxResponseBytes = 1024 * 1024;

export interface ReleaseUpdate {
  version: string;
  downloadUrl: string;
  size: number;
  sha256?: string;
}
export interface ReleaseUpdateNotice {
  version: string;
  status: "available" | "downloading" | "ready" | "retry" | "manual";
}

export function releaseImage(version: string) {
  const tag = `v${version}`;
  if (!releaseComponents(tag)) throw new Error("Invalid Cod release version");
  const name = `Cod-${version}-macOS-arm64.dmg`;
  return {
    name,
    downloadUrl: `${releasesPage}/download/${tag}/${name}`,
    releaseUrl: `${releasesPage}/tag/${tag}`,
  };
}

export function installedReleaseIncludes(installed: string, target: string) {
  const current = releaseComponents(`v${installed}`);
  const update = releaseComponents(`v${target}`);
  return (
    !!current && !!update && (installed === target || newer(current, update))
  );
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
    const { name, downloadUrl } = releaseImage(version);
    const available = release.assets.find(
      (asset: unknown): asset is { size: number; digest?: unknown } => {
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
      },
    );
    if (available) {
      latest = components;
      const digest = available.digest;
      const sha256 =
        typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest)
          ? digest.slice("sha256:".length)
          : undefined;
      update = {
        version,
        downloadUrl,
        size: available.size,
        ...(sha256 ? { sha256 } : {}),
      };
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
