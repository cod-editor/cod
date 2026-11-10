import { app, BrowserWindow, session } from "electron";
import { BrowserService } from "../../src/browser/index";
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadURL("about:blank");
  const browserSession = session.fromPartition(
    "persist:invented-browser-fixture",
  );
  const service = new BrowserService({
    window,
    session: browserSession,
    downloadDirectory: process.env.COD_BROWSER_DOWNLOADS!,
  });
  Object.assign(globalThis, {
    browserFixture: { window, service, events: [] },
  });
  service.onEvent((event: unknown) =>
    (globalThis as any).browserFixture.events.push(event),
  );
});
