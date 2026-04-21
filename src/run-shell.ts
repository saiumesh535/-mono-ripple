import { spawn } from "node:child_process";
import pc from "picocolors";
import type { HookCommand } from "./cli-options";

export type RunHookOptions = {
  cwd: string;
  /** When set, stream stdout/stderr line-by-line with this prefix. Otherwise inherit. */
  prefix?: string;
};

/**
 * Run a hook. String form uses the shell (pipes, expansion, etc.).
 * Array form uses direct spawn without shell — no injection surface.
 * When `prefix` is set, output is piped and each line is tagged.
 */
export function runHookCommand(
  command: HookCommand,
  optsOrCwd: string | RunHookOptions,
): Promise<void> {
  const opts: RunHookOptions =
    typeof optsOrCwd === "string" ? { cwd: optsOrCwd } : optsOrCwd;
  const { cwd, prefix } = opts;
  return new Promise((resolve, reject) => {
    const useShell = typeof command === "string";
    const file = useShell ? (command as string) : (command as string[])[0];
    const args = useShell ? [] : (command as string[]).slice(1);
    if (!file) {
      reject(new Error("[monoripple] Empty hook command"));
      return;
    }
    const stdio = prefix ? "pipe" : "inherit";
    const subprocess = spawn(file, args, {
      cwd,
      stdio,
      shell: useShell,
      env: process.env,
    });
    if (prefix) {
      wirePrefixedStream(subprocess.stdout, process.stdout, prefix);
      wirePrefixedStream(subprocess.stderr, process.stderr, prefix);
    }
    subprocess.on("error", reject);
    subprocess.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command exited with code ${code}`));
    });
  });
}

function wirePrefixedStream(
  src: NodeJS.ReadableStream | null,
  dst: NodeJS.WritableStream,
  prefix: string,
): void {
  if (!src) return;
  let buf = "";
  const tag = pc.dim(`[${prefix}]`);
  src.setEncoding?.("utf8");
  src.on("data", (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      dst.write(`${tag} ${line}\n`);
    }
  });
  src.on("end", () => {
    if (buf.length > 0) dst.write(`${tag} ${buf}\n`);
  });
}

export function formatHook(cmd: HookCommand): string {
  return typeof cmd === "string" ? cmd : cmd.map(quoteArg).join(" ");
}

function quoteArg(a: string): string {
  if (a === "") return "''";
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(a)) return a;
  return `'${a.replace(/'/g, "'\\''")}'`;
}

export const runShellCommand = (command: HookCommand, cwd: string) =>
  runHookCommand(command, cwd);
