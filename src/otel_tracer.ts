// SPDX-License-Identifier: Apache-2.0
/**
 * OpenTelemetry span helpers for IICP SDK nodes — ADR-014 TRACE-01/TRACE-02.
 *
 * Node-side spans:
 *   iicp.task.validate  (TRACE-01) — request parsing, nonce check, auth
 *   iicp.task.execute   (TRACE-02) — handler dispatch and response
 *
 * Behaviour:
 *   - When @opentelemetry/api is installed AND OTEL_EXPORTER_OTLP_ENDPOINT is set:
 *     exports spans to the configured collector via OTLP/HTTP.
 *   - Otherwise: uses a no-op tracer — call sites need no conditionals.
 *
 * W3C traceparent propagation is handled in node.ts at the HTTP layer; this
 * module manages the span lifecycle within the node process.
 */

interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: Error): void;
  end(): void;
}

interface TracerLike {
  startSpan(name: string): SpanLike;
}

class NoopSpan implements SpanLike {
  setAttribute(_key: string, _value: string | number | boolean): void {}
  recordException(_err: Error): void {}
  end(): void {}
}

class NoopTracer implements TracerLike {
  startSpan(_name: string): SpanLike { return new NoopSpan(); }
}

let _tracer: TracerLike | null = null;
let _initialised = false;

async function _init(): Promise<TracerLike> {
  if (_tracer) return _tracer;
  if (_initialised) return new NoopTracer();
  _initialised = true;

  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "";
  try {
    const api = await import("@opentelemetry/api").catch(() => null);
    if (!api) {
      _tracer = new NoopTracer();
      return _tracer;
    }
    if (endpoint) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk: any = await import("@opentelemetry/sdk-trace-node" as string).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exp: any = await import("@opentelemetry/exporter-trace-otlp-http" as string).catch(() => null);
      if (sdk && exp) {
        const provider = new sdk.NodeTracerProvider();
        const exporter = new exp.OTLPTraceExporter({ url: endpoint });
        provider.addSpanProcessor(new sdk.BatchSpanProcessor(exporter));
        provider.register();
        _tracer = api.trace.getTracer("iicp.client");
        return _tracer;
      }
    }
    _tracer = api.trace.getTracer("iicp.client");
    return _tracer;
  } catch {
    _tracer = new NoopTracer();
    return _tracer;
  }
}

/** TRACE-01: iicp.task.validate — wraps request parsing and auth check. */
export async function withTaskValidateSpan<T>(taskId: string, fn: (span: SpanLike) => T): Promise<T> {
  const tracer = await _init();
  const span = tracer.startSpan("iicp.task.validate");
  span.setAttribute("iicp.task_id", taskId);
  try {
    return fn(span);
  } finally {
    span.end();
  }
}

/** TRACE-02: iicp.task.execute — wraps handler dispatch and response. */
export async function withTaskExecuteSpan<T>(taskId: string, intent: string, fn: (span: SpanLike) => Promise<T>): Promise<T> {
  const tracer = await _init();
  const span = tracer.startSpan("iicp.task.execute");
  span.setAttribute("iicp.task_id", taskId);
  span.setAttribute("iicp.intent", intent);
  try {
    return await fn(span);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
