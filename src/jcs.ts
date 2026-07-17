// SPDX-License-Identifier: Apache-2.0
import { canonicalize } from "json-canonicalize";

export const JCS_MAX_SAFE_INTEGER = 9_007_199_254_740_991;

function validateJcsValue(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS does not permit NaN or infinite numbers");
    // RFC 8785 permits finite IEEE-754 exponent values such as 1e+30. Reject
    // unsafe plain-integer magnitudes where a JSON producer could already have
    // lost integer precision, while retaining the RFC numeric test vectors.
    if (Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21) {
      throw new TypeError("JCS integer exceeds the interoperable IEEE-754 safe range; encode it as a string");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(validateJcsValue);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS accepts plain JSON objects only");
    }
    Object.values(value as Record<string, unknown>).forEach(validateJcsValue);
    return;
  }
  throw new TypeError(`unsupported JCS value type: ${typeof value}`);
}

/** Return RFC 8785 canonical JSON text for an interoperable JSON value. */
export function canonicalizeJcs(value: unknown): string {
  validateJcsValue(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("value is not representable as JCS JSON");
  return encoded;
}
