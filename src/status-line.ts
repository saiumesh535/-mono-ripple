import pc from "picocolors";

export type StatusState =
  | { kind: "starting" }
  | { kind: "running"; since: number }
  | { kind: "building"; pkg: string }
  | { kind: "restarting"; path?: string }
  | { kind: "paused" }
  | { kind: "crashed"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "shutdown" };

export type StatusLine = {
  set: (state: StatusState) => void;
  setWatchCount: (n: number) => void;
  incRestarts: () => void;
  stop: () => void;
  /** Render helper: called by Logger.write to print above the status line. */
  withPrint: (line: string) => string;
  enabled: () => boolean;
};

function clearLine() {
  return "\x1b[2K\r";
}
function hideCursor() {
  process.stderr.write("\x1b[?25l");
}
function showCursor() {
  process.stderr.write("\x1b[?25h");
}

/**
 * A bottom-anchored status line rendered on stderr using cursor tricks.
 * When disabled (non-TTY, --no-status, --json), all methods no-op and
 * withPrint returns the input unchanged.
 */
export function createStatusLine(options: {
  enabled: boolean;
}): StatusLine {
  const enabled = options.enabled && Boolean(process.stderr.isTTY);
  let state: StatusState = { kind: "starting" };
  let watchCount = 0;
  let restarts = 0;
  let rendered = false;
  let stopped = false;

  const render = () => {
    if (!enabled || stopped) return;
    const text = formatStatus(state, watchCount, restarts);
    const out = `${clearLine()}${text}`;
    process.stderr.write(out);
    rendered = true;
  };

  const clearRendered = () => {
    if (rendered) {
      process.stderr.write(clearLine());
      rendered = false;
    }
  };

  if (enabled) {
    hideCursor();
    render();
    const onExit = () => {
      stopped = true;
      clearRendered();
      showCursor();
    };
    process.once("exit", onExit);
  }

  return {
    set(s) {
      state = s;
      render();
    },
    setWatchCount(n) {
      watchCount = n;
      render();
    },
    incRestarts() {
      restarts += 1;
      render();
    },
    stop() {
      stopped = true;
      clearRendered();
      if (enabled) showCursor();
    },
    withPrint(line) {
      if (!enabled || stopped) return line;
      clearRendered();
      // Caller writes their line to stderr, then we re-render beneath.
      queueMicrotask(() => render());
      return line;
    },
    enabled: () => enabled,
  };
}

function formatStatus(
  state: StatusState,
  watchCount: number,
  restarts: number,
): string {
  const head = (() => {
    switch (state.kind) {
      case "starting":
        return pc.yellow("● starting");
      case "running": {
        const s = Math.round((Date.now() - state.since) / 1000);
        return pc.green(`● running`) + pc.dim(` · up ${formatDuration(s)}`);
      }
      case "building":
        return pc.yellow(`● building ${state.pkg}`);
      case "restarting":
        return pc.yellow(
          `● restarting${state.path ? pc.dim(` · ${truncate(state.path, 40)}`) : ""}`,
        );
      case "paused":
        return pc.magenta("● paused");
      case "crashed":
        return pc.red(
          `● crashed (code=${state.code ?? "-"}${state.signal ? `, signal=${state.signal}` : ""})`,
        );
      case "shutdown":
        return pc.dim("● shutdown");
    }
  })();

  const tail =
    pc.dim(
      ` · ${watchCount} dep${watchCount === 1 ? "" : "s"} · ${restarts} restart${restarts === 1 ? "" : "s"}`,
    );

  return head + tail + pc.dim(" · press ? for help");
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…${s.slice(s.length - n + 1)}`;
}
