export interface BrowserDownload {
  id: string;
  url: string;
  basename: string;
  path?: string;
  status: "progressing" | "paused" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  canResume: boolean;
}
