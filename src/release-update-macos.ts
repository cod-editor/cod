import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ReleaseInstallDesktop } from "./release-install";

const execute = promisify(execFile);
const options = { timeout: 12_000, maxBuffer: 1024 * 1024 };
const applyQuarantine = `function run(args) {
  ObjC.import("Foundation");
  const url = $.NSURL.fileURLWithPath(args[0]);
  const properties = $({
    LSQuarantineType: "LSQuarantineTypeWebDownload",
    LSQuarantineAgentName: "Cod",
    LSQuarantineAgentBundleIdentifier: "dev.cod.desktop",
    LSQuarantineOriginURL: args[1],
    LSQuarantineDataURL: args[1],
    LSQuarantineTimeStamp: $.NSDate.date
  });
  if (!url.setResourceValueForKeyError(properties, $.NSURLQuarantinePropertiesKey, null))
    throw Error("Could not quarantine the disk image");
}`;

function contains(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  );
}

export async function installedApplication(
  executable: string,
  home: string,
): Promise<boolean> {
  const binary = await realpath(executable);
  const executableDirectory = path.dirname(binary);
  const contents = path.dirname(executableDirectory);
  const bundle = path.dirname(contents);
  if (
    path.basename(executableDirectory) !== "MacOS" ||
    path.basename(contents) !== "Contents" ||
    !bundle.endsWith(".app")
  )
    return false;
  for (const applications of [
    "/Applications",
    path.join(home, "Applications"),
  ]) {
    try {
      const directory = await realpath(applications);
      if (
        directory === path.dirname(bundle) &&
        !contains("/Volumes", directory)
      )
        return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

function plistJson(xml: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      options,
      (error, output) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(output));
        } catch (cause) {
          reject(cause);
        }
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(xml);
  });
}

type MountedImage = {
  "image-path": string;
  "system-entities": Array<{ "mount-point"?: string }>;
};
async function mountedImages(image: string): Promise<MountedImage[]> {
  const { stdout } = await execute(
    "/usr/bin/hdiutil",
    ["info", "-plist"],
    options,
  );
  const data = (await plistJson(stdout)) as { images?: MountedImage[] };
  if (!Array.isArray(data?.images))
    throw new Error("Could not read attached images");
  return data.images.filter((record) => record["image-path"] === image);
}

function mountPoints(records: MountedImage[]): string[] {
  return records.flatMap((record) =>
    record["system-entities"]
      .map((entity) => entity["mount-point"])
      .filter(
        (mount): mount is string =>
          typeof mount === "string" && path.isAbsolute(mount),
      ),
  );
}

export function macReleaseDesktop(
  openPath: (path: string) => Promise<string>,
): ReleaseInstallDesktop {
  return {
    async quarantine(image, downloadUrl) {
      const read = () =>
        execute(
          "/usr/bin/xattr",
          ["-p", "com.apple.quarantine", image],
          options,
        );
      if ((await read().catch(() => undefined))?.stdout.trim()) return;
      await execute(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", applyQuarantine, image, downloadUrl],
        options,
      );
      if (!(await read()).stdout.trim())
        throw new Error("Could not quarantine the update");
    },
    async open(image) {
      const mounts = mountPoints(await mountedImages(image));
      const error = await openPath(mounts.length === 1 ? mounts[0] : image);
      if (error) throw new Error("Could not open the verified disk image");
    },
    async eject(image, runningExecutable) {
      const records = await mountedImages(image);
      if (records.length === 0) return true;
      const mounts = mountPoints(records);
      if (records.length !== 1 || mounts.length !== 1) return false;
      const [mount] = mounts;
      const mounted = await realpath(mount);
      const running = await realpath(runningExecutable);
      if (contains(mounted, running)) return false;
      await execute("/usr/bin/hdiutil", ["detach", mounted], options);
      return (await mountedImages(image)).length === 0;
    },
  };
}
