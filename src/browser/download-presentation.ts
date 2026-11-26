import type { BrowserDownload } from "./download-types";

export type DownloadAction =
  "pause" | "resume" | "cancel" | "retry" | "remove" | "open" | "reveal";

export interface DownloadRow {
  id: string;
  basename: string;
  status: BrowserDownload["status"];
  receivedBytes: number;
  totalBytes: number;
  actions: DownloadAction[];
}

export interface DownloadPopup {
  id: string;
  revision: number;
  bounds: { x: number; y: number; width: number; height: number };
  fontSize: string;
  fontFamily: string;
}

export const downloadActions: Record<
  DownloadAction,
  { label: string; short: string }
> = {
  pause: { label: "Pause", short: "Pause" },
  resume: { label: "Resume", short: "Resume" },
  cancel: { label: "Cancel", short: "Cancel" },
  retry: { label: "Retry", short: "Retry" },
  remove: { label: "Remove from list", short: "Remove" },
  open: { label: "Open", short: "Open" },
  reveal: { label: "Show in folder", short: "Show in folder" },
};

export function downloadRows(entries: BrowserDownload[]): DownloadRow[] {
  return entries.map(
    ({ id, basename, status, receivedBytes, totalBytes, url }) => {
      const actions: DownloadAction[] =
        status === "progressing"
          ? ["pause", "cancel"]
          : status === "paused"
            ? ["resume", "cancel"]
            : status === "completed"
              ? ["open", "reveal", "remove"]
              : /^https?:/.test(url)
                ? ["retry", "remove"]
                : ["remove"];
      return { id, basename, status, receivedBytes, totalBytes, actions };
    },
  );
}

export function downloadProgress(entries: BrowserDownload[]): {
  fraction?: number;
  count: number;
} {
  const active = entries.filter(({ status }) => status === "progressing");
  if (!active.length || active.some(({ totalBytes }) => totalBytes <= 0))
    return { count: active.length };
  const total = active.reduce((sum, item) => sum + item.totalBytes, 0);
  const received = active.reduce((sum, item) => sum + item.receivedBytes, 0);
  return {
    count: active.length,
    fraction: Math.max(0, Math.min(1, received / total)),
  };
}
