/**
 * ADR-043 §9/§11 — ServiceQualification: 8-category exposure enum + structured result.
 *
 * Maps a NatProfile to the canonical exposure_mode string and a ServiceQualification
 * object that the directory can store as `nodes.exposure_mode`.
 *
 * @example
 * ```ts
 * import { detectNat } from "./nat_detection.js";
 * import { qualifyService } from "./qualify.js";
 *
 * const profile = await detectNat({ bindHost: "0.0.0.0", bindPort: 8020 });
 * const sq = qualifyService(profile);
 * console.log(sq.exposureMode); // e.g. "ipv4_public_direct"
 * ```
 */

import type { NatProfile } from "./nat_detection.js";

// ── 8-category exposure enum (ADR-043 §9) ────────────────────────────────────

export type ExposureMode =
  | "outbound_only"
  | "ipv4_public_direct"
  | "ipv4_cgnat_blocked"
  | "ipv6_direct_firewall_required"
  | "ipv6_direct_pinhole_available"
  | "relay_required"
  | "tunnel_required"
  | "dual_stack_available";

export const EXPOSURE_MODES: ReadonlySet<ExposureMode> = new Set([
  "outbound_only",
  "ipv4_public_direct",
  "ipv4_cgnat_blocked",
  "ipv6_direct_firewall_required",
  "ipv6_direct_pinhole_available",
  "relay_required",
  "tunnel_required",
  "dual_stack_available",
]);

export interface Ipv4Qualification {
  publicIp: string | null;
  cgnat: boolean;
  upnpMapped: boolean;
}

export interface Ipv6Qualification {
  routable: boolean;
  pinholeOk: boolean;
  address: string | null;
}

export interface ExposureQualification {
  publicEndpoint: string | null;
  transportEndpoint: string | null;
}

/** ADR-043 §11 — structured result of service qualification. */
export interface ServiceQualification {
  exposureMode: ExposureMode;
  ipv4: Ipv4Qualification;
  ipv6: Ipv6Qualification;
  exposure: ExposureQualification;
  recommendation: string;
}

// ── Core mapping (NatProfile → ServiceQualification) ─────────────────────────

/** Map a NatProfile to an ADR-043 ServiceQualification (synchronous). */
export function qualifyService(profile: NatProfile): ServiceQualification {
  const ipv4: Ipv4Qualification = {
    publicIp: extractIp(profile.publicEndpoint ?? null),
    cgnat: profile.detectionLog.some((l) =>
      /cgnat|ds-lite|carrier-grade/i.test(l)
    ),
    upnpMapped: profile.transportMethod === "upnp_mapped",
  };

  const ipv6Profile = profile.ipv6;
  const ipv6: Ipv6Qualification = {
    routable: !!(ipv6Profile?.globalV6Available),
    pinholeOk: !!(ipv6Profile && "pinholeOk" in ipv6Profile && (ipv6Profile as any).pinholeOk),
    address: ipv6Profile?.addresses?.[0] ?? null,
  };

  const exposure: ExposureQualification = {
    publicEndpoint: profile.publicEndpoint ?? null,
    transportEndpoint: profile.transportEndpoint ?? null,
  };

  const exposureMode = deriveExposureMode(profile, ipv4, ipv6);
  const recommendation = buildRecommendation(exposureMode, profile);

  return { exposureMode, ipv4, ipv6, exposure, recommendation };
}

/** Run detectNat + qualifyService in one async call. */
export async function qualifyServiceAsync(opts: {
  bindHost?: string;
  bindPort?: number;
  transportPort?: number;
  detectV6?: boolean;
  timeoutMs?: number;
} = {}): Promise<ServiceQualification> {
  const { detectNat } = await import("./nat_detection.js");
  const profile = await detectNat({
    bindHost: opts.bindHost ?? "0.0.0.0",
    bindPort: opts.bindPort ?? 8020,
    transportPort: opts.transportPort ?? 9484,
    detectV6: opts.detectV6 ?? true,
    timeoutMs: (opts.timeoutMs ?? 15_000),
  });
  return qualifyService(profile);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractIp(endpoint: string | null): string | null {
  if (!endpoint) return null;
  const m = endpoint.match(/https?:\/\/([^:/]+)/);
  return m ? m[1] : null;
}

function deriveExposureMode(
  profile: NatProfile,
  ipv4: Ipv4Qualification,
  ipv6: Ipv6Qualification
): ExposureMode {
  if (profile.tier === 3) return "relay_required";
  if (profile.tier === 2 || profile.transportMethod === "external_tunnel") return "tunnel_required";
  if (profile.tier === 4 || !profile.publicEndpoint) {
    return ipv4.cgnat ? "ipv4_cgnat_blocked" : "outbound_only";
  }
  // tier 0 or 1
  const ipv4Ok = !!profile.publicEndpoint;
  if (ipv4Ok && ipv6.routable && ipv6.pinholeOk) return "dual_stack_available";
  if (!ipv4Ok && ipv6.routable) {
    return ipv6.pinholeOk ? "ipv6_direct_pinhole_available" : "ipv6_direct_firewall_required";
  }
  return "ipv4_public_direct";
}

const RECOMMENDATIONS: Record<ExposureMode, string> = {
  ipv4_public_direct: "Direct IPv4 connection available. No additional setup needed.",
  dual_stack_available: "Dual-stack (IPv4 + IPv6) available. Consumers can reach you on either path.",
  ipv6_direct_pinhole_available: "IPv6 direct connection available with firewall pinhole. IPv4 unreachable.",
  ipv6_direct_firewall_required: "IPv6 address routable but firewall is blocking. Open the relevant port.",
  relay_required: "Behind CGNAT or strict firewall — use relay mode (iicp-node --relay-worker-endpoint).",
  tunnel_required: "External tunnel detected (ngrok/Tailscale). Advertise the tunnel URL as public endpoint.",
  ipv4_cgnat_blocked: "Carrier-grade NAT detected. Relay mode is the recommended path.",
  outbound_only: "No inbound connectivity detected. Set --public-endpoint manually or use relay mode.",
};

function buildRecommendation(mode: ExposureMode, profile: NatProfile): string {
  const base = RECOMMENDATIONS[mode];
  const guidance = profile.operatorGuidance;
  return guidance ? `${base} ${guidance}` : base;
}
