import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  migrateProfile,
  extensionInstallDirectory,
  profileIsLive,
} from "../../src/profile-migration.ts";
import { defaultDataDirectory, defaultSocketPath } from "../../src/paths.ts";
function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "cod-migration-")),
    legacyDirectory = path.join(parent, "cod-restart"),
    directory = path.join(parent, "cod");
  mkdirSync(
    path.join(legacyDirectory, "chromium", "Partitions", "cod-browser"),
    { recursive: true },
  );
  mkdirSync(path.join(legacyDirectory, "browser-addons", "bitwarden"), {
    recursive: true,
  });
  writeFileSync(
    path.join(legacyDirectory, "state.json"),
    JSON.stringify({ fixture: "preserved" }),
  );
  writeFileSync(path.join(legacyDirectory, "keymap.json"), '{"fixture":true}');
  writeFileSync(
    path.join(legacyDirectory, "chromium", "Local State"),
    "invented-encryption-metadata",
  );
  writeFileSync(
    path.join(legacyDirectory, "browser-addons", "bitwarden", "manifest.json"),
    "invented-payload",
  );
  return { parent, legacyDirectory, directory, probeLive: () => false };
}
test("whole profile moves, original real extension path survives, rerun is idempotent", () => {
  const f = fixture();
  try {
    const previous = path.join(
      f.legacyDirectory,
      "browser-addons",
      "bitwarden",
    );
    const originalRealPath = realpathSync(previous);
    migrateProfile(f);
    assert.equal(
      readFileSync(path.join(f.directory, "state.json"), "utf8"),
      '{"fixture":"preserved"}',
    );
    assert.equal(
      readFileSync(path.join(f.directory, "chromium", "Local State"), "utf8"),
      "invented-encryption-metadata",
    );
    assert.equal(realpathSync(previous), originalRealPath);
    assert.equal(
      extensionInstallDirectory(f.directory),
      path.dirname(previous),
    );
    assert.equal(
      readFileSync(path.join(previous, "manifest.json"), "utf8"),
      "invented-payload",
    );
    assert.equal(existsSync(path.join(f.legacyDirectory, "state.json")), false);
    writeFileSync(path.join(f.directory, "cod.sock"), "socket-target-fixture");
    assert.equal(
      readFileSync(path.join(f.legacyDirectory, "cod.sock"), "utf8"),
      "socket-target-fixture",
    );
    const saved = readFileSync(
      path.join(f.directory, "profile-migration.json"),
      "utf8",
    );
    migrateProfile(f);
    assert.equal(
      readFileSync(path.join(f.directory, "profile-migration.json"), "utf8"),
      saved,
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
for (const step of ["renamed", "payload-restored"] as const)
  test(`interrupted ${step} resumes without duplicate data`, () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          migrateProfile({
            ...f,
            checkpoint: (where) => {
              if (where === step) throw new Error("invented interruption");
            },
          }),
        /interruption/,
      );
      assert.equal(existsSync(`${f.directory}.migration.json`), true);
      migrateProfile(f);
      assert.equal(existsSync(`${f.directory}.migration.json`), false);
      assert.equal(
        readFileSync(path.join(f.directory, "state.json"), "utf8"),
        '{"fixture":"preserved"}',
      );
      assert.equal(
        readdirSync(path.join(f.legacyDirectory, "browser-addons")).length,
        1,
      );
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  });
test("active legacy and conflicting target are refused without writes", () => {
  const f = fixture();
  try {
    assert.throws(
      () => migrateProfile({ ...f, probeLive: () => true }),
      /running Cod/,
    );
    assert.equal(existsSync(f.directory), false);
    mkdirSync(f.directory);
    writeFileSync(path.join(f.directory, "state.json"), "new-profile");
    assert.throws(() => migrateProfile(f), /two saved workspace profiles/g);
    assert.equal(
      readFileSync(path.join(f.directory, "state.json"), "utf8"),
      "new-profile",
    );
    assert.equal(
      readFileSync(path.join(f.legacyDirectory, "state.json"), "utf8"),
      '{"fixture":"preserved"}',
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test("directory symlinks and live Chromium owner locks are rejected", () => {
  const f = fixture();
  try {
    symlinkSync(f.legacyDirectory, f.directory);
    assert.throws(() => migrateProfile(f), /real directory/);
    symlinkSync(
      `${os.hostname()}-${process.pid}`,
      path.join(f.legacyDirectory, "chromium", "SingletonLock"),
    );
    assert.equal(profileIsLive(f.legacyDirectory), true);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test("explicit data/socket overrides stay byte-for-byte unchanged", () => {
  const data = process.env.COD_DATA_DIR,
    socket = process.env.COD_SOCKET_PATH;
  try {
    process.env.COD_DATA_DIR = "/invented custom profile";
    process.env.COD_SOCKET_PATH = "/invented custom socket";
    assert.equal(defaultDataDirectory(), process.env.COD_DATA_DIR);
    assert.equal(defaultSocketPath(), process.env.COD_SOCKET_PATH);
  } finally {
    if (data === undefined) delete process.env.COD_DATA_DIR;
    else process.env.COD_DATA_DIR = data;
    if (socket === undefined) delete process.env.COD_SOCKET_PATH;
    else process.env.COD_SOCKET_PATH = socket;
  }
});

test("completed migration refuses a legacy profile recreated by an older app", () => {
  const f = fixture();
  try {
    migrateProfile(f);
    const saved = readFileSync(path.join(f.directory, "state.json"), "utf8");
    writeFileSync(
      path.join(f.legacyDirectory, "state.json"),
      "recreated legacy state",
    );
    assert.throws(() => migrateProfile(f), /two saved workspace profiles/g);
    assert.equal(
      readFileSync(path.join(f.directory, "state.json"), "utf8"),
      saved,
    );
    assert.equal(
      readFileSync(path.join(f.legacyDirectory, "state.json"), "utf8"),
      "recreated legacy state",
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

for (const interrupted of [false, true])
  test(`incidental Chromium cache is archived intact${interrupted ? " across interruption" : ""}`, () => {
    const f = fixture();
    try {
      mkdirSync(path.join(f.directory, "Cache", "Cache_Data"), {
        recursive: true,
      });
      writeFileSync(
        path.join(f.directory, "Local State"),
        "invented root cache metadata",
      );
      writeFileSync(
        path.join(f.directory, "Cache", "Cache_Data", "data_0"),
        "invented bytes",
      );
      if (interrupted)
        assert.throws(
          () =>
            migrateProfile({
              ...f,
              checkpoint: (step) => {
                if (step === "cache-archived")
                  throw new Error("invented interruption");
              },
            }),
          /interruption/,
        );
      migrateProfile(f);
      const archives = readdirSync(f.parent).filter((name) =>
        name.startsWith("Cod-recovery-"),
      );
      assert.equal(archives.length, 1);
      assert.equal(
        readFileSync(path.join(f.parent, archives[0]!, "Local State"), "utf8"),
        "invented root cache metadata",
      );
      assert.equal(
        readFileSync(
          path.join(f.parent, archives[0]!, "Cache", "Cache_Data", "data_0"),
          "utf8",
        ),
        "invented bytes",
      );
      assert.equal(existsSync(path.join(f.directory, "Local State")), false);
      assert.equal(
        readFileSync(path.join(f.directory, "state.json"), "utf8"),
        '{"fixture":"preserved"}',
      );
      migrateProfile(f);
      assert.equal(
        readdirSync(f.parent).filter((name) => name.startsWith("Cod-recovery-"))
          .length,
        1,
      );
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  });
test("unknown target content is preserved and never classified as disposable cache", () => {
  const f = fixture();
  try {
    mkdirSync(f.directory);
    writeFileSync(
      path.join(f.directory, "important-document"),
      "invented important content",
    );
    assert.throws(
      () => migrateProfile(f),
      (error) =>
        error instanceof Error &&
        /two saved workspace profiles/.test(error.message) &&
        !/Restart|COD_DATA_DIR/.test(error.message),
    );
    assert.equal(
      readFileSync(path.join(f.directory, "important-document"), "utf8"),
      "invented important content",
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
