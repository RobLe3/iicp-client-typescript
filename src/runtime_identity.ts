import type { ChatMessage } from "./types.js";

export const RUNTIME_IDENTITY_PROFILE_ID = "urn:iicp:profile:runtime-identity-context:v0";
export const RUNTIME_IDENTITY_MARKER = "IICP-RUNTIME-CONTEXT/1";
export const RUNTIME_IDENTITY_CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";
export const RUNTIME_IDENTITY_MAX_BYTES = 2048;

const BASE_CAPSULE = "This request reached you through IICP, the Intent-based Inter-agent Communication Protocol. IICP discovers eligible services and routes requests. You are the selected model or service, not IICP. When asked about this connection, use only supplied runtime facts; do not guess missing facts.";

export type RuntimeIdentityMode = "disabled" | "explicit" | "required";
export type RuntimeIdentityInstructionChannel = "system" | "unsupported";

export interface RuntimeIdentityOptions {
  mode?: RuntimeIdentityMode;
  instruction_channel?: RuntimeIdentityInstructionChannel;
  selected_model?: string;
  effective_capabilities?: string[];
  selection_reason?: "matched_intent_and_constraints";
}

export class RuntimeIdentityContextUnsupported extends Error {
  constructor() {
    super("required_identity_context_unsupported");
    this.name = "RuntimeIdentityContextUnsupported";
  }
}

export function renderRuntimeIdentity(intent: string, options: RuntimeIdentityOptions): string {
  const lines = [`[${RUNTIME_IDENTITY_MARKER}]`, BASE_CAPSULE, "Runtime facts:", `- intent: ${intent}`];
  if (options.selected_model) lines.push(`- selected model (provider assertion): ${options.selected_model}`);
  if (options.effective_capabilities?.length) {
    lines.push(`- effective capabilities: ${options.effective_capabilities.join(", ")}`);
  }
  if (options.selection_reason === "matched_intent_and_constraints") {
    lines.push("- selection: This service matched the requested intent and constraints.");
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
  const mode = options?.mode ?? "disabled";
  if (mode === "disabled" || intent !== RUNTIME_IDENTITY_CHAT_INTENT) return original;
  if (options?.instruction_channel === "unsupported") {
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
    { role: "system", content: renderRuntimeIdentity(intent, options ?? {}) },
    ...original.slice(insertion),
  ];
}
