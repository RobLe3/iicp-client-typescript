/**
 * Persistent node log writer — ~/.iicp/logs/<node_id>.log + events.jsonl.
 *
 * Two outputs:
 * - Human-readable rotating text log: `<node_id>.log`
 * - Structured NDJSON event stream:  `events.jsonl`
 *
 * Rotation triggers when a file exceeds MAX_LOG_BYTES (10 MiB);
 * up to MAX_ROTATIONS (3) generations are kept.
 * No credentials are written; callers MUST NOT pass tokens or keys.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_ROTATIONS = 3;

/** Resolve the log directory: IICP_LOG_DIR > ~/.iicp/logs/ */
export function resolveLogDir(): string {
  const env = process.env.IICP_LOG_DIR;
  if (env) return env;
  const base = process.env.IICP_HOME ?? path.join(os.homedir(), ".iicp");
  return path.join(base, "logs");
}

/** Append one event to both the text log and events.jsonl. */
export function writeNodeEvent(
  nodeId: string,
  event: string,
  details: string = "",
  logDirOverride?: string,
): void {
  const dir = logDirOverride ?? resolveLogDir();
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const textLine = `${ts} [${event}] node=${nodeId} ${details}\n`;
  const jsonlLine =
    JSON.stringify({ ts, event, node_id: nodeId, details }) + "\n";

  appendRotating(path.join(dir, `${nodeId}.log`), textLine);
  appendRotating(path.join(dir, "events.jsonl"), jsonlLine);
}

function appendRotating(filePath: string, data: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_LOG_BYTES) {
      rotate(filePath);
    }
  } catch {
    // File doesn't exist yet — that's fine.
  }
  fs.appendFileSync(filePath, data, "utf8");
}

function rotate(filePath: string): void {
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    try {
      fs.renameSync(from, to);
    } catch {
      /* ignore missing */
    }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* ignore missing */
  }
}
