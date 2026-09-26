import {
  context,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import {
  W3CTraceContextPropagator,
  ExportResultCode,
  suppressTracing,
  type ExportResult,
} from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import {
  ProtobufTraceSerializer,
  ProtobufMetricsSerializer,
} from "@opentelemetry/otlp-transformer";
import { version } from "../package.json";

export const DEFAULT_TELEMETRY_ENDPOINT = "https://t.spatialwalk.top";
let endpoint = DEFAULT_TELEMETRY_ENDPOINT;
let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
const propagator = new W3CTraceContextPropagator();

/** Configure before using sessions. An empty string disables export and request tracing. */
export function configureTelemetry(value = DEFAULT_TELEMETRY_ENDPOINT): void {
  const next = value.trim().replace(/\/+$/, "");
  if (next) {
    const url = new URL(next);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new TypeError(
        "Telemetry endpoint must be an HTTP(S) URL without credentials, query or fragment",
      );
  }
  if ((tracerProvider || meterProvider) && endpoint !== next)
    throw new Error(
      "Call shutdownTelemetry() before changing the telemetry endpoint",
    );
  endpoint = next;
}

function initialize(): void {
  if (!endpoint || tracerProvider) return;
  const resource = resourceFromAttributes({
    "service.name": "spatius-server-sdk",
    "sdk.platform": "node",
    "sdk.package": "@spatius/server-sdk",
    "sdk.version": version,
  });
  // Private providers: do not replace the host application's global OTel providers.
  tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        otlpExporter(`${endpoint}/v1/traces`, ProtobufTraceSerializer),
      ),
    ],
  });
  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: {
          ...otlpExporter(`${endpoint}/v1/metrics`, ProtobufMetricsSerializer),
          selectAggregationTemporality: () => AggregationTemporality.DELTA,
        },
        exportIntervalMillis: 10_000,
        exportTimeoutMillis: 5_000,
      }),
    ],
  });
}

// The standard OTLP exporters merge host OTEL_* credentials into requests.
// Use the public OTel serializers with a private, bounded, best-effort transport.
function otlpExporter<T>(
  url: string,
  serializer: { serializeRequest(data: T): Uint8Array | undefined },
) {
  const pending = new Set<Promise<void>>();
  let closed = false;
  const forceFlush = async () => {
    await Promise.all(pending);
  };
  return {
    export(data: T, done: (result: ExportResult) => void): void {
      if (closed) {
        done({ code: ExportResultCode.FAILED });
        return;
      }
      const task = context.with(suppressTracing(context.active()), async () => {
        try {
          const body = serializer.serializeRequest(data);
          if (!body) throw new Error("OTLP serialization failed");
          const response = await fetch(url, {
            method: "POST",
            body: Buffer.from(body),
            redirect: "error",
            headers: {
              "Content-Type": "application/x-protobuf",
              "User-Agent": "spatius-server-sdk",
            },
            signal: AbortSignal.timeout(5_000),
          });
          await response.body?.cancel();
          done({
            code: response.ok
              ? ExportResultCode.SUCCESS
              : ExportResultCode.FAILED,
          });
        } catch {
          done({ code: ExportResultCode.FAILED });
        }
      });
      pending.add(task);
      void task.then(() => pending.delete(task));
    },
    forceFlush,
    async shutdown(): Promise<void> {
      closed = true;
      await forceFlush();
    },
  };
}

export function startSpan(
  name: string,
  attributes: Attributes = {},
): Span | undefined {
  try {
    initialize();
    return tracerProvider
      ?.getTracer("spatius", version)
      .startSpan(name, { attributes });
  } catch {
    return undefined;
  }
}

export function finishSpan(span: Span | undefined, error?: unknown): void {
  if (error) span?.setStatus({ code: SpanStatusCode.ERROR });
  // Do not record exception bodies, which may contain authentication material.
  span?.end();
}

export function traceContext(span: Span | undefined): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (span)
    propagator.inject(trace.setSpan(context.active(), span), carrier, {
      set: (target, key, value) => {
        target[key] = value;
      },
    });
  return carrier;
}

export function recordDuration(
  name: string,
  value: number,
  attributes: Attributes = {},
): void {
  try {
    initialize();
    meterProvider
      ?.getMeter("spatius", version)
      .createHistogram(name, { unit: "ms" })
      .record(value, attributes);
  } catch {
    /* Telemetry must not prevent session work. */
  }
}

/** Flush and release SDK-owned exporters. Does not shut down application telemetry. */
export async function shutdownTelemetry(): Promise<void> {
  const providers = [tracerProvider, meterProvider];
  tracerProvider = undefined;
  meterProvider = undefined;
  await Promise.allSettled(providers.map((provider) => provider?.shutdown()));
}
