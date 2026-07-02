export { IicpClient } from "./client.js";
export { IicpError } from "./errors.js";
export { IicpNode } from "./node.js";
export type { NodeConfig, ServeOptions, TaskHandler } from "./node.js";
export {
  IicpTcpServer,
  IicpTcpClient,
  IicpTcpClientError,
  MsgType,
  FRAMING_VERSION,
  FRAME_HEADER_LEN,
  IICP_MAGIC,
  encodeFrame,
  decodeFrame,
} from "./iicp_tcp.js";
export type {
  IicpFrame,
  IicpTcpServerOptions,
  IicpTcpClientOptions,
  TcpTaskHandler,
  DiscoverLookup,
} from "./iicp_tcp.js";
export {
  detectNat,
  looksRoutable,
  detectCgnat,
  probeExternalIp,
  tryUpnpMapping,
} from "./nat_detection.js";
export type { NatProfile, DetectNatOptions, UpnpResult } from "./nat_detection.js";
export {
  EXPOSURE_MODES,
  qualifyService,
  qualifyServiceAsync,
} from "./qualify.js";
export type {
  ExposureMode,
  ServiceQualification,
  Ipv4Qualification,
  Ipv6Qualification,
  ExposureQualification,
} from "./qualify.js";
export { openaiCompatHandler } from "./backends/openai_compat.js";
export type {
  OpenAiCompatOptions,
  TaskHandlerInput,
  TaskHandlerOutput,
} from "./backends/openai_compat.js";
export { vllmHandler } from "./backends/vllm.js";
export type { VllmOptions } from "./backends/vllm.js";
export { llamacppHandler } from "./backends/llamacpp.js";
export type { LlamaCppOptions } from "./backends/llamacpp.js";
export { anthropicHandler } from "./backends/anthropic.js";
export type { AnthropicOptions } from "./backends/anthropic.js";
export { getBackendHandler, BACKEND_TYPES } from "./backends/index.js";
export type { BackendType } from "./backends/index.js";
export type { BackendHandler, BackendOptions } from "./backends/base.js";
export { qosPriority, isQueueEligible, QOS_PRIORITY, QUEUE_ELIGIBLE, QUEUE_WAIT_MS } from "./scheduler.js";
export { AvailabilityEvaluator } from "./availability.js";
export type { Window } from "./availability.js";
export { TokenValidator } from "./token_validator.js";
export { IdempotencyGuard } from "./idempotency.js";
export { runAuditPass, modelsDiverge } from "./trust_auditor.js";
export type { AuditReport, NodeAuditResult } from "./trust_auditor.js";
export { PeerManager } from "./peer_manager.js";
export type { PeerInfo } from "./peer_manager.js";
export {
  POLICY_REFUSAL_CODE,
  PROHIBITED_INTENT_RULES,
  ensureIntentAllowed,
  prohibitedIntentReason,
} from "./policy.js";
export type { ProhibitedIntentRule } from "./policy.js";
export {
  CooperativeInferencePolicy,
  configureCipPolicy,
  getCipPolicy,
} from "./cip_policy.js";
export type { CooperativeInferencePolicyOptions } from "./cip_policy.js";
export {
  buildPricingBlock,
  phpCanonicalSignBody,
  signBody,
  verifySignature,
} from "./pricing.js";
export type { PricingConfig } from "./pricing.js";
export { runConformanceChecks } from "./conformance.js";
export type { ConformanceReport, ProbeResult } from "./conformance.js";
export { CapacityExceededError, ConcurrencyGate } from "./concurrency.js";
export {
  RECOVERY_EXIT_CODE,
  DEFAULT_RECOVERY_GRACE_CHECKS,
  DEFAULT_RECOVERY_CHECK_EVERY_HEARTBEATS,
  nodeRegistryPrefix,
  envGraceChecks,
  envCheckEveryHeartbeats,
  supervisedRecoveryEnabled,
  classifyRecovery,
  registryNodePresence,
} from "./recovery.js";
export type { RecoveryState, RecoveryAction, DirectoryPresence } from "./recovery.js";
export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatChoice,
  ChatUsage,
  ClientConfig,
  DiscoverOptions,
  Node,
  TaskAuth,
  TaskConstraints,
  TaskMetrics,
  TaskRequest,
  TaskResponse,
} from "./types.js";
