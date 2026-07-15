/** DNS-aware provider endpoint validation and connection pinning (#667). */

import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

const BLOCKED_SUFFIXES = [".local", ".internal", ".lan", ".test", ".invalid", ".localhost"];
const blocked = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as Array<[string, number]>) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as Array<[string, number]>) blocked.addSubnet(network, prefix, "ipv6");

export function privateEndpointsAllowed(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES ?? "").trim().toLowerCase(),
  );
}

export function hostnameAllowed(host: string, allowPrivate = false): boolean {
  if (!host) return false;
  if (allowPrivate) return true;
  const normalized = host.replace(/\.$/, "").toLowerCase();
  if (["localhost", "0.0.0.0", "::1", "::"].includes(normalized)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  return isIP(normalized) !== 0 || normalized.includes(".") || normalized.includes(":");
}

export function addressAllowed(address: string, allowPrivate = false): boolean {
  if (allowPrivate) return true;
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, "ipv4");
  const dottedMapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dottedMapped) return addressAllowed(dottedMapped[1], false);
  if (/^::ffff:/i.test(address)) return false; // conservatively refuse hexadecimal mapped forms
  return !blocked.check(address, "ipv6");
}

export interface ResolvedEndpoint {
  url: URL;
  host: string;
  port: number;
  addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>;
}

export async function resolveEndpoint(url: string, allowPrivate = privateEndpointsAllowed()): Promise<ResolvedEndpoint> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("IICP-ENDPOINT-REFUSED: invalid provider URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("IICP-ENDPOINT-REFUSED: provider endpoint must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("IICP-ENDPOINT-REFUSED: provider endpoint must not contain user info");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostnameAllowed(host, allowPrivate)) {
    throw new Error("IICP-ENDPOINT-REFUSED: provider hostname is prohibited by network policy");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  let answers: Array<{ address: string; family: 4 | 6 }>;
  const literalFamily = isIP(host);
  if (literalFamily) {
    answers = [{ address: host, family: literalFamily as 4 | 6 }];
  } else {
    try {
      answers = await dnsLookup(host, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>;
    } catch {
      throw new Error("IICP-ENDPOINT-REFUSED: provider hostname resolution failed");
    }
  }
  const unique = [...new Map(answers.map((answer) => [`${answer.family}:${answer.address}`, answer])).values()];
  if (unique.length === 0) throw new Error("IICP-ENDPOINT-REFUSED: provider hostname returned no addresses");
  if (unique.some((answer) => !addressAllowed(answer.address, allowPrivate))) {
    throw new Error("IICP-ENDPOINT-REFUSED: provider hostname resolved to a prohibited address");
  }
  return { url: parsed, host, port, addresses: unique };
}

export interface PinnedResponse { status: number; headers: http.IncomingHttpHeaders; text: string }

export async function postJsonPinned(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  tlsVerify = true,
  redirectCount = 0,
): Promise<PinnedResponse> {
  const endpoint = await resolveEndpoint(url);
  const selected = endpoint.addresses[0];
  const payload = JSON.stringify(body);
  const requestHeaders = { ...headers, "Content-Length": String(Buffer.byteLength(payload)) };
  const transport = endpoint.url.protocol === "https:" ? https : http;
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, selected.address, selected.family);
  };
  const response = await new Promise<PinnedResponse>((resolve, reject) => {
    const req = transport.request({
      protocol: endpoint.url.protocol,
      hostname: endpoint.host,
      port: endpoint.port,
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: "POST",
      headers: requestHeaders,
      servername: endpoint.host,
      rejectUnauthorized: tlsVerify,
      agent: false,
      lookup: pinnedLookup,
    }, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(payload);
  });
  if (response.status === 307 || response.status === 308) {
    const location = response.headers.location;
    if (!location || redirectCount >= 3) throw new Error("IICP-ENDPOINT-REFUSED: provider redirect limit exceeded or omitted Location");
    const next = new URL(location, endpoint.url);
    if (next.origin !== endpoint.url.origin) throw new Error("IICP-ENDPOINT-REFUSED: cross-origin provider redirect is not allowed");
    return postJsonPinned(next.toString(), body, headers, timeoutMs, tlsVerify, redirectCount + 1);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("IICP-ENDPOINT-REFUSED: provider redirect method is not allowed");
  }
  return response;
}
