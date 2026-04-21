import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-config acknowledgement that the user trusts the hook commands in this
 * specific config file. Stored in ~/.cache/monoripple/acks.json, keyed
 * by a hash of the absolute config path + hook bodies. Any change to the
 * hooks invalidates the ack and re-prompts.
 */
type AckStore = { [fingerprint: string]: { path: string; at: string } };

function storeDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "monoripple");
}

function storePath(): string {
  return path.join(storeDir(), "acks.json");
}

function readStore(): AckStore {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AckStore;
    }
  } catch {
    /* no ack store yet */
  }
  return {};
}

function writeStore(store: AckStore): void {
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

/**
 * Hash = SHA-256 of "<absolute config path>\n<hookBodiesJson>" to avoid
 * conflating two repos that share a path segment, and to invalidate on any
 * hook edit.
 */
export function hookFingerprint(
  configAbsPath: string,
  hookBodies: unknown,
): string {
  return crypto
    .createHash("sha256")
    .update(`${configAbsPath}\n${JSON.stringify(hookBodies)}`)
    .digest("hex");
}

export function isAcked(fingerprint: string): boolean {
  const store = readStore();
  return Object.prototype.hasOwnProperty.call(store, fingerprint);
}

export function recordAck(
  fingerprint: string,
  configAbsPath: string,
): void {
  const store = readStore();
  store[fingerprint] = { path: configAbsPath, at: new Date().toISOString() };
  writeStore(store);
}
