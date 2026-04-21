import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import treeKill from "tree-kill";

export type DevRunnerOptions = {
  cwd: string;
  command: string[];
  /** Run `command[0]` as a single shell line (for `npm run dev`-style strings). */
  shell?: boolean;
  /**
   * When true, pass 'ignore' for stdin so the parent can own the terminal
   * for an interactive keypress UI. Stdout/stderr still inherit.
   */
  detachStdin?: boolean;
  killTimeoutMs?: number;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) {
        treeKill(pid, "SIGKILL", (err2) => {
          if (err2) reject(err2);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Runs a child process; supports graceful tree-kill restarts.
 */
export class DevRunner {
  private child: ChildProcess | null = null;
  private shuttingDown = false;
  private intentionalStop = false;
  private readonly killTimeoutMs: number;

  constructor(private readonly options: DevRunnerOptions) {
    this.killTimeoutMs = options.killTimeoutMs ?? 10_000;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    this.intentionalStop = false;
    const stdio: StdioOptions = this.options.detachStdin
      ? ["ignore", "inherit", "inherit"]
      : "inherit";
    const child = this.options.shell
      ? (() => {
          const line = this.options.command[0];
          if (!line) throw new Error("[monoripple] Empty command.");
          return spawn(line, {
            cwd: this.options.cwd,
            stdio,
            env: process.env,
            shell: true,
          });
        })()
      : (() => {
          const [cmd, ...args] = this.options.command;
          if (!cmd) throw new Error("[monoripple] Empty command.");
          return spawn(cmd, args, {
            cwd: this.options.cwd,
            stdio,
            env: process.env,
            shell: false,
          });
        })();
    this.child = child;
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.intentionalStop && !this.shuttingDown) {
        this.options.onExit({ code, signal });
      }
    });
  }

  async stopForRestart(): Promise<void> {
    const proc = this.child;
    if (!proc || proc.pid === undefined) return;
    this.intentionalStop = true;
    const exitPromise = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });
    await killProcessTree(proc.pid);
    await Promise.race([
      exitPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("[monoripple] Child did not exit in time")),
          this.killTimeoutMs,
        ),
      ),
    ]).catch(() => { /* force path already attempted */ });
    this.intentionalStop = false;
    this.child = null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const proc = this.child;
    if (proc?.pid !== undefined) {
      this.intentionalStop = true;
      await killProcessTree(proc.pid);
    }
    this.child = null;
  }
}
