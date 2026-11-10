import { contextBridge, ipcRenderer } from "electron";
const argument = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const channel = argument("cod-page-channel"),
  host = argument("cod-page-host"),
  entry = argument("cod-page-entry");
if (
  process.isMainFrame &&
  channel &&
  location.protocol === "cod-artifact:" &&
  location.host === host &&
  location.pathname === entry
) {
  let locked = false;
  const applyLock = (state: string | null) => {
    locked = state !== null;
    for (const element of document.querySelectorAll<
      | HTMLInputElement
      | HTMLButtonElement
      | HTMLTextAreaElement
      | HTMLSelectElement
    >("input,button,textarea,select")) {
      if (locked) {
        if (!element.disabled) {
          element.dataset.codDisabled = "true";
          element.disabled = true;
        }
      } else if (element.dataset.codDisabled) {
        element.disabled = false;
        delete element.dataset.codDisabled;
      }
    }
    document.documentElement.dataset.codSubmission = state ?? "";
  };
  new MutationObserver(() => {
    if (locked)
      applyLock(document.documentElement.dataset.codSubmission || "sending");
  }).observe(document, { childList: true, subtree: true });
  ipcRenderer.on("cod:page-submission", (_event, state: string | null) =>
    applyLock(state),
  );
  contextBridge.exposeInMainWorld("codPage", {
    submit: async (payload: unknown) => {
      if (locked)
        return {
          ok: false,
          error:
            "This page response is already submitted or awaiting confirmation.",
        };
      applyLock("sending");
      try {
        const result = await ipcRenderer.invoke(channel, payload);
        if (!result?.ok) applyLock(null);
        return result;
      } catch {
        applyLock("uncertain");
        return { ok: false, error: "Form response could not be submitted." };
      }
    },
  });
}
