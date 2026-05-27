// SPDX-License-Identifier: Apache-2.0
/**
 * ADR-019 declarative pricing + HMAC-SHA256 signing — provider-side.
 *
 * TypeScript port of iicp-client-python's pricing.py (iter-1432). Same
 * wire-compat handling for the PHP float→integer collapse on whole-number
 * multipliers (PHP json_encode(1.0) → "1", JavaScript JSON.stringify(1.0)
 * also collapses to "1", but we go through a hand-rolled canonical encoder
 * to stay safe across runtimes).
 *
 * ADR-012 §10.4 mandates this integrity step for CIP cooperative sessions.
 * Pricing is OPT-IN — nodes that don't declare pricing get the directory's
 * default multiplier (1.0) and `pricing.attested=false` annotation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface PricingConfig {
  /** Float ≥ 0 applied to the base rate. Default 1.0. */
  creditCostMultiplier: number;
  /** Only `"per_token"` is defined in v1. */
  pricingModel?: string;
  /** When true AND a node_hmac_key is set, sign the body so the directory
   * marks `pricing.attested=true` in /v1/discover. */
  signDeclarations?: boolean;
  /** Optional ISO-8601 window. */
  effectiveFrom?: string;
  effectiveUntil?: string;
}

// ── HMAC helpers ─────────────────────────────────────────────────────────

/** HMAC-SHA256 hex digest. Matches PHP's `hash_hmac('sha256', $body, $key)`. */
export function signBody(body: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time signature comparison. */
export function verifySignature(body: Buffer | string, secret: string, signature: string): boolean {
  const expected = signBody(body, secret);
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signature, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Encode the pricing-block signature body the way the directory's PHP
 * `json_encode(ksort($body))` does, so HMAC verification succeeds across
 * the language gap.
 *
 * Mirrors the Python `_php_canonical_sign_body` helper byte-for-byte:
 *   - keys sorted alphabetically
 *   - whole-float values emit without a fractional zero (PHP behaviour)
 *   - non-whole floats use decimal representation
 *   - no whitespace
 */
export function phpCanonicalSignBody(opts: {
  creditCostMultiplier: number;
  pricingModel: string;
}): Buffer {
  const v = opts.creditCostMultiplier;
  const num = Number.isInteger(v) ? String(Math.trunc(v)) : String(v);
  const body = `{"credit_cost_multiplier":${num},"pricing_model":${JSON.stringify(opts.pricingModel)}}`;
  return Buffer.from(body, "utf-8");
}

// ── Pricing-block payload ────────────────────────────────────────────────

export function buildPricingBlock(
  pricing: PricingConfig,
  hmacKey: string = ""
): Record<string, unknown> {
  const model = pricing.pricingModel ?? "per_token";
  const block: Record<string, unknown> = {
    credit_cost_multiplier: pricing.creditCostMultiplier,
    pricing_model: model,
  };
  if (pricing.signDeclarations && hmacKey) {
    const body = phpCanonicalSignBody({
      creditCostMultiplier: pricing.creditCostMultiplier,
      pricingModel: model,
    });
    block.declaration_signature = signBody(body, hmacKey);
  }
  if (pricing.effectiveFrom !== undefined) block.effective_from = pricing.effectiveFrom;
  if (pricing.effectiveUntil !== undefined) block.effective_until = pricing.effectiveUntil;
  return block;
}
