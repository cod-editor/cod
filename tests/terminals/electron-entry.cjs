// Test-only Electron entry. The application never imports this experimental dependency.
const { app } = require("electron");
const { chmodSync, existsSync } = require("node:fs");
const path = require("node:path");
const nativeRoot = process.env.COD_TEST_PTY_ROOT;
const suite = process.env.COD_TEST_TERMINAL_SUITE;
if (!nativeRoot || !suite)
  throw new Error("Missing isolated terminal test paths");
const helper = path.join(
  nativeRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
if (process.platform === "darwin" && existsSync(helper))
  chmodSync(helper, 0o755);
const native = require(nativeRoot);
app
  .whenReady()
  .then(async () => {
    const { runTerminalAcceptance } = require(suite);
    const result = await runTerminalAcceptance((executable, args, options) =>
      native.spawn(executable, args, options),
    );
    console.log(JSON.stringify(result));
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error.stack ?? error.message);
      app.exit(1);
    },
  );
