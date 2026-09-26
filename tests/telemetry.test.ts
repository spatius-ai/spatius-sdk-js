import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import {
  configureTelemetry,
  shutdownTelemetry,
  newAvatarSession,
} from "../src/index.js";
import { server, waitFor } from "./server.js";

test("private telemetry exports locally and propagates W3C context only on each request's first chunk", async (t) => {
  const exports: { path?: string; body: Buffer; authorization?: string }[] = [];
  const collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      exports.push({
        path: req.url,
        body: Buffer.concat(chunks),
        authorization: req.headers.authorization,
      });
      res.end();
    });
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  t.after(async () => {
    await shutdownTelemetry();
    configureTelemetry("");
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });
  const provider = trace.getTracerProvider();
  // A host application's exporter credentials must never leak to the SDK collector.
  const oldHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer%20host-secret";
  t.after(() => {
    if (oldHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = oldHeaders;
  });
  configureTelemetry(
    `http://127.0.0.1:${(collector.address() as AddressInfo).port}`,
  );
  const backend = await server(t);
  const session = newAvatarSession(backend.config);
  t.after(() => session.close());
  await session.init();
  await session.start();
  await session.sendAudio(Buffer.from([1, 2]));
  await session.sendAudio(Buffer.from([3, 4]), true);
  await session.sendAudio(Buffer.from([5, 6]), true);
  await waitFor(() => backend.messages.length === 4);
  const audio = backend.messages
    .slice(1)
    .map((message) => message.clientAudioInput);
  assert.match(
    audio[0].traceContext.traceparent,
    /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
  );
  assert.equal(audio[1].traceContext, undefined);
  assert.notEqual(
    audio[0].traceContext.traceparent,
    audio[2].traceContext.traceparent,
  );
  assert.throws(() => configureTelemetry(""), /shutdownTelemetry/);
  assert.equal(trace.getTracerProvider(), provider);
  await session.close();
  await shutdownTelemetry();
  assert.ok(
    exports.some((item) => item.path === "/v1/traces" && item.body.length > 0),
  );
  assert.ok(
    exports.some((item) => item.path === "/v1/metrics" && item.body.length > 0),
  );
  assert.ok(
    exports.every((item) => item.authorization === undefined),
    "host OTLP credentials leaked",
  );
  assert.ok(
    exports.every((item) => !item.body.includes(Buffer.from("test-api-key"))),
  );
  configureTelemetry("");
});

test("invalid telemetry endpoints are rejected", () => {
  for (const endpoint of [
    "file:///tmp/otel",
    "https://otel.example?token=x",
    "https://otel.example/#fragment",
    "https://user:password@otel.example",
  ])
    assert.throws(() => configureTelemetry(endpoint));
});
