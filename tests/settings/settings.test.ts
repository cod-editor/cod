import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SettingsService } from "../../src/application/settings-service.ts";
import {
  ClaudeApiSettings,
  type ClaudeApiCrypto,
} from "../../src/application/claude-api-settings.ts";
import { validateSettings } from "../../src/settings.ts";
test("settings reject unknown, unsafe and invalid values", () => {
  for (const value of [
    [],
    null,
    { other: 1 },
    { "terminal.cursorStyle": "bad" },
    { "workspace.defaultHost": "remote" },
    { "terminal.scrollback": -1 },
    { "ui.fontFamily": "x; color:red" },
    { "editor.tabSize": 2.5 },
  ])
    assert.throws(() => validateSettings(value));
  assert.deepEqual(
    validateSettings({
      "terminal.cursorStyle": "bar",
      "terminal.cursorBlink": true,
    }),
    { "terminal.cursorStyle": "bar", "terminal.cursorBlink": true },
  );
});

function fixtureCrypto() {
  const key = randomBytes(32);
  let locked = false;
  const crypto: ClaudeApiCrypto = {
    async isAsyncEncryptionAvailable() {
      return !locked;
    },
    async encryptStringAsync(value) {
      if (locked) throw new Error("invented Keychain denial");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(bytes) {
      if (locked) throw new Error("invented Keychain denial");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      const body = cipher.update(bytes.subarray(28));
      return { result: Buffer.concat([body, cipher.final()]).toString("utf8") };
    },
  };
  return {
    crypto,
    setLocked: (value: boolean) => {
      locked = value;
    },
  };
}

test("Claude API route preserves native mode by default and persists only an encrypted local route", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-claude-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { crypto } = fixtureCrypto();
  const settings = new ClaudeApiSettings(directory, crypto);
  const inherited = {
    CODE_TEST_UNRELATED: "preserved",
    ANTHROPIC_BASE_URL: "https://inherited.example",
    ANTHROPIC_API_KEY: "invented-api-key",
    ANTHROPIC_CUSTOM_HEADERS: "invented-header",
    CLAUDE_CODE_OAUTH_TOKEN: "invented-oauth-token",
    CLAUDE_CODE_USE_VERTEX: "1",
  };
  assert.deepEqual(await settings.command({ action: "status" }), {
    kind: "native",
  });
  assert.strictEqual(await settings.environment(inherited), inherited);
  const endpoint = "https://gateway.example/path/api";
  const token = "invented-route-secret";
  assert.deepEqual(
    await settings.command({ action: "save", endpoint, token }),
    {
      kind: "saved",
      endpoint,
    },
  );
  assert.equal(settings.revision, 1);
  const file = path.join(directory, "claude-api.enc");
  const stored = await readFile(file);
  assert.equal(stored.includes(endpoint), false);
  assert.equal(stored.includes(token), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = new ClaudeApiSettings(directory, crypto);
  assert.deepEqual(await restarted.command({ action: "status" }), {
    kind: "saved",
    endpoint,
  });
  assert.deepEqual(await restarted.environment(inherited), {
    CODE_TEST_UNRELATED: "preserved",
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_AUTH_TOKEN: token,
  });
  assert.equal(inherited.ANTHROPIC_API_KEY, "invented-api-key");
  assert.deepEqual(await restarted.command({ action: "remove" }), {
    kind: "native",
  });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.strictEqual(await restarted.environment(inherited), inherited);
});

test("Claude API route rejects unsafe or incomplete changes and never falls back from a locked saved route", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-claude-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { crypto, setLocked } = fixtureCrypto();
  const settings = new ClaudeApiSettings(directory, crypto);
  const unavailable = new ClaudeApiSettings(directory);
  const endpoint = "https://gateway.example/";
  const token = "invented-token";
  assert.deepEqual(await unavailable.command({ action: "status" }), {
    kind: "unavailable",
  });
  await assert.rejects(
    unavailable.command({ action: "save", endpoint, token }),
    /unavailable/,
  );
  await settings.command({ action: "save", endpoint, token });
  const file = path.join(directory, "claude-api.enc");
  const saved = await readFile(file);
  for (const invalid of [
    "http://outside.example/",
    "https://with-credentials@gateway.example/",
    "https://gateway.example/?invented=token",
    "https://gateway.example/#",
    "https://gateway.example/" + String.fromCharCode(92) + "path",
  ])
    await assert.rejects(
      settings.command({ action: "save", endpoint: invalid, token }),
      /HTTPS API URL/,
    );
  await assert.rejects(
    settings.command({
      action: "save",
      endpoint: "https://new.example",
      token: "",
    }),
    /valid API token/,
  );
  setLocked(true);
  assert.deepEqual(await settings.command({ action: "status" }), {
    kind: "locked",
  });
  await assert.rejects(
    settings.environment({ ANTHROPIC_API_KEY: "invented-inherited-key" }),
    /Keychain/,
  );
  await assert.rejects(
    settings.command({ action: "save", endpoint, token }),
    /Keychain/,
  );
  assert.deepEqual(await readFile(file), saved);
  setLocked(false);
  assert.deepEqual(await settings.command({ action: "status" }), {
    kind: "saved",
    endpoint,
  });
  const other = path.join(directory, "other");
  await writeFile(other, saved, { mode: 0o600 });
  await rm(file);
  await symlink(other, file);
  assert.deepEqual(await settings.command({ action: "status" }), {
    kind: "locked",
  });
  await assert.rejects(settings.environment({}), /Keychain/);
  await settings.command({ action: "remove" });
  assert.deepEqual(await readFile(other), saved);
});

test("Linux Claude API storage rejects fallback, unknown and forced basic keyrings", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cod-claude-keyring-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { crypto } = fixtureCrypto();
  let tag = "v10";
  let failedAfterProbe = false;
  let lastEncrypted = "";
  let decryptions = 0;
  const linuxCrypto: ClaudeApiCrypto = {
    ...crypto,
    async encryptStringAsync(value) {
      lastEncrypted = value;
      const actualTag = failedAfterProbe && value.startsWith("{") ? "v10" : tag;
      return Buffer.concat([
        Buffer.from(actualTag),
        await crypto.encryptStringAsync(value),
      ]);
    },
    async decryptStringAsync(value) {
      decryptions++;
      return crypto.decryptStringAsync(value.subarray(3));
    },
  };
  const file = path.join(directory, "claude-api.enc");
  const auth = new ClaudeApiSettings(directory, linuxCrypto, "linux-keyring");
  const disabled = new ClaudeApiSettings(
    directory,
    linuxCrypto,
    "disabled-linux-keyring",
  );
  const payload = {
    action: "save",
    endpoint: "https://gateway.example/",
    token: "invented-token",
  } as const;
  for (const weak of ["v10", "v99"]) {
    tag = weak;
    assert.deepEqual(await auth.command({ action: "status" }), {
      kind: "unavailable",
    });
    await assert.rejects(auth.command(payload), /unavailable/);
    assert.equal(lastEncrypted.includes(payload.token), false);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  }
  tag = "v11";
  assert.deepEqual(await auth.command({ action: "status" }), {
    kind: "native",
  });
  for (const protectedTag of ["v11", "v12"]) {
    tag = protectedTag;
    await auth.command(payload);
    const before = await readFile(file);
    assert.equal(before.toString("latin1", 0, 3), protectedTag);
    assert.equal(
      await auth
        .environment({})
        .then(
          (environment) => environment.ANTHROPIC_AUTH_TOKEN === payload.token,
        ),
      true,
    );
    assert.deepEqual(await disabled.command({ action: "status" }), {
      kind: "locked",
    });
    await assert.rejects(disabled.environment({}), /keyring/);
    failedAfterProbe = true;
    await assert.rejects(auth.command(payload), /unavailable/);
    assert.deepEqual(await readFile(file), before);
    failedAfterProbe = false;
  }
  const validBody = (await readFile(file)).subarray(3);
  const calls = decryptions;
  await writeFile(file, Buffer.concat([Buffer.from("v10"), validBody]));
  assert.deepEqual(await auth.command({ action: "status" }), {
    kind: "locked",
  });
  await assert.rejects(
    auth.environment({ ANTHROPIC_API_KEY: "invented-inherited-token" }),
    /keyring/,
  );
  assert.equal(decryptions, calls);
});

test("settings preserve last good values, reject overwrite of broken JSON, serialize updates and reset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-settings-"));
  try {
    const settings = new SettingsService(directory);
    await settings.load();
    assert.equal(settings.state.values["workspace.defaultHost"], "local");
    await Promise.all([
      settings.update({ "workspace.defaultHost": "linux" }),
      settings.update({ "ui.fontSize": 20 }),
      settings.update({ "terminal.cursorStyle": "bar" }),
    ]);
    assert.equal(settings.state.values["ui.fontSize"], 20);
    assert.equal(settings.state.values["terminal.cursorStyle"], "bar");
    assert.equal(settings.state.values["workspace.defaultHost"], "linux");
    await writeFile(settings.state.path, "invalid");
    await settings.load();
    assert.ok(settings.state.error);
    assert.equal(settings.state.values["ui.fontSize"], 20);
    assert.equal(settings.state.values["workspace.defaultHost"], "linux");
    await assert.rejects(settings.update({ "ui.fontSize": 14 }));
    assert.equal(await readFile(settings.state.path, "utf8"), "invalid");
    await writeFile(
      settings.state.path,
      '{"terminal.cursorStyle":"underline"}',
    );
    await settings.load();
    assert.equal(settings.state.error, undefined);
    assert.equal(settings.state.values["terminal.cursorStyle"], "underline");
    await settings.update({}, true);
    assert.equal(settings.state.values["ui.fontSize"], 14);
    assert.deepEqual(
      JSON.parse(await readFile(settings.state.path, "utf8")),
      {},
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
