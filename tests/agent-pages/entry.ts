import { app, BrowserWindow, session } from "electron";
import {
  AgentPageService,
  registerAgentPageScheme,
} from "../../src/agent-pages/index";
registerAgentPageScheme();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadURL("about:blank");
  const submissions: unknown[] = [];
  const service = new AgentPageService({
    window,
    session: session.fromPartition("invented-agent-pages"),
    preloadPath: process.env.COD_AGENT_PRELOAD!,
    onSubmit: async (value: unknown) => {
      if ((value as any).payload?.fail)
        throw new Error("PRIVATE_BACKEND_SENTINEL");
      submissions.push(value);
    },
  });
  Object.assign(globalThis, { agentFixture: { window, service, submissions } });
});
