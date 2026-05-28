// SPDX-License-Identifier: Apache-2.0
/**
 * Constant-time bearer-token validation (parity Block E, #340).
 *
 * Port of iicp-adapter `services/token_validator.py`. Compares a presented token against
 * the expected one with `crypto.timingSafeEqual` so a timing side-channel can't recover
 * the token byte-by-byte. The expected token is updated after registration.
 */

import { timingSafeEqual } from "node:crypto";

export class TokenValidator {
  private expected: string;

  constructor(expectedToken = "") {
    this.expected = expectedToken;
  }

  isValid(presented: string | null | undefined): boolean {
    if (!this.expected || !presented) return false;
    const a = Buffer.from(this.expected);
    const b = Buffer.from(presented);
    // timingSafeEqual throws on length mismatch; guard first (length is not secret).
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Set the expected token after registration (directory-issued). */
  updateToken(newToken: string): void {
    this.expected = newToken;
  }
}
