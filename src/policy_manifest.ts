import { readFileSync } from "node:fs";
import { createHash, createPublicKey, sign } from "node:crypto";
import type { OperatorIdentity } from "./identity.js";
import { operatorSigningKey } from "./identity.js";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

export function canonicalPolicyManifest(manifest: Record<string, unknown>): Buffer {
  const copy = structuredClone(manifest);
  const sig = copy.signature;
  if (sig && typeof sig === "object" && !Array.isArray(sig)) delete (sig as Record<string, unknown>).signature;
  else delete copy.signature;
  return Buffer.from(JSON.stringify(sorted(copy)));
}

export function loadAndSignPolicyManifest(path: string, operator: OperatorIdentity, now = new Date()): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new Error(`cannot read policy manifest: ${err instanceof Error ? err.message : String(err)}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("policy manifest must be a JSON object");
  const manifest = structuredClone(raw as Record<string, unknown>);
  delete manifest.signature;
  const publicKey = Buffer.from(operator.operator_id, "base64");
  const signingKey = operatorSigningKey(operator);
  const publicDer = createPublicKey(signingKey).export({ type: "spki", format: "der" }) as Buffer;
  if (publicKey.length !== 32 || !publicKey.equals(publicDer.subarray(publicDer.length - 32))) {
    throw new Error("operator_id does not match the operator signing key");
  }
  const wireTime = (value: Date): string => value.toISOString().replace(".000Z", "Z");
  manifest.signature = {
    algorithm: "Ed25519",
    key_id: createHash("sha256").update(publicKey).digest("hex").slice(0, 12),
    public_key: operator.operator_id,
    signed_at: wireTime(now),
    expires_at: wireTime(new Date(now.getTime() + 90 * 86400_000)),
  };
  (manifest.signature as Record<string, unknown>).signature = sign(null, canonicalPolicyManifest(manifest), signingKey).toString("base64");
  return manifest;
}
