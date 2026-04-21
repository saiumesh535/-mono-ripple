import pc from "picocolors";
import type { Logger } from "./logger";

export type KeypressActions = {
  restart: () => void;
  restartWithBefore: () => void;
  printInfo: () => void;
  toggleVerbose: () => void;
  togglePause: () => void;
  clearScreen: () => void;
  quit: () => void;
};

export type KeypressController = {
  stop: () => void;
  enabled: boolean;
};

const HELP_LINES = [
  "  r  restart now",
  "  b  restart (running --before)",
  "  d  print watch roots + deps",
  "  v  toggle verbose logs",
  "  p  pause / resume file watching",
  "  c  clear screen",
  "  ?  this help",
  "  q  quit (Ctrl+C also works)",
];

/**
 * Attach raw-mode keypress listener to stdin and map single keys to actions.
 * Only activates when `options.enabled` is true AND stdin is a TTY.
 * When inactive, returns a no-op controller so callers don't branch.
 */
export function createKeypressController(options: {
  enabled: boolean;
  logger: Logger;
  actions: KeypressActions;
}): KeypressController {
  const tty =
    options.enabled && process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (!tty) {
    return { stop: () => {}, enabled: false };
  }

  const { logger, actions } = options;

  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
    // Ctrl+C
    if (s === "\x03") {
      actions.quit();
      return;
    }
    const key = s.length === 1 ? s : s[0] ?? "";
    switch (key) {
      case "r":
        actions.restart();
        break;
      case "b":
        actions.restartWithBefore();
        break;
      case "d":
        actions.printInfo();
        break;
      case "v":
        actions.toggleVerbose();
        break;
      case "p":
        actions.togglePause();
        break;
      case "c":
        actions.clearScreen();
        break;
      case "q":
        actions.quit();
        break;
      case "?":
      case "h":
        logger.info(pc.bold("keybindings:"));
        for (const line of HELP_LINES) logger.info(line);
        break;
      default:
        break;
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);

  logger.debug("interactive keypress UI ready — press ? for help");

  return {
    enabled: true,
    stop() {
      process.stdin.off("data", onData);
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
    },
  };
}
