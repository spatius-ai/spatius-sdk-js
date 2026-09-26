import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessage, decodeMessage } from "../src/protocol.js";
import { classifyError, type ErrorContext } from "../src/errors.js";

// Generated with message_pb2.py from spatius-sdk-python 8b7d927:
// Message(...).SerializeToString(deterministic=True).hex().
test("audio encoding matches Python protobuf bytes including trace context", () => {
  const actual = encodeMessage({
    type: 3,
    clientAudioInput: {
      reqId: "req-42",
      end: true,
      audio: Buffer.from([1, 2, 255]),
      traceContext: {
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
    },
  });
  assert.equal(
    Buffer.from(actual).toString("hex"),
    "0803224a0a067265712d343210011a030102ff22390a3730302d31313131313131313131313131313131313131313131313131313131313131312d323232323232323232323232323232322d3031",
  );
});

test("Python-generated confirmation and server errors decode correctly", () => {
  const confirmation = decodeMessage(
    Buffer.from("08021a100a0e707974686f6e2d636f6e6669726d", "hex"),
  );
  assert.equal(confirmation.type, 2);
  assert.equal(
    confirmation.serverConfirmSession?.connectionId,
    "python-confirm",
  );
  const error = decodeMessage(
    Buffer.from(
      "08042a200a03636964120372696418a21f22116475726174696f6e206578636565646564",
      "hex",
    ),
  );
  assert.equal(error.type, 4);
  assert.equal(error.serverError?.code, 4002);
  assert.equal(error.serverError?.reqId, "rid");
  assert.equal(error.serverError?.connectionId, "cid");
  assert.equal(error.serverError?.message, "duration exceeded");
});

test("structured errors preserve Python classification precedence", () => {
  const cases: [ErrorContext, string][] = [
    [
      { serverCode: "3", serverDetail: "bad LiveKit URL" },
      "invalidEgressConfig",
    ],
    [{ serverCode: "3", serverDetail: "bad input" }, "invalidRequest"],
    [{ serverCode: "16" }, "invalidEgressConfig"],
    [{ serverCode: "14" }, "egressUnavailable"],
    [{ serverCode: "4001", httpStatus: 402 }, "creditsExhausted"],
    [{ httpStatus: 404, serverDetail: "avatar not found" }, "avatarNotFound"],
    [{ httpStatus: 404 }, "appIDUnrecognized"],
    [
      { httpStatus: 401, serverDetail: "invalid session token" },
      "sessionTokenInvalid",
    ],
    [{ httpStatus: 401 }, "sessionTokenExpired"],
    [{ httpStatus: 400, phase: "websocket_connect" }, "sessionTokenInvalid"],
    [{ httpStatus: 400, phase: "session_token" }, "invalidRequest"],
    [{ serverDetail: "app id mismatch", httpStatus: 400 }, "appIDMismatch"],
    [{ serverDetail: "no audio input for 60 seconds" }, "idleTimeout"],
    [{ serverDetail: "driven server request failed" }, "upstreamError"],
    [{ serverDetail: "unexpected message type" }, "protocolError"],
    [{ phase: "websocket_runtime" }, "serverError"],
    [{}, "unknown"],
  ];
  for (const [context, expected] of cases)
    assert.equal(classifyError(context), expected, JSON.stringify(context));
});
