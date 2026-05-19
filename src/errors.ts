/** IICP error class — SDK-05 / SDK-06 compliant (ADR-016 §3) */

export class IicpError extends Error {
  /** IICP error code (e.g. SDK-01, IICP-E010). Always set (SDK-06). */
  readonly code: string;
  /** HTTP status code when the error came from a network response. */
  readonly status_code?: number;
  /** Component that raised the error (directory | adapter | proxy | sdk). */
  readonly component?: string;

  constructor(message: string, code: string, opts?: {
    status_code?: number;
    component?: string;
    cause?: unknown;
  }) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "IicpError";
    this.code = code;
    this.status_code = opts?.status_code;
    this.component = opts?.component ?? "sdk";
  }
}
