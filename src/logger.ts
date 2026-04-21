import pc from "picocolors";

export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogEvent = {
  ts: string;
  level: Level;
  message: string;
  /** Optional machine-friendly event name, e.g. "restart", "change", "hook". */
  event?: string;
  /** Arbitrary structured fields for --json mode. */
  fields?: Record<string, unknown>;
};

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  /** Structured event (emitted in JSON mode). In text mode renders as info with highlights. */
  event: (event: string, message: string, fields?: Record<string, unknown>) => void;
  /** Subscribe to every log event (used by status line + tests). */
  subscribe: (handler: (e: LogEvent) => void) => () => void;
};

const TAG = "monoripple";

function timestampIso(): string {
  return new Date().toISOString().slice(11, 23);
}

function timestampLocaleDim(): string {
  const s = new Date()
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })
    .toLowerCase();
  return pc.dim(s);
}

function stderrColorsEnabled(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "0") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  return Boolean(process.stderr.isTTY);
}

function colorizeMessage(message: string): string {
  let s = message;
  s = s.replace(
    /change detected in (.+?) → restarting…/,
    (_, rel: string) =>
      `change detected in ${pc.green(rel)} → ${pc.yellow("restarting…")}`,
  );
  s = s.replace(/\(cwd=([^)]+)\)/g, (_m, p: string) => `(cwd=${pc.green(p)})`);
  s = s.replace(/—\s*restarting…/g, () => `— ${pc.yellow("restarting…")}`);
  return s;
}

export type LoggerOptions = {
  verbose: boolean;
  json?: boolean;
  /**
   * When provided, messages are written through this function instead of
   * console.error. Used by the status line to pause/resume stderr while
   * the bottom row is being redrawn.
   */
  write?: (line: string) => void;
};

export function createLogger(options: LoggerOptions): Logger {
  const { verbose, json = false } = options;
  const color = !json && stderrColorsEnabled();
  const subs = new Set<(e: LogEvent) => void>();
  const write = options.write ?? ((line: string) => console.error(line));

  const emit = (
    level: Level,
    message: string,
    event?: string,
    fields?: Record<string, unknown>,
  ) => {
    if (level === "DEBUG" && !verbose) return;

    const ts = new Date().toISOString();
    const e: LogEvent = { ts, level, message, event, fields };
    for (const h of subs) {
      try { h(e); } catch { /* subscriber errors ignored */ }
    }

    if (json) {
      write(JSON.stringify(e));
      return;
    }

    const body = color ? colorizeMessage(message) : message;

    if (color) {
      const t = `${timestampLocaleDim()} `;
      const tag = pc.cyan(`[${TAG}]`);
      let lvl = "";
      if (level === "DEBUG") lvl = `${pc.dim("DEBUG")} `;
      else if (level === "WARN") lvl = `${pc.yellow("WARN")} `;
      else if (level === "ERROR") lvl = `${pc.red("ERROR")} `;
      write(`${t}${tag} ${lvl}${body}`);
      return;
    }

    const t = verbose ? `${timestampIso()} ` : "";
    const showLevel = verbose || level === "WARN" || level === "ERROR";
    const levelPart = showLevel ? `${level} ` : "";
    write(`${t}[${TAG}] ${levelPart}${body}`);
  };

  return {
    debug: (m, f) => emit("DEBUG", m, undefined, f),
    info: (m, f) => emit("INFO", m, undefined, f),
    warn: (m, f) => emit("WARN", m, undefined, f),
    error: (m, f) => emit("ERROR", m, undefined, f),
    event: (ev, m, f) => emit("INFO", m, ev, f),
    subscribe(h) {
      subs.add(h);
      return () => {
        subs.delete(h);
      };
    },
  };
}
