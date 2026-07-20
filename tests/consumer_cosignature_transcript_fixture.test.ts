import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const fixture = JSON.parse(readFileSync(
  join(process.cwd(), "parity/cip-consumer-cosignature-transcript-v1.json"), "utf8",
));

test("consumer co-signature transcript is content-free and fail-closed", () => {
  const messages = fixture.transcript.map((step: any) => step.message);
  assert.deepEqual(messages.map((message: any) => message.type), [
    "receipt_offer", "receipt_acceptance", "settlement_request",
  ]);
  assert.equal(new Set(messages.map((message: any) => message.receipt_digest_hex)).size, 1);
  assert.equal(fixture.privacy_contract.content_free, true);
  const rendered = JSON.stringify(fixture);
  for (const field of fixture.privacy_contract.forbidden_fields) {
    assert.equal(rendered.includes(`"${field}":`), false);
  }
  const modes = Object.fromEntries(fixture.transition_modes.map((item: any) => [item.mode, item]));
  assert.equal(modes.legacy.authoritative_path, "existing_hmac_receipt");
  assert.equal(modes.observe.economic_effect, "no_additional_award_or_debit");
  assert.equal(modes.required.runtime_status, "unavailable");
  assert.equal(fixture.transition_modes.some((item: any) => item.strict_enforcement_authorized), false);
});
