/** Finite resource boundary for the supported HTTP POST /v1/task binding. */

import type * as http from "node:http";

export const MAX_HTTP_TASK_BODY_BYTES = 1_048_576;

export class HttpResourceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly closeConnection: boolean;

  constructor(code: string, status: number, message: string, closeConnection = false) {
    super(message);
    this.name = "HttpResourceError";
    this.code = code;
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

export function encodeTaskRequest(value: unknown): Buffer {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.length > MAX_HTTP_TASK_BODY_BYTES) {
    throw new HttpResourceError(
      "request_too_large",
      413,
      `encoded task request exceeds ${MAX_HTTP_TASK_BODY_BYTES} bytes`,
    );
  }
  return encoded;
}

export function encodeTaskResponse(value: unknown): { status: number; body: Buffer } {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length <= MAX_HTTP_TASK_BODY_BYTES) return { status: 200, body };
  return {
    status: 500,
    body: Buffer.from(JSON.stringify({
      error: {
        code: "response_too_large",
        message: `encoded task response exceeds ${MAX_HTTP_TASK_BODY_BYTES} bytes`,
      },
    }), "utf8"),
  };
}

function splitHeaderValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim());
}

export function parseContentLength(value: string | string[] | undefined): number | undefined {
  const values = splitHeaderValues(value);
  if (values.length === 0) return undefined;
  if (values.some((item) => !/^\d+$/.test(item))) {
    throw new HttpResourceError("invalid_http_body", 400, "invalid Content-Length", true);
  }
  const parsed = values.map(Number);
  if (new Set(parsed).size !== 1 || parsed.some((item) => !Number.isSafeInteger(item))) {
    throw new HttpResourceError("invalid_http_body", 400, "conflicting Content-Length", true);
  }
  return parsed[0];
}

export function validateIdentityEncoding(value: string | string[] | undefined): void {
  const encodings = splitHeaderValues(value).map((item) => item.toLowerCase());
  if (encodings.some((item) => item !== "identity")) {
    throw new HttpResourceError(
      "unsupported_content_encoding",
      415,
      "supported HTTP task binding accepts identity encoding only",
      true,
    );
  }
}

export function validateTaskRequestHeaders(req: http.IncomingMessage): number | undefined {
  validateIdentityEncoding(req.headers["content-encoding"]);
  const distinct = req.headersDistinct?.["content-length"];
  const contentLength = parseContentLength(distinct ?? req.headers["content-length"]);
  if (req.headers["transfer-encoding"] !== undefined && contentLength !== undefined) {
    throw new HttpResourceError(
      "invalid_http_body",
      400,
      "Content-Length and Transfer-Encoding cannot be combined",
      true,
    );
  }
  if (contentLength !== undefined && contentLength > MAX_HTTP_TASK_BODY_BYTES) {
    throw new HttpResourceError(
      "request_too_large",
      413,
      `encoded task request exceeds ${MAX_HTTP_TASK_BODY_BYTES} bytes`,
      true,
    );
  }
  return contentLength;
}

export function validateTaskResponseHeaders(headers: http.IncomingHttpHeaders): void {
  validateIdentityEncoding(headers["content-encoding"]);
  const contentLength = parseContentLength(headers["content-length"]);
  if (contentLength !== undefined && contentLength > MAX_HTTP_TASK_BODY_BYTES) {
    throw new HttpResourceError(
      "response_too_large",
      500,
      `encoded task response exceeds ${MAX_HTTP_TASK_BODY_BYTES} bytes`,
      true,
    );
  }
}

export function resourceErrorBody(error: HttpResourceError): Buffer {
  return Buffer.from(JSON.stringify({ error: { code: error.code, message: error.message } }), "utf8");
}
