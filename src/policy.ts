/**
 * Client-side policy guardrails.
 *
 * The SDK refuses intent URNs aligned with prohibited-practice families before
 * discovery/routing. This is deliberately narrow; it does not replace deployer
 * legal review for high-risk or domain-specific systems.
 */

import { IicpError } from "./errors.js";

export const POLICY_REFUSAL_CODE = "IICP-POLICY-001";
export type IntentRiskCategory = "prohibited" | "high_risk" | "transparency_risk" | "minimal_or_general";

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

export const HIGH_RISK_INTENT_RULES: readonly ProhibitedIntentRule[] = [
  { rule_id: "eu-ai-act-employment-workforce", label: "employment or workforce decision", fragments: ["employment:hiring", "employment:screen", "employment:rank", "recruitment:decision", "workforce:decision", "worker-management", "worker:performance", "worker:discipline"] },
  { rule_id: "eu-ai-act-education-admission-grading", label: "education admission or grading decision", fragments: ["education:admission", "education:grading", "education:grade", "student:admission", "student:assess", "exam-grading"] },
  { rule_id: "eu-ai-act-credit-essential-services", label: "credit or essential-services decision", fragments: ["credit-scoring", "credit:score", "credit:decision", "essential-services", "benefits:eligibility", "public-benefit:eligibility"] },
  { rule_id: "eu-ai-act-law-enforcement-border-justice", label: "law enforcement, border, justice or democratic-process decision", fragments: ["law-enforcement", "law_enforcement", "migration:decision", "asylum:decision", "border-control", "justice:decision", "democratic-process", "election:decision"] },
  { rule_id: "eu-ai-act-healthcare-critical-infrastructure", label: "healthcare or critical-infrastructure safety decision", fragments: ["healthcare:decision", "medical:diagnosis", "medical:triage", "clinical:decision", "critical-infrastructure", "grid:stabilize", "hospital:surge-capacity"] },
  { rule_id: "eu-ai-act-physical-world-control", label: "physical-world control", fragments: ["robotics:control", "robotics:fleet", "drone:control", "drone:search", "iot:actuate", "physical-world", "system_control"] },
];

const TRANSPARENCY_FRAGMENTS = ["chatbot", "ai-assistant", "synthetic-media", "deepfake:labelled", "content:generate-public", "creative:generate"];

export function classifyIntent(intent: string): IntentRiskCategory {
  const normalized = intent.trim().toLowerCase();
  if (PROHIBITED_INTENT_RULES.some((rule) => rule.fragments.some((fragment) => normalized.includes(fragment)))) return "prohibited";
  if (HIGH_RISK_INTENT_RULES.some((rule) => rule.fragments.some((fragment) => normalized.includes(fragment)))) return "high_risk";
  if (TRANSPARENCY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return "transparency_risk";
  return "minimal_or_general";
}

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
  const category = classifyIntent(intent);
  const normalized = intent.trim().toLowerCase();
  const rule = [...PROHIBITED_INTENT_RULES, ...HIGH_RISK_INTENT_RULES]
    .find((candidate) => candidate.fragments.some((fragment) => normalized.includes(fragment)));
  if (!rule || (category !== "prohibited" && category !== "high_risk")) return;
  const reason = `${rule.label} (${rule.rule_id})`;
  throw new IicpError(
    `Intent refused by IICP client policy before discovery/routing: ${reason} [${category}]. Use an explicit private, documented, human-reviewed compliance path outside the public mesh for restricted/high-risk workflows.`,
    POLICY_REFUSAL_CODE,
    { component: "sdk" },
  );
}
