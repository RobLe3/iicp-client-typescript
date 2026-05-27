// SPDX-License-Identifier: Apache-2.0
/**
 * UPnP NAT detection + dual-port mapping (ADR-041 tier-0 + tier-1).
 *
 * TypeScript port of iicp-client-python's nat_detection.py (iter-1420).
 * Operator-facing semantics + diagnostic improvements are identical:
 *
 *   - Tier 0 — operator-configured public endpoint, validated against the
 *              same `looksRoutable` heuristics the directory's RoutableEndpoint
 *              validator applies. Falls through to tier 1 when non-routable.
 *   - Tier 1 — UPnP via `nat-upnp`: discover IGD, request port mappings for
 *              HTTP control AND native IICP transport (spec v0.7.0), return
 *              a NatProfile carrying both URLs.
 *   - Tier 4 — unreachable: operator gets actionable guidance.
 *
 * Includes:
 *   - CGNAT reverse-DNS heuristic (#339) — detects DS-Lite carriers like
 *     NetCologne whose WAN IP looks public (89.x) but is CGNAT'd; the
 *     hostname `cgn-89-1-216-20.nc.de` is the smoking gun.
 *   - External-IP probe fallback (#331 Phase A) — when UPnP AddPortMapping
 *     succeeds but the IGD refuses to report the WAN IP, the detector
 *     fetches the WAN IP from an operator-configured HTTPS probe URL.
 *
 * `nat-upnp` is an optional peer dependency. Without it `detectNat()` returns
 * tier 4 with a clear "npm install nat-upnp" message instead of crashing.
 */

import * as dns from "node:dns";
import * as net from "node:net";

// ── Public types ─────────────────────────────────────────────────────────────

/** ADR-043 §4 — IPv6 qualification result (#342, #343). */
export interface Ipv6Profile {
  globalV6Available: boolean;
  stableV6Available: boolean;
  addresses: string[];
  /** Can the SDK bind a v6 socket on the requested port? */
  listenerV6Ok: boolean;
  /** Outbound v6 connectivity test result (does NOT prove inbound). */
  externalV6Reachable: boolean;
  /** ADR-043 §5 — true iff router accepted WANIPv6FirewallControl::AddPinhole. */
  pinholeActive?: boolean;
  /** UPnP UniqueID returned by AddPinhole — pass to deleteIpv6Pinhole() on shutdown. */
  pinholeUniqueId?: number;
  /** Granted lease (seconds). 0 = permanent / refresh required by spec. */
  pinholeLeaseSeconds?: number;
  /** Echoes GetFirewallStatus::InboundPinholeAllowed. */
  pinholeInboundAllowed?: boolean;
  error?: string;
}

export interface NatProfile {
  tier: number; // 0..4 per ADR-041
  transportMethod:
    | "direct"
    | "upnp_mapped"
    | "stun_hole_punch"
    | "turn_relay"
    | "external_tunnel"
    | "unreachable";
  publicEndpoint?: string; // HTTP control plane URL ("http://<wan>:<port>")
  transportEndpoint?: string; // native IICP URL ("iicp://<wan>:9484") per spec v0.7.0
  internalEndpoint?: string;
  operatorGuidance?: string;
  detectionLog: string[];
  /** ADR-043 §4 — populated when detectNat is called with detectV6: true. */
  ipv6?: Ipv6Profile;
  isReachable(): boolean;
}

function newProfile(tier: number, method: NatProfile["transportMethod"]): NatProfile {
  return {
    tier,
    transportMethod: method,
    detectionLog: [],
    isReachable() {
      return this.tier <= 3 && !!this.publicEndpoint;
    },
  };
}

export interface DetectNatOptions {
  bindHost: string;
  bindPort: number;
  operatorPublicEndpoint?: string;
  upnpLeaseSeconds?: number;
  timeoutMs?: number;
  externalIpProbeUrl?: string;
  transportPort?: number;
  /** ADR-043 §4 — run detectIpv6() in parallel. Default true. */
  detectV6?: boolean;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function detectNat(opts: DetectNatOptions): Promise<NatProfile> {
  const {
    bindHost,
    bindPort,
    operatorPublicEndpoint,
    upnpLeaseSeconds = 3600,
    timeoutMs = 5000,
    externalIpProbeUrl,
    transportPort,
    detectV6 = true,
  } = opts;

  const profile = newProfile(4, "unreachable");
  profile.internalEndpoint = `http://${bindHost}:${bindPort}`;

  // ADR-043 §4 — IPv6 qualification runs in parallel to the v4 path.
  if (detectV6) {
    try {
      profile.ipv6 = await detectIpv6(bindPort, { timeoutMs: Math.min(timeoutMs, 3000) });
      profile.detectionLog.push(
        `ipv6: global=${profile.ipv6.globalV6Available} stable=${profile.ipv6.stableV6Available} ` +
          `listener=${profile.ipv6.listenerV6Ok} reachable_out=${profile.ipv6.externalV6Reachable}`,
      );
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      profile.detectionLog.push(`ipv6: probe error — ${msg}`);
    }
  }

  // Tier 0
  if (operatorPublicEndpoint) {
    if (looksRoutable(operatorPublicEndpoint)) {
      profile.detectionLog.push(
        `tier-0: operator-configured public_endpoint=${JSON.stringify(operatorPublicEndpoint)}`
      );
      const t0 = newProfile(0, "direct");
      t0.publicEndpoint = operatorPublicEndpoint;
      t0.internalEndpoint = profile.internalEndpoint;
      t0.detectionLog = profile.detectionLog;
      return t0;
    }
    profile.detectionLog.push(
      `tier-0: operator-configured public_endpoint=${JSON.stringify(operatorPublicEndpoint)} non-routable — falling through to tier-1 UPnP`
    );
  }

  // Tier 1 — UPnP
  const portsToMap: number[] = [bindPort];
  if (transportPort && transportPort !== bindPort) portsToMap.push(transportPort);

  let upnp: UpnpResult | null = null;
  try {
    upnp = await withTimeout(tryUpnpMapping(portsToMap, upnpLeaseSeconds), timeoutMs);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (msg.startsWith("ImportError:")) {
      profile.detectionLog.push(`tier-1: nat-upnp library not installed: ${msg.slice(13)}`);
    } else if (msg === "timeout") {
      profile.detectionLog.push(`tier-1: UPnP discovery timed out after ${timeoutMs}ms`);
    } else {
      profile.detectionLog.push(`tier-1: UPnP error: ${msg}`);
    }
    upnp = null;
  }

  if (upnp?.success) {
    // External IP probe fallback for routers that AddPortMapping but refuse
    // GetExternalIPAddress
    if (!upnp.externalIp || upnp.externalIp === "0.0.0.0") {
      if (externalIpProbeUrl) {
        const probed = await probeExternalIp(externalIpProbeUrl, Math.min(timeoutMs, 5000));
        if (probed) {
          profile.detectionLog.push(
            `tier-1: external IP probe ${JSON.stringify(externalIpProbeUrl)} returned ${probed}`
          );
          upnp.externalIp = probed;
        } else {
          profile.detectionLog.push(
            `tier-1: external IP probe ${JSON.stringify(externalIpProbeUrl)} returned no valid IPv4`
          );
        }
      }
      if (!upnp.externalIp || upnp.externalIp === "0.0.0.0") {
        profile.operatorGuidance =
          `UPnP mapped port ${bindPort} but the router did not return its WAN IP. ` +
          `Set externalIpProbeUrl to an HTTPS probe service (e.g. https://api.ipify.org) ` +
          `OR set publicEndpoint manually.`;
        return profile;
      }
    }

    // #339 — CGNAT reverse-DNS heuristic
    const cgnatWarning = await detectCgnat(upnp.externalIp);
    if (cgnatWarning) {
      profile.detectionLog.push(`tier-1: ${cgnatWarning}`);
      // ADR-043 §10 — CGNAT IPv4 unreachable, but advertise IPv6 GUA if usable.
      const v6 = await tryIpv6Fallback(profile, bindPort, transportPort);
      if (v6) return v6;
      profile.operatorGuidance =
        `WARNING: your WAN IP ${upnp.externalIp} appears to be inside a carrier-grade ` +
        `NAT pool (reverse-DNS suggests CGNAT). UPnP-mapped ports are typically not ` +
        `reachable from the internet in this case. Options: (a) ask your ISP for a ` +
        `native IPv4 lease, (b) use an external tunnel (Cloudflare Tunnel, tailscale ` +
        `funnel), (c) switch to IPv6 if your network supports it.`;
      return profile; // tier 4
    }

    const publicUrl = `http://${upnp.externalIp}:${bindPort}`;
    let transportUrl: string | undefined;
    if (transportPort && upnp.mappedPorts.includes(transportPort) && transportPort !== bindPort) {
      transportUrl = `iicp://${upnp.externalIp}:${transportPort}`;
      profile.detectionLog.push(
        `tier-1: UPnP mapped ${bindPort} → ${publicUrl} AND ${transportPort} → ${transportUrl} (spec v0.7.0 dual-endpoint)`
      );
    } else {
      profile.detectionLog.push(`tier-1: UPnP mapped ${bindPort} → ${publicUrl}`);
    }

    const result = newProfile(1, "upnp_mapped");
    result.publicEndpoint = publicUrl;
    result.transportEndpoint = transportUrl;
    result.internalEndpoint = profile.internalEndpoint;
    result.detectionLog = profile.detectionLog;
    return result;
  }

  // UPnP failed — explain why + give actionable guidance
  if (!upnp) {
    profile.detectionLog.push(
      "tier-1: UPnP discovery returned nothing (SSDP broadcast filtered? library missing?)"
    );
  } else if (!upnp.igdDevice) {
    profile.detectionLog.push(`tier-1: no IGD device responded — ${upnp.error}`);
  } else {
    profile.detectionLog.push(`tier-1: IGD found (${upnp.igdDevice}) but mapping refused — ${upnp.error}`);
  }

  // ADR-043 §10 — IPv6 fallback when no v4 path is usable.
  const v6 = await tryIpv6Fallback(profile, bindPort, transportPort);
  if (v6) return v6;

  profile.operatorGuidance =
    "No automatic port mapping available. Options:\n" +
    "  1. Configure your router to forward an external port to this host\n" +
    "  2. Set publicEndpoint to your real external URL\n" +
    "  3. Use an external tunnel (Cloudflare Tunnel, ngrok, tailscale funnel)\n" +
    "See iicp.network/docs/nat-aware-adapter-setup.md for the details.";
  return profile;
}

/**
 * ADR-043 §4 — IPv6 qualification probe (#342).
 *
 * Returns `globalV6Available` only when at least one local interface has a
 * GUA (2000::/3). `listenerV6Ok` checks that a v6 socket can be bound on the
 * requested port. `externalV6Reachable` performs an outbound probe of an
 * IPv6-only host (default https://api6.ipify.org).
 */
export async function detectIpv6(
  bindPort: number,
  opts: { probeUrl?: string; timeoutMs?: number } = {},
): Promise<Ipv6Profile> {
  const probeUrl = opts.probeUrl ?? "https://api6.ipify.org";
  const timeoutMs = opts.timeoutMs ?? 3000;

  const out: Ipv6Profile = {
    globalV6Available: false,
    stableV6Available: false,
    addresses: [],
    listenerV6Ok: false,
    externalV6Reachable: false,
  };

  out.addresses = listGlobalIpv6Addresses();
  out.globalV6Available = out.addresses.length > 0;
  out.stableV6Available = out.addresses.some((a) => !isPrivacyV6(a));

  // Listener bind test
  await new Promise<void>((resolve) => {
    // Lazy import — node:net is fine to require, but the test must not throw
    // synchronously if creating a server fails (some hardened sandboxes).
    let server: import("node:net").Server | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const net = require("node:net") as typeof import("node:net");
      server = net.createServer();
      server.once("error", (err) => {
        out.listenerV6Ok = false;
        out.error = `v6 bind failed: ${err.message}`;
        server?.close();
        resolve();
      });
      server.listen({ host: "::", port: bindPort, exclusive: true }, () => {
        out.listenerV6Ok = true;
        server?.close();
        resolve();
      });
    } catch (exc) {
      out.error = `v6 bind exception: ${exc instanceof Error ? exc.message : String(exc)}`;
      resolve();
    }
  });

  // Outbound v6 reachability test
  if (out.globalV6Available) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(probeUrl, { signal: ctrl.signal });
      clearTimeout(t);
      out.externalV6Reachable = resp.status === 200;
    } catch {
      out.externalV6Reachable = false;
    }
  }

  return out;
}

function listGlobalIpv6Addresses(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  const out: string[] = [];
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const ent of list) {
      if (ent.family !== "IPv6") continue;
      const addr = ent.address.split("%")[0];
      // Filter to GUA (2000::/3). Node's `internal` flag covers loopback ::1.
      if (ent.internal) continue;
      const first = parseInt(addr.split(":")[0] ?? "0", 16);
      // 2000..3fff is the GUA range (first hextet upper bits 001x)
      if ((first & 0xe000) === 0x2000) {
        out.push(addr);
      }
    }
  }
  return Array.from(new Set(out)).sort();
}

function isPrivacyV6(addr: string): boolean {
  // Heuristic — EUI-64 places `ff:fe` in the middle 16 bits of the interface ID.
  // RFC 4941 privacy addresses use a random interface ID without this marker.
  const groups = addr.split(":");
  if (groups.length < 4) return false;
  const ifaceMid = (groups[groups.length - 3] ?? "").toLowerCase();
  // Crude: privacy addresses don't have 'ff:fe' anywhere in the last 4 hextets
  return !addr.toLowerCase().includes("ff:fe");
}

async function tryIpv6Fallback(
  profile: NatProfile,
  bindPort: number,
  transportPort: number | undefined,
): Promise<NatProfile | null> {
  if (!profile.ipv6) return null;
  if (!profile.ipv6.globalV6Available || !profile.ipv6.externalV6Reachable) return null;
  const v6Addr = profile.ipv6.addresses[0];
  const publicUrl = `http://[${v6Addr}]:${bindPort}`;
  let transportUrl: string | undefined;
  if (transportPort && transportPort !== bindPort) {
    transportUrl = `iicp://[${v6Addr}]:${transportPort}`;
  }
  profile.detectionLog.push(
    `tier-1-ipv6: advertising ${publicUrl} (verified outbound v6; attempting UPnP IGDv2 pinhole — #343)`,
  );

  // ADR-043 §5 / #343 — attempt UPnP IPv6 firewall pinhole.
  try {
    const pin = await tryUpnpIpv6Pinhole(v6Addr, bindPort, { leaseSeconds: 3600 });
    if (pin) {
      profile.ipv6.pinholeActive = true;
      profile.ipv6.pinholeUniqueId = pin.uniqueId;
      profile.ipv6.pinholeLeaseSeconds = pin.leaseSeconds;
      profile.ipv6.pinholeInboundAllowed = pin.inboundAllowed;
      profile.detectionLog.push(
        `tier-1-ipv6: AddPinhole OK — uid=${pin.uniqueId} lease=${pin.leaseSeconds}s`,
      );
    } else {
      profile.ipv6.pinholeActive = false;
      profile.detectionLog.push(
        `tier-1-ipv6: AddPinhole declined or no WANIPv6FirewallControl IGD found — operator must open inbound TCP/${bindPort} manually`,
      );
    }
  } catch (exc) {
    profile.ipv6.pinholeActive = false;
    const msg = exc instanceof Error ? exc.message : String(exc);
    profile.detectionLog.push(`tier-1-ipv6: pinhole attempt error: ${msg}`);
  }

  const result = newProfile(1, "direct");
  result.publicEndpoint = publicUrl;
  result.transportEndpoint = transportUrl;
  result.internalEndpoint = profile.internalEndpoint;
  result.detectionLog = profile.detectionLog;
  result.ipv6 = profile.ipv6;
  const pinholeNote = profile.ipv6.pinholeActive
    ? `UPnP IPv6 pinhole opened (uid=${profile.ipv6.pinholeUniqueId}). `
    : `Router firewall pinhole not opened — manual rule may be required. `;
  result.operatorGuidance =
    `Advertising IPv6 GUA ${v6Addr}. Inbound IPv4 isn't available (no UPnP success / CGNAT), ` +
    `but your IPv6 surface is routable. ${pinholeNote}` +
    `The directory will Layer-2 dial-back to verify.`;
  return result;
}

// ── UPnP helpers ─────────────────────────────────────────────────────────────

export interface UpnpResult {
  success: boolean;
  externalIp?: string;
  externalPort?: number;
  mappedPorts: number[];
  igdDevice?: string;
  error?: string;
}

interface NatUpnpClient {
  externalIp(): Promise<string>;
  portMapping(opts: {
    public: number | { host?: string; port: number };
    private: number | { host?: string; port: number };
    ttl?: number;
    description?: string;
    protocol?: "tcp" | "udp";
  }): Promise<void>;
  close?(): void;
}

export async function tryUpnpMapping(
  internalPorts: number[],
  leaseSeconds: number
): Promise<UpnpResult> {
  if (!internalPorts.length) {
    return { success: false, mappedPorts: [], error: "no ports specified" };
  }
  const primary = internalPorts[0];

  let createClient: () => NatUpnpClient;
  try {
    // nat-upnp is an optional peer dep and ships no @types. Use string-form
    // dynamic import + Function indirection so tsc doesn't try to resolve it
    // at build time when the operator hasn't installed the [nat] extra.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-new-func
    const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await dynImport("nat-upnp")) as any;
    // nat-upnp exports `createClient` (factory) or default; handle both.
    createClient = typeof mod.createClient === "function" ? mod.createClient : mod.default?.createClient;
    if (typeof createClient !== "function") {
      throw new Error("nat-upnp module has no createClient()");
    }
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new Error(`ImportError: nat-upnp not installed — install with: npm install nat-upnp (${msg})`);
  }

  const client = createClient();
  let externalIp = "";
  try {
    externalIp = await client.externalIp();
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (client.close) client.close();
    return { success: false, mappedPorts: [], error: `externalIp failed: ${msg}` };
  }

  try {
    await client.portMapping({
      public: primary,
      private: primary,
      ttl: leaseSeconds,
      description: `iicp-client (ADR-041 tier-1) ${primary}`,
      protocol: "tcp",
    });
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (client.close) client.close();
    return {
      success: false,
      externalIp,
      mappedPorts: [],
      error: `AddPortMapping failed for primary port ${primary}: ${msg}`,
    };
  }

  const mapped: number[] = [primary];
  for (const extra of internalPorts.slice(1)) {
    try {
      await client.portMapping({
        public: extra,
        private: extra,
        ttl: leaseSeconds,
        description: `iicp-client (ADR-041 tier-1) ${extra}`,
        protocol: "tcp",
      });
      mapped.push(extra);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      // Best-effort — log via detection_log path; primary already succeeded.
      // eslint-disable-next-line no-console
      console.warn(`UPnP: failed to map additional port ${extra} (primary ${primary} ok): ${msg}`);
    }
  }
  if (client.close) client.close();

  return { success: true, externalIp, externalPort: primary, mappedPorts: mapped };
}

// ── External-IP probe + routability helpers ──────────────────────────────────

export async function probeExternalIp(url: string, timeoutMs = 5000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let body: string;
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    body = await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }

  const m = body.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  if (!m) return null;
  const candidate = m[1];
  if (!net.isIPv4(candidate)) return null;

  // Reject non-public IPs same way the Python module does
  if (isNonPublicIpv4(candidate)) return null;
  return candidate;
}

/**
 * Returns true if `host` is a hostname/IP that could plausibly be reached
 * from a public client. Mirror of the directory's RoutableEndpoint validator.
 */
export function looksRoutable(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const neverRoutable = new Set(["localhost", "0.0.0.0", "::1", "::"]);
  if (neverRoutable.has(host)) return false;
  const suffixes = [".localhost", ".local", ".test", ".example", ".invalid", ".lan", ".internal"];
  if (suffixes.some((s) => host.endsWith(s))) return false;
  if (net.isIPv4(host) || net.isIPv6(host)) {
    return !isNonPublicIpv4(host) && !isNonPublicIpv6(host);
  }
  // Bare hostname without TLD = likely Docker service name
  if (!host.includes(".")) return false;
  return true;
}

function isNonPublicIpv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true; // multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  // RFC 5737 documentation ranges
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  return false;
}

function isNonPublicIpv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  // Loopback / unspecified
  if (lower === "::1" || lower === "::") return true;
  // Link-local fe80::/10
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // Unique local fc00::/7
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

// ── CGNAT detection (iicp.network #339) ──────────────────────────────────────

const CGNAT_HINTS = ["cgn", "cgnat", "ds-lite", "dslite", "nat64"];
const SHARED_HINTS = ["shared"];

export async function detectCgnat(externalIp: string): Promise<string | null> {
  let hostnames: string[] = [];
  try {
    hostnames = await dns.promises.reverse(externalIp);
  } catch {
    return null;
  }
  for (const raw of hostnames) {
    const hostname = raw.toLowerCase();
    if (CGNAT_HINTS.some((h) => hostname.includes(h))) {
      return `reverse-DNS for ${externalIp} = ${JSON.stringify(hostname)} suggests CGNAT — UPnP mapping likely not externally reachable`;
    }
    if (SHARED_HINTS.some((h) => hostname.includes(h))) {
      return `reverse-DNS for ${externalIp} = ${JSON.stringify(hostname)} suggests shared/CGNAT infrastructure — verify external reachability`;
    }
  }
  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ── #343 / ADR-043 §5 — UPnP IPv6 firewall pinhole ─────────────────────────

interface SsdpHit {
  location: string;
  st: string;
}

async function ssdpDiscover(serviceType: string, timeoutMs = 3000): Promise<SsdpHit[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dgram = require("node:dgram") as typeof import("node:dgram");
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const hits: SsdpHit[] = [];
  const msg = Buffer.from(
    `M-SEARCH * HTTP/1.1\r\n` +
      `HOST: 239.255.255.250:1900\r\n` +
      `MAN: "ssdp:discover"\r\n` +
      `MX: 2\r\n` +
      `ST: ${serviceType}\r\n\r\n`,
  );
  return new Promise<SsdpHit[]>((resolve) => {
    sock.on("message", (data) => {
      const text = data.toString("utf-8");
      const locMatch = text.match(/LOCATION:\s*(\S+)/i);
      const stMatch = text.match(/^ST:\s*(\S+)/im);
      if (locMatch && stMatch) {
        hits.push({ location: locMatch[1], st: stMatch[1] });
      }
    });
    sock.on("error", () => {
      sock.close();
      resolve(hits);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      sock.send(msg, 1900, "239.255.255.250", () => undefined);
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* no-op */ }
      resolve(hits);
    }, timeoutMs);
  });
}

interface FirewallService {
  controlURL: string;
  serviceType: string;
}

async function fetchFirewallService(deviceUrl: string, timeoutMs = 3000): Promise<FirewallService | null> {
  let xml: string;
  try {
    const r = await fetch(deviceUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    xml = await r.text();
  } catch {
    return null;
  }
  // Crude regex match — full XML parsing not worth the dep here.
  const services: Array<{ type: string; control: string }> = [];
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const typeM = block.match(/<serviceType>([^<]+)<\/serviceType>/i);
    const ctrlM = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (typeM && ctrlM) services.push({ type: typeM[1].trim(), control: ctrlM[1].trim() });
  }
  const v6 = services.find((s) => s.type.includes("WANIPv6FirewallControl"));
  if (!v6) return null;
  // controlURL may be relative
  let controlURL = v6.control;
  if (!/^https?:\/\//i.test(controlURL)) {
    const base = new URL(deviceUrl);
    controlURL = new URL(controlURL, `${base.protocol}//${base.host}`).toString();
  }
  return { controlURL, serviceType: v6.type };
}

async function soapCall(
  controlURL: string,
  serviceType: string,
  action: string,
  args: Record<string, string | number>,
  timeoutMs = 5000,
): Promise<Record<string, string> | null> {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${String(v)}</${k}>`)
    .join("");
  const body =
    `<?xml version="1.0"?>\n` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>` +
    `<u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}>` +
    `</s:Body></s:Envelope>`;
  try {
    const r = await fetch(controlURL, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const text = await r.text();
    const out: Record<string, string> = {};
    const re = /<([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip envelope/body wrappers
      if (["Envelope", "Body"].includes(m[1])) continue;
      out[m[1]] = m[2];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * ADR-043 §5 (#343) — open an inbound IPv6 firewall pinhole on the IGD.
 * Returns `{ uniqueId, leaseSeconds, inboundAllowed }` on success, null otherwise.
 *
 * Operators close the pinhole on shutdown via `deleteIpv6Pinhole(uniqueId)`.
 */
export async function tryUpnpIpv6Pinhole(
  internalV6: string,
  internalPort: number,
  opts: { leaseSeconds?: number; protocol?: number; timeoutMs?: number } = {},
): Promise<{ uniqueId: number; leaseSeconds: number; inboundAllowed: boolean } | null> {
  const lease = opts.leaseSeconds ?? 3600;
  const protocol = opts.protocol ?? 6; // TCP
  const timeout = opts.timeoutMs ?? 5000;
  const hits = await ssdpDiscover("urn:schemas-upnp-org:service:WANIPv6FirewallControl:1", timeout);
  for (const hit of hits) {
    const svc = await fetchFirewallService(hit.location, timeout);
    if (!svc) continue;
    const status = await soapCall(svc.controlURL, svc.serviceType, "GetFirewallStatus", {}, timeout);
    const inboundAllowed = (status?.InboundPinholeAllowed ?? "0") === "1";
    if (!inboundAllowed) return null;
    const result = await soapCall(svc.controlURL, svc.serviceType, "AddPinhole", {
      RemoteHost: "",
      RemotePort: 0,
      InternalClient: internalV6,
      InternalPort: internalPort,
      Protocol: protocol,
      LeaseTime: lease,
    }, timeout);
    if (!result) return null;
    const uid = parseInt(result.UniqueID ?? "0", 10);
    return { uniqueId: uid, leaseSeconds: lease, inboundAllowed: true };
  }
  return null;
}

/** ADR-043 §5 — close a previously-opened IPv6 pinhole. Best-effort. */
export async function deleteIpv6Pinhole(uniqueId: number, timeoutMs = 5000): Promise<boolean> {
  const hits = await ssdpDiscover("urn:schemas-upnp-org:service:WANIPv6FirewallControl:1", timeoutMs);
  for (const hit of hits) {
    const svc = await fetchFirewallService(hit.location, timeoutMs);
    if (!svc) continue;
    const result = await soapCall(svc.controlURL, svc.serviceType, "DeletePinhole", {
      UniqueID: uniqueId,
    }, timeoutMs);
    if (result !== null) return true;
  }
  return false;
}
