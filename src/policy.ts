/**
 * Client-side policy guardrails.
 *
 * The SDK refuses intent URNs aligned with prohibited-practice families before
 * discovery/routing. This is deliberately narrow; it does not replace deployer
 * legal review for high-risk or domain-specific systems.
 */

import { IicpError } from "./errors.js";

export const POLICY_REFUSAL_CODE = "IICP-POLICY-001";

export interface ProhibitedIntentRule {
  rule_id: string;
  label: string;
  fragments: readonly string[];
}

export const PROHIBITED_INTENT_RULES: readonly ProhibitedIntentRule[] = [
  {
    rule_id: "eu-ai-act-social-scoring",
    label: "social scoring",
    fragments: ["social-scoring", "social_scoring", "social:scoring"],
  },
  {
    rule_id: "eu-ai-act-criminal-risk",
    label: "individual criminal risk prediction",
    fragments: ["criminal-risk", "criminal_risk", "criminal:risk", "predict-crime"],
  },
  {
    rule_id: "eu-ai-act-workplace-education-emotion",
    label: "workplace or education emotion recognition",
    fragments: [
      "emotion:workplace",
      "emotion:education",
      "workplace-monitoring",
      "education-monitoring",
      "worker-monitoring",
    ],
  },
  {
    rule_id: "eu-ai-act-protected-trait-biometric",
    label: "biometric protected-trait classification",
    fragments: ["protected-trait", "protected_trait", "biometric:protected"],
  },
  {
    rule_id: "eu-ai-act-untargeted-face-scraping",
    label: "untargeted facial image scraping for recognition databases",
    fragments: ["untargeted-scraping", "untargeted_scraping", "face-scraping", "facial-scraping"],
  },
  {
    rule_id: "eu-ai-act-realtime-remote-biometric-id",
    label: "real-time remote biometric identification",
    fragments: ["remote-biometric:realtime", "realtime-remote-biometric", "real-time-remote-biometric"],
  },
  {
    rule_id: "eu-ai-act-nonconsensual-sexual-deepfake",
    label: "non-consensual sexual deepfake or CSAM generation",
    fragments: ["nonconsensual-sexual", "non-consensual-sexual", "child-sexual-abuse", "csam"],
  },
];

export function prohibitedIntentReason(intent: string): string | undefined {
  const normalized = intent.trim().toLowerCase();
  for (const rule of PROHIBITED_INTENT_RULES) {
    if (rule.fragments.some((fragment) => normalized.includes(fragment))) {
      return `${rule.label} (${rule.rule_id})`;
    }
  }
  return undefined;
}

export function ensureIntentAllowed(intent: string): void {
  const reason = prohibitedIntentReason(intent);
  if (!reason) return;
  throw new IicpError(
    `Intent refused by IICP client policy before discovery/routing: ${reason}. Use a lawful, documented, human-reviewed compliance path outside the public mesh for restricted/high-risk workflows.`,
    POLICY_REFUSAL_CODE,
    { component: "sdk" },
  );
}
