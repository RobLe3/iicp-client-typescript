// SPDX-License-Identifier: Apache-2.0
/**
 * Self-updater P1 — read-only version check (#521 WQ-089).
 * TypeScript parity with iicp-client-python/updater.py.
 *
 * Inert by design: reports whether a newer release exists and prints the
 * upgrade command. No download/install/restart (P2/P3). Zero risk surface.
 */

const NPM_URL = "https://registry.npmjs.org/@iicp/client/latest";

/** Parse a dotted version into a comparable tuple; truncate at the first
 * non-numeric segment ('1.2.3-rc1' → [1,2,3]). */
export function parseVersion(v: string): number[] {
  const out: number[] = [];
  for (const part of v.trim().replace(/^[vV]/, "").split(".")) {
    const m = /^\d+/.exec(part);
    if (!m) break;
    out.push(parseInt(m[0], 10));
  }
  return out;
}

/** True when `latest` is strictly newer than `current` (numeric, not lex). */
export function isOutdated(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/** Fetch @iicp/client's latest published version, or null on any error. */
export async function latestNpmVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(NPM_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export interface UpdateVerdict {
  current: string;
  latest: string | null;
  outdated: boolean;
  command: string;
}

export function checkUpdate(current: string, latest: string | null): UpdateVerdict {
  return {
    current,
    latest,
    outdated: latest !== null && isOutdated(current, latest),
    command: "npm install -g @iicp/client@latest",
  };
}
