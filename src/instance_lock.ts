// #405 — single-instance lock per node_id.
//
// Two `iicp-node serve` processes for the SAME node_id fight: each registration
// rotates the directory-issued token and invalidates the other's, so they enter
// a 401 -> re-register war that makes the node flap in the directory. This guard
// holds a pidfile at ~/.iicp/run/<node_id>.pid; a second LIVE process for the
// same node_id is refused (unless `force`). Distinct node_ids are unaffected —
// a fleet of N nodes runs fine (each has its own lock).
//
// Fail-open: any filesystem error degrades to a no-op lock — the guard must
// never prevent a node from starting.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function runDir(): string {
  const base = process.env.IICP_HOME || path.join(os.homedir(), ".iicp");
  return path.join(base, "run");
}

/** True if a process with `pid` exists. EPERM means it exists (we may not signal
 * it) — treat as alive to be safe; ESRCH means it's gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as { code?: string } | undefined)?.code === "EPERM";
  }
}

export class NodeAlreadyServingError extends Error {}

export class InstanceLock {
  private constructor(private _path: string | null) {}

  /** Acquire the per-node_id lock. Throws NodeAlreadyServingError if another LIVE
   * process holds it and `force` is false. Fails open on I/O error. */
  static acquire(nodeId: string, force = false): InstanceLock {
    let p: string;
    try {
      const dir = runDir();
      fs.mkdirSync(dir, { recursive: true });
      p = path.join(dir, `${nodeId}.pid`);
    } catch {
      return new InstanceLock(null); // fail open
    }
    if (!force && fs.existsSync(p)) {
      let pid: number | null = null;
      try {
        pid = parseInt(fs.readFileSync(p, "utf8").trim(), 10);
      } catch {
        pid = null;
      }
      if (pid !== null && !Number.isNaN(pid) && pid !== process.pid && pidAlive(pid)) {
        throw new NodeAlreadyServingError(
          `node_id ${nodeId} is already being served by PID ${pid}. ` +
            `Stop that process, choose a different --node, or pass --force to take over.`,
        );
      }
    }
    try {
      fs.writeFileSync(p, String(process.pid));
    } catch {
      return new InstanceLock(null);
    }
    return new InstanceLock(p);
  }

  release(): void {
    if (this._path) {
      try {
        fs.unlinkSync(this._path);
      } catch {
        /* ignore */
      }
    }
  }
}
