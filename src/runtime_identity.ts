import type { ChatMessage } from "./types.js";

export const RUNTIME_IDENTITY_PROFILE_ID = "urn:iicp:profile:runtime-identity-context:v0";
export const RUNTIME_IDENTITY_MARKER = "IICP-RUNTIME-CONTEXT/1";
export const RUNTIME_IDENTITY_CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";
export const RUNTIME_IDENTITY_MAX_BYTES = 2048;
const MAX_FACT_BYTES = 160;
const MAX_CAPABILITIES = 32;

const BASE_CAPSULE = "This request reached you through IICP, the Intent-based Inter-agent Communication Protocol. IICP is a provider-neutral control plane that turns a requested intent and constraints into discovery, eligibility evaluation and provider selection; execution then uses a supported provider mechanism. You are the selected model or service, not IICP. If asked what IICP is or stands for, use this definition. IICP does not mean Industrial Internet of Things Computing. Use only supplied runtime facts and do not guess missing facts.";

export type RuntimeIdentityMode = "auto" | "disabled" | "explicit" | "required";
export type RuntimeIdentityInstructionChannel = "system" | "unsupported";
export type RuntimeIdentityConnectionMode = "routed" | "local_browser";
export type RuntimeIdentitySelectionReason =
  | "matched_intent_and_constraints"
  | "explicit_model_match"
  | "fallback_after_unavailable_candidate"
  | "intentional_exploration"
  | "local_browser_execution";

export interface RuntimeIdentityOptions {
  mode?: RuntimeIdentityMode;
  instruction_channel?: RuntimeIdentityInstructionChannel;
  selected_model?: string;
  effective_capabilities?: string[];
  selection_reason?: RuntimeIdentitySelectionReason;
  client_name?: string;
  client_version?: string;
  connection_mode?: RuntimeIdentityConnectionMode;
}

export class RuntimeIdentityContextUnsupported extends Error {
  constructor() {
    super("required_identity_context_unsupported");
    this.name = "RuntimeIdentityContextUnsupported";
  }
}

const selectionText: Record<RuntimeIdentitySelectionReason, string> = {
  matched_intent_and_constraints: "This service matched the requested intent and constraints.",
  explicit_model_match: "This service matched the requested model and constraints.",
  fallback_after_unavailable_candidate: "This service was selected after an earlier candidate was unavailable.",
  intentional_exploration: "This service was selected for an intentional routing exploration.",
  local_browser_execution: "This model is running locally in the browser.",
};

export function withRuntimeFacts(
  options: RuntimeIdentityOptions | undefined,
  facts: Required<Pick<RuntimeIdentityOptions, "client_name" | "client_version" | "connection_mode" | "selection_reason">>
    & Pick<RuntimeIdentityOptions, "selected_model" | "effective_capabilities">,
): RuntimeIdentityOptions {
  return {
    ...(options ?? {}),
    ...facts,
    selected_model: facts.selected_model,
    effective_capabilities: [...(facts.effective_capabilities ?? [])],
  };
}

function boundedFact(value: string, name: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`runtime identity ${name} contains control characters`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_FACT_BYTES) {
    throw new Error(`runtime identity ${name} exceeds the bounded fact limit`);
  }
  return value;
}

export function renderRuntimeIdentity(intent: string, options: RuntimeIdentityOptions): string {
  const lines = [`[${RUNTIME_IDENTITY_MARKER}]`, BASE_CAPSULE, "Runtime facts:", `- intent: ${boundedFact(intent, "intent")}`];
  if (options.client_name || options.client_version) {
    if (!options.client_name || !options.client_version) throw new Error("runtime identity client name and version must be supplied together");
    lines.push(`- client: ${boundedFact(options.client_name, "client name")} ${boundedFact(options.client_version, "client version")}`);
  }
  if (options.connection_mode === "routed") {
    lines.push("- connection: routed through IICP to an eligible provider.");
  } else if (options.connection_mode === "local_browser") {
    lines.push("- connection: This model is running locally in the browser; no remote IICP provider was selected.");
  } else if (options.connection_mode !== undefined) {
    throw new Error("runtime identity connection mode is unsupported");
  }
  if (options.selected_model) lines.push(`- selected model: ${boundedFact(options.selected_model, "selected model")}`);
  if ((options.effective_capabilities?.length ?? 0) > MAX_CAPABILITIES) {
    throw new Error("runtime identity effective capabilities exceed the bounded count");
  }
  if (options.effective_capabilities?.length) {
    lines.push(`- effective capabilities: ${options.effective_capabilities.map((value) => boundedFact(value, "effective capability")).join(", ")}`);
  }
  if (options.selection_reason) {
    const selection = selectionText[options.selection_reason];
    if (!selection) throw new Error("runtime identity selection reason is unsupported");
    lines.push(`- selection: ${selection}`);
  }
  const rendered = lines.join("\n");
  if (new TextEncoder().encode(rendered).byteLength > RUNTIME_IDENTITY_MAX_BYTES) {
    throw new Error("runtime identity context exceeds the 2048-byte limit");
  }
  return rendered;
}

export function composeRuntimeIdentity(
  messages: readonly ChatMessage[],
  intent: string,
  options?: RuntimeIdentityOptions,
): ChatMessage[] {
  const original = [...messages];
  const resolved = options ?? {};
  const mode = resolved.mode ?? "auto";
  if (intent !== RUNTIME_IDENTITY_CHAT_INTENT) return original;
  if (!["auto", "disabled", "explicit", "required"].includes(mode)) {
    throw new Error("runtime identity mode is unsupported");
  }
  if (mode === "disabled") return original;
  if (resolved.instruction_channel !== undefined
    && !["system", "unsupported"].includes(resolved.instruction_channel)) {
    throw new Error("runtime identity instruction channel is unsupported");
  }
  if (resolved.instruction_channel === "unsupported") {
    if (mode === "required") throw new RuntimeIdentityContextUnsupported();
    return original;
  }
  if (original.some((message) =>
    (message.role === "system" || message.role === "developer")
      && message.content.includes(RUNTIME_IDENTITY_MARKER)
  )) return original;

  let insertion = 0;
  while (insertion < original.length && ["system", "developer"].includes(original[insertion]!.role)) insertion += 1;
  return [
    ...original.slice(0, insertion),
    { role: "system", content: renderRuntimeIdentity(intent, resolved) },
    ...original.slice(insertion),
  ];
}
