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
export { openaiCompatHandler } from "./backends/openai_compat.js";
export type {
  OpenAiCompatOptions,
  TaskHandlerInput,
  TaskHandlerOutput,
} from "./backends/openai_compat.js";
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
