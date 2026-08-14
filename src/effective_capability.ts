/** Binding-neutral effective-capability profile primitives.
 *
 * These helpers classify complete service-path variants. They do not perform
 * discovery, policy authorization, final route validation, or dispatch.
 */

export const EFFECTIVE_CAPABILITY_PROFILE_ID = "urn:iicp:profile:effective-capability:v1";
export const EFFECTIVE_CAPABILITY_SCHEMA_VERSION = "1.0.0";

export const EFFECTIVE_CAPABILITY_REFUSAL = {
  requiredUnknown: "required_capability_unknown",
  requiredUnsupported: "required_capability_unsupported",
  requiredStale: "required_capability_stale",
  limitUnsatisfied: "capability_limit_unsatisfied",
  policyDenied: "capability_policy_denied",
} as const;

export interface CapabilityLimit {
  value: number;
  unit: "tokens" | "items" | "bytes" | "milliseconds" | "dimensions";
}

export interface CapabilityClaimProvenance {
  source:
    | "heuristic_fallback"
    | "operator_assertion"
    | "provider_metadata"
    | "runtime_introspection"
    | "conformance_probe";
  observed_at?: string;
  valid_until?: string;
  evidence_ref?: string;
}

export interface CapabilityExtension {
  required: boolean;
  value: unknown;
}

/** One complete variant; fields from different variants must never be unioned. */
export interface EffectiveCapability {
  intent: string;
  version?: string;
  phase?: number;
  variant_id?: string;
  models?: string[];
  max_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  features?: string[];
  execution_capabilities?: string[];
  limits?: Record<string, CapabilityLimit>;
  supported_profiles?: string[];
  claim_provenance?: CapabilityClaimProvenance;
  extensions?: Record<string, CapabilityExtension>;
}

export interface CapabilityRequirement {
  class: string;
  id: string;
}

export interface CapabilityLimitRequirement {
  id: string;
  operator: "gte" | "lte" | "eq" | string;
  value: number;
  unit: string;
}

export interface CapabilityRequirements {
  intent: string;
  requires?: CapabilityRequirement[];
  prefers?: CapabilityRequirement[];
  limits?: CapabilityLimitRequirement[];
}

export interface EffectiveCapabilityMatch {
  eligible: boolean;
  variant_ids: Array<string | undefined>;
  preference_unavailable: boolean;
  refusal?: string;
  preserved_extensions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.sort().join(", ")}`);
}

function stringSet(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return [...result];
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("capability timestamp must be RFC 3339");
  return parsed;
}

export function parseEffectiveCapability(raw: unknown): EffectiveCapability {
  if (!isRecord(raw)) throw new Error("effective capability must be an object");
  assertExactKeys(
    raw,
    new Set([
      "intent", "version", "phase", "variant_id", "models", "max_tokens",
      "input_modalities", "output_modalities", "features", "execution_capabilities",
      "limits", "supported_profiles", "claim_provenance", "extensions",
    ]),
    "effective capability",
  );
  if (typeof raw.intent !== "string" || raw.intent.length === 0) throw new Error("intent is required");
  if (raw.phase !== undefined && (!Number.isInteger(raw.phase) || (raw.phase as number) < 1)) {
    throw new Error("phase must be a positive integer");
  }
  if (raw.max_tokens !== undefined && (!Number.isInteger(raw.max_tokens) || (raw.max_tokens as number) < 1)) {
    throw new Error("max_tokens must be a positive integer");
  }

  let limits: Record<string, CapabilityLimit> | undefined;
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) throw new Error("limits must be an object");
    limits = {};
    for (const [id, rawLimit] of Object.entries(raw.limits)) {
      if (!isRecord(rawLimit) || Object.keys(rawLimit).sort().join(",") !== "unit,value") {
        throw new Error("each limit requires only value and unit");
      }
      if (typeof rawLimit.value !== "number" || !Number.isFinite(rawLimit.value) || rawLimit.value < 0) {
        throw new Error("limit value must be a non-negative number");
      }
      if (!["tokens", "items", "bytes", "milliseconds", "dimensions"].includes(String(rawLimit.unit))) {
        throw new Error("limit unit is unsupported");
      }
      limits[id] = { value: rawLimit.value, unit: rawLimit.unit as CapabilityLimit["unit"] };
    }
  }

  let claim_provenance: CapabilityClaimProvenance | undefined;
  if (raw.claim_provenance !== undefined) {
    if (!isRecord(raw.claim_provenance)) throw new Error("claim_provenance must be an object");
    const source = raw.claim_provenance.source;
    const sources = ["heuristic_fallback", "operator_assertion", "provider_metadata", "runtime_introspection", "conformance_probe"];
    if (typeof source !== "string" || !sources.includes(source)) throw new Error("claim_provenance source is unsupported");
    for (const key of ["observed_at", "valid_until"] as const) {
      const value = raw.claim_provenance[key];
      if (value !== undefined) {
        if (typeof value !== "string") throw new Error(`${key} must be a string`);
        parseTimestamp(value);
      }
    }
    claim_provenance = {
      source: source as CapabilityClaimProvenance["source"],
      ...(typeof raw.claim_provenance.observed_at === "string" ? { observed_at: raw.claim_provenance.observed_at } : {}),
      ...(typeof raw.claim_provenance.valid_until === "string" ? { valid_until: raw.claim_provenance.valid_until } : {}),
      ...(typeof raw.claim_provenance.evidence_ref === "string" ? { evidence_ref: raw.claim_provenance.evidence_ref } : {}),
    };
  }

  let extensions: Record<string, CapabilityExtension> | undefined;
  if (raw.extensions !== undefined) {
    if (!isRecord(raw.extensions)) throw new Error("extensions must be an object");
    extensions = {};
    for (const [id, rawExtension] of Object.entries(raw.extensions)) {
      if (!isRecord(rawExtension) || Object.keys(rawExtension).sort().join(",") !== "required,value" || typeof rawExtension.required !== "boolean") {
        throw new Error("each extension requires boolean required and value");
      }
      extensions[id] = { required: rawExtension.required, value: rawExtension.value };
    }
  }

  return {
    intent: raw.intent,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.phase === "number" ? { phase: raw.phase } : {}),
    ...(typeof raw.variant_id === "string" ? { variant_id: raw.variant_id } : {}),
    ...(stringSet(raw.models, "models") ? { models: stringSet(raw.models, "models") } : {}),
    ...(typeof raw.max_tokens === "number" ? { max_tokens: raw.max_tokens } : {}),
    ...(stringSet(raw.input_modalities, "input_modalities") ? { input_modalities: stringSet(raw.input_modalities, "input_modalities") } : {}),
    ...(stringSet(raw.output_modalities, "output_modalities") ? { output_modalities: stringSet(raw.output_modalities, "output_modalities") } : {}),
    ...(stringSet(raw.features, "features") ? { features: stringSet(raw.features, "features") } : {}),
    ...(stringSet(raw.execution_capabilities, "execution_capabilities") ? { execution_capabilities: stringSet(raw.execution_capabilities, "execution_capabilities") } : {}),
    ...(limits ? { limits } : {}),
    ...(stringSet(raw.supported_profiles, "supported_profiles") ? { supported_profiles: stringSet(raw.supported_profiles, "supported_profiles") } : {}),
    ...(claim_provenance ? { claim_provenance } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

export function parseEffectiveCapabilityAdvertisement(raw: unknown): EffectiveCapability[] {
  if (!isRecord(raw)) throw new Error("advertisement must be an object");
  if (Object.keys(raw).sort().join(",") !== "capabilities,schema_version") {
    throw new Error("advertisement requires only schema_version and capabilities");
  }
  if (raw.schema_version !== EFFECTIVE_CAPABILITY_SCHEMA_VERSION) throw new Error("unsupported schema_version");
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) throw new Error("capabilities must be a non-empty array");
  const parsed = raw.capabilities.map(parseEffectiveCapability);
  const identities = parsed.map((item) => `${item.intent}\u0000${item.variant_id ?? ""}`);
  if (new Set(identities).size !== identities.length) throw new Error("effective capability variants must be unique");
  return parsed;
}

export function resolveEffectiveCapabilities(options: {
  explicit?: readonly EffectiveCapability[];
  introspected?: readonly EffectiveCapability[];
  heuristic?: readonly EffectiveCapability[];
}): EffectiveCapability[] {
  if (options.explicit?.length) return [...options.explicit];
  if (options.introspected?.length) return [...options.introspected];
  const heuristic = options.heuristic ?? [];
  if (heuristic.some((item) => item.claim_provenance?.source !== "heuristic_fallback")) {
    throw new Error("heuristic capability evidence must be labelled heuristic_fallback");
  }
  return [...heuristic];
}

function values(candidate: EffectiveCapability, capabilityClass: string): readonly string[] | undefined {
  switch (capabilityClass) {
    case "input_modality": return candidate.input_modalities;
    case "output_modality": return candidate.output_modalities;
    case "feature": return candidate.features;
    case "execution_capability": return candidate.execution_capabilities;
    case "profile": return candidate.supported_profiles;
    default: return undefined;
  }
}

function refusal(code: string): EffectiveCapabilityMatch {
  return { eligible: false, variant_ids: [], preference_unavailable: false, refusal: code, preserved_extensions: [] };
}

export function matchEffectiveCapabilities(
  capabilities: readonly EffectiveCapability[],
  request: CapabilityRequirements,
  vocabulary: Readonly<Record<string, readonly string[]>>,
  evaluatedAt: Date,
  policyDenials: readonly CapabilityRequirement[] = [],
): EffectiveCapabilityMatch {
  for (const requirement of request.requires ?? []) {
    if (!vocabulary[requirement.class]?.includes(requirement.id)) return refusal(EFFECTIVE_CAPABILITY_REFUSAL.requiredUnknown);
    if (policyDenials.some((denial) => denial.class === requirement.class && denial.id === requirement.id)) {
      return refusal(EFFECTIVE_CAPABILITY_REFUSAL.policyDenied);
    }
  }
  let candidates = capabilities.filter((candidate) =>
    candidate.intent === request.intent && (request.requires ?? []).every((required) => values(candidate, required.class)?.includes(required.id)),
  );
  if (candidates.length === 0) return refusal(EFFECTIVE_CAPABILITY_REFUSAL.requiredUnsupported);
  candidates = candidates.filter((candidate) => !candidate.claim_provenance?.valid_until || parseTimestamp(candidate.claim_provenance.valid_until) >= evaluatedAt.getTime());
  if (candidates.length === 0) return refusal(EFFECTIVE_CAPABILITY_REFUSAL.requiredStale);
  candidates = candidates.filter((candidate) => (request.limits ?? []).every((required) => {
    const actual = candidate.limits?.[required.id];
    if (!actual || actual.unit !== required.unit) return false;
    if (required.operator === "gte") return actual.value >= required.value;
    if (required.operator === "lte") return actual.value <= required.value;
    return required.operator === "eq" && actual.value === required.value;
  }));
  if (candidates.length === 0) return refusal(EFFECTIVE_CAPABILITY_REFUSAL.limitUnsatisfied);
  const preferenceUnavailable = (request.prefers ?? []).some((preferred) =>
    !vocabulary[preferred.class]?.includes(preferred.id)
      || !candidates.some((candidate) => values(candidate, preferred.class)?.includes(preferred.id)),
  );
  return {
    eligible: true,
    variant_ids: candidates.map((candidate) => candidate.variant_id),
    preference_unavailable: preferenceUnavailable,
    preserved_extensions: [...new Set(candidates.flatMap((candidate) => Object.keys(candidate.extensions ?? {})))].sort(),
  };
}
