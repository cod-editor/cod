import path from "node:path";
import { Worker } from "node:worker_threads";
import type { WorkspaceDatabaseRequest } from "./sqlite-state-worker.ts";
import { workspaceDatabaseFile } from "./sqlite-state-rows.ts";

export class WorkspaceDatabase {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  private connection() {
    if (this.worker) return this.worker;
    const worker = new Worker(
      path.join(
        import.meta.dirname,
        import.meta.filename.endsWith(".cjs")
          ? "sqlite-state-worker.cjs"
          : "sqlite-state-worker.ts",
      ),
      { workerData: path.join(this.directory, workspaceDatabaseFile) },
    );
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) =>
      fail(new Error(`Workspace database worker exited (${code})`)),
    );
    worker.on(
      "message",
      ({
        id,
        error,
        value,
      }: {
        id: number;
        error?: string;
        value: unknown;
      }) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        if (error) pending.reject(new Error(error));
        else pending.resolve(value);
      },
    );
    this.worker = worker;
    return worker;
  }

  request<T>(request: WorkspaceDatabaseRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = this.connection();
      const id = ++this.next;
      worker.ref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage({ id, request });
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(error);
      }
    });
  }

  async close() {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.request({ operation: "close" });
    } finally {
      this.worker = undefined;
      await worker.terminate();
    }
  }
}
