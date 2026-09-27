import { randomBytes } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import type { Span } from "@opentelemetry/api";
import { OggOpusEncoder } from "./audio-encoder.js";
import {
  normalizeConfig,
  type SessionConfig,
  type ResolvedConfig,
} from "./config.js";
import {
  AvatarSDKError,
  AvatarSDKErrorCode as C,
  classifyError,
  httpError,
} from "./errors.js";
import { cachedToken, fetchSessionToken, resolveEndpoints } from "./network.js";
import {
  decodeMessage,
  encodeMessage,
  type ServerErrorMessage,
} from "./protocol.js";
import {
  startSpan,
  finishSpan,
  traceContext,
  recordDuration,
} from "./telemetry.js";

export function generateLogId(): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${timestamp}_${randomBytes(9).toString("base64url")}`;
}

type State =
  | "new"
  | "initializing"
  | "ready"
  | "connecting"
  | "open"
  | "closing"
  | "closed";

export class AvatarSession {
  readonly config: Readonly<ResolvedConfig>;
  private state: State = "new";
  private token?: string;
  private socket?: WebSocket;
  private currentReqId?: string;
  private lastReqId?: string;
  private sessionStarted?: number;
  private requests = new Map<
    string,
    {
      span?: Span;
      started: number;
      firstFrame: boolean;
      sentAudio: boolean;
      encoder?: OggOpusEncoder;
    }
  >();
  private audioQueue: Promise<unknown> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closeNotified = false;
  private cancelStart?: () => void;
  connectionId?: string;

  constructor(config: SessionConfig) {
    this.config = normalizeConfig(config);
  }

  async init(): Promise<void> {
    if (this.state !== "new")
      throw new Error("Session has already been initialized or closed");
    if (!this.config.apiKey) throw new TypeError("Missing API key");
    this.state = "initializing";
    const started = performance.now();
    const span = startSpan("avatar.session.init", this.attributes());
    try {
      await resolveEndpoints(this.config);
      const token =
        cachedToken(this.config) ?? (await fetchSessionToken(this.config));
      if (this.state !== "initializing")
        throw new AvatarSDKError(
          C.connectionClosed,
          "Session closed during initialization",
          { phase: "session_token" },
        );
      this.token = token;
      this.state = "ready";
      finishSpan(span);
    } catch (error) {
      if (this.state === "initializing") this.state = "new";
      finishSpan(span, error);
      throw error;
    } finally {
      recordDuration(
        "avatar.session.init.duration",
        performance.now() - started,
        this.attributes(),
      );
    }
  }

  async start(): Promise<string> {
    if (this.state !== "ready")
      throw new Error(
        "Call init() before start(); sessions cannot be restarted",
      );
    if (!this.config.avatarId || !this.config.appId)
      throw new TypeError("Missing avatar ID or app ID");
    const endpoint = new URL(this.config.ingressEndpointUrl);
    if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
    if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    if (!["ws:", "wss:"].includes(endpoint.protocol))
      throw new TypeError("Unsupported ingress URL scheme");
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/websocket";
    endpoint.searchParams.set("id", this.config.avatarId);
    const headers: Record<string, string> = {};
    if (this.config.useQueryAuth) {
      endpoint.searchParams.set("appId", this.config.appId);
      endpoint.searchParams.set("sessionKey", this.token!);
    } else {
      headers["X-App-ID"] = this.config.appId;
      headers["X-Session-Key"] = this.token!;
      endpoint.searchParams.delete("appId");
      endpoint.searchParams.delete("sessionKey");
    }
    this.state = "connecting";
    const started = performance.now();
    const span = startSpan("avatar.session.start", this.attributes());
    try {
      const id = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let phase = "websocket_connect";
        const ws = new WebSocket(endpoint, {
          headers,
          handshakeTimeout: this.config.timeoutMs,
          perMessageDeflate: false,
        });
        this.socket = ws;
        const fail = (error: AvatarSDKError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.cancelStart = undefined;
          reject(error);
          ws.terminate();
        };
        const timeout = () =>
          fail(
            new AvatarSDKError(
              C.connectionFailed,
              "Timed out waiting for server",
              { phase },
            ),
          );
        let timer = setTimeout(timeout, this.config.timeoutMs);
        this.cancelStart = () =>
          fail(
            new AvatarSDKError(
              C.connectionClosed,
              "Session closed during start",
              { phase },
            ),
          );
        ws.on("open", () => {
          phase = "websocket_handshake";
          clearTimeout(timer);
          timer = setTimeout(timeout, this.config.timeoutMs);
          try {
            const config = this.config;
            ws.send(
              encodeMessage({
                type: 1,
                clientConfigureSession: {
                  sampleRate: config.sampleRate,
                  bitrate: config.bitrate,
                  audioFormat: config.audioFormat === "ogg_opus" ? 1 : 0,
                  transportCompression: 0,
                  egressType: config.livekitEgress
                    ? 1
                    : config.agoraEgress
                      ? 2
                      : 0,
                  livekitEgress: config.livekitEgress,
                  agoraEgress: config.agoraEgress,
                  extraParams: config.extraParams,
                },
              }),
              (error) => {
                if (error)
                  fail(
                    new AvatarSDKError(
                      C.connectionFailed,
                      "Failed to send session configuration",
                      { phase, cause: error },
                    ),
                  );
              },
            );
          } catch (cause) {
            fail(
              new AvatarSDKError(
                C.invalidRequest,
                "Invalid session configuration",
                { phase, cause },
              ),
            );
          }
        });
        ws.on("message", (raw: RawData, binary: boolean) => {
          if (settled) {
            if (this.state === "open" && binary) this.receive(toBuffer(raw));
            return;
          }
          try {
            if (!binary) throw new Error("Expected binary protobuf message");
            const message = decodeMessage(toBuffer(raw));
            if (message.type === 4 && message.serverError) {
              fail(serverError(message.serverError, phase));
              return;
            }
            const id = message.serverConfirmSession?.connectionId;
            if (message.type !== 2 || !id)
              throw new Error("Expected non-empty ServerConfirmSession");
            settled = true;
            clearTimeout(timer);
            this.cancelStart = undefined;
            this.connectionId = id;
            this.sessionStarted = performance.now();
            this.state = "open";
            resolve(id);
          } catch (cause) {
            fail(
              new AvatarSDKError(
                C.protocolError,
                "Invalid WebSocket handshake response",
                { phase, cause },
              ),
            );
          }
        });
        ws.on("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 1_048_576) chunks.push(chunk);
            else {
              fail(
                httpError(
                  response.statusCode ?? 0,
                  Buffer.concat(chunks).toString(),
                  phase,
                ),
              );
              response.destroy();
            }
          });
          response.on("error", (cause) =>
            fail(
              new AvatarSDKError(
                C.connectionFailed,
                "Failed to read upgrade rejection",
                { phase, cause },
              ),
            ),
          );
          response.on("end", () =>
            fail(
              httpError(
                response.statusCode ?? 0,
                Buffer.concat(chunks).toString(),
                phase,
              ),
            ),
          );
        });
        ws.on("error", (cause) => {
          const error = new AvatarSDKError(
            C.connectionFailed,
            "WebSocket transport error",
            { phase: settled ? "websocket_runtime" : phase, cause },
          );
          if (!settled) fail(error);
          else if (this.state === "open") this.notifyError(error);
        });
        ws.on("close", (code, reason) => {
          const error = new AvatarSDKError(
            C.connectionClosed,
            "WebSocket connection closed",
            {
              phase: settled ? "websocket_runtime" : phase,
              closeCode: code,
              closeReason: reason.toString(),
            },
          );
          if (!settled) fail(error);
          else if (this.state === "open" && code !== 1000 && code !== 1001)
            this.notifyError(error);
          this.finishClose();
        });
      });
      finishSpan(span);
      return id;
    } catch (error) {
      finishSpan(span, error);
      await this.close();
      throw error;
    } finally {
      recordDuration(
        "avatar.session.start.duration",
        performance.now() - started,
        this.attributes(),
      );
    }
  }

  /** Consecutive chunks share an ID until end=true. Await sends for backpressure; do not mutate audio until resolved. */
  async sendAudio(audio: Uint8Array, end = false): Promise<string> {
    this.requireOpen();
    if (this.config.oggOpusEncoder && audio.length % 2)
      throw new TypeError("PCM input must be 16-bit aligned");
    const reqId = this.currentReqId ?? generateLogId();
    this.lastReqId = reqId;
    this.currentReqId = end ? undefined : reqId;
    if (!this.requests.has(reqId)) {
      const span = startSpan("driven.request", {
        ...this.attributes(),
        req_id: reqId,
      });
      this.requests.set(reqId, {
        span,
        started: performance.now(),
        firstFrame: true,
        sentAudio: false,
      });
    }
    const request = this.requests.get(reqId)!;
    return this.enqueueAudio(async () => {
      const requireActive = () => {
        this.requireOpen();
        if (this.requests.get(reqId) !== request)
          throw new Error("Audio request has already finished");
      };
      const transmit = async (payload: Uint8Array, final: boolean) => {
        requireActive();
        const propagated = !request.sentAudio
          ? traceContext(request.span)
          : undefined;
        await this.send(
          {
            type: 3,
            clientAudioInput: {
              reqId,
              audio: payload,
              end: final,
              ...(propagated?.traceparent ? { traceContext: propagated } : {}),
            },
          },
          reqId,
        );
        request.sentAudio = true;
      };
      try {
        requireActive();
        if (this.config.oggOpusEncoder) {
          if (!request.encoder) {
            const encoder = await OggOpusEncoder.create(
              this.config.sampleRate,
              this.config.bitrate,
              this.config.oggOpusEncoder,
              !!this.config.onEncodedAudio,
            );
            // close() or a server error can arrive while the WASM asset is loading.
            try {
              requireActive();
            } catch (error) {
              encoder.destroy();
              throw error;
            }
            request.encoder = encoder;
          }
          let pages = 0;
          for (const page of request.encoder.encode(audio, end)) {
            await transmit(page, false);
            // ws callbacks can run as microtasks. Let timers, input and close events run.
            if (++pages % 16 === 0) await yieldToEventLoop();
          }
          if (end) {
            const completed = request.encoder.completedStream();
            request.encoder.destroy();
            request.encoder = undefined;
            await transmit(Buffer.alloc(0), true);
            if (completed) {
              try {
                this.config.onEncodedAudio?.(reqId, completed);
              } catch {
                /* Isolate application callbacks. */
              }
            }
          }
        } else {
          await transmit(audio, end);
        }
        if (end) request.span?.addEvent("audio.input.complete");
        return reqId;
      } catch (error) {
        this.finishRequest(reqId, error);
        throw error;
      }
    });
  }

  private enqueueAudio<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.audioQueue.then(operation);
    this.audioQueue = pending.catch(() => {});
    return pending;
  }

  /** Interrupt the most recent request, including after its final audio chunk. Egress only. */
  async interrupt(): Promise<string> {
    this.requireOpen();
    if (!this.config.livekitEgress && !this.config.agoraEgress)
      throw new Error("interrupt() requires egress mode");
    const reqId = this.lastReqId;
    if (!reqId) throw new Error("No request to interrupt");
    this.currentReqId = undefined;
    // Cancel buffered / queued encoding immediately; order the interrupt before new requests.
    this.finishRequest(reqId);
    return this.enqueueAudio(async () => {
      this.requireOpen();
      await this.send({ type: 7, clientInterrupt: { reqId } }, reqId);
      return reqId;
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";
    for (const reqId of this.requests.keys()) this.finishRequest(reqId);
    this.closePromise = new Promise<void>((resolve) => {
      const ws = this.socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        this.finishClose();
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        ws.terminate();
      }, 1_000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.cancelStart?.();
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    });
    return this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private requireOpen(): void {
    if (this.state !== "open" || this.socket?.readyState !== WebSocket.OPEN)
      throw new AvatarSDKError(
        C.connectionClosed,
        "WebSocket connection is not established",
        { phase: "websocket_send" },
      );
  }

  private async send(
    message: Record<string, unknown>,
    reqId: string,
  ): Promise<void> {
    try {
      const data = encodeMessage(message);
      await new Promise<void>((resolve, reject) =>
        this.socket!.send(data, (error) => (error ? reject(error) : resolve())),
      );
    } catch (cause) {
      const error = new AvatarSDKError(
        C.connectionFailed,
        "Failed to send WebSocket message",
        { phase: "websocket_send", reqId, cause },
      );
      this.finishRequest(reqId, error);
      throw error;
    }
  }

  private receive(data: Buffer): void {
    let message;
    try {
      message = decodeMessage(data);
    } catch (cause) {
      this.notifyError(
        new AvatarSDKError(C.protocolError, "Failed to decode server message", {
          phase: "websocket_runtime",
          cause,
        }),
      );
      return;
    }
    if (message.type === 5 && message.serverResponseAnimation) {
      const { reqId = "", end = false } = message.serverResponseAnimation;
      const request = this.requests.get(reqId);
      if (request?.firstFrame) {
        recordDuration(
          "avatar.request.ttfa",
          performance.now() - request.started,
          this.attributes(),
        );
        request.firstFrame = false;
      }
      if (end) this.finishRequest(reqId);
      if (!this.config.livekitEgress && !this.config.agoraEgress) {
        try {
          this.config.transportFrames?.(data, end);
        } catch {
          /* Isolate application callbacks. */
        }
      }
    } else if (message.type === 4 && message.serverError) {
      const error = serverError(message.serverError, "websocket_runtime");
      if (error.reqId) this.finishRequest(error.reqId, error);
      this.notifyError(error);
    }
  }

  private finishRequest(reqId: string, error?: unknown): void {
    const request = this.requests.get(reqId);
    if (!request) return;
    request.encoder?.destroy();
    request.encoder = undefined;
    if (this.currentReqId === reqId) this.currentReqId = undefined;
    finishSpan(request.span, error);
    recordDuration(
      "avatar.request.duration",
      performance.now() - request.started,
      this.attributes(),
    );
    this.requests.delete(reqId);
  }

  private finishClose(): void {
    this.state = "closed";
    this.token = undefined;
    this.currentReqId = undefined;
    for (const reqId of this.requests.keys()) this.finishRequest(reqId);
    if (this.sessionStarted !== undefined) {
      recordDuration(
        "avatar.session.duration",
        performance.now() - this.sessionStarted,
        this.attributes(),
      );
      this.sessionStarted = undefined;
    }
    if (!this.closeNotified) {
      this.closeNotified = true;
      try {
        this.config.onClose?.();
      } catch {
        /* Cleanup must complete. */
      }
    }
  }

  private attributes() {
    return {
      region: this.config.region,
      audio_format: this.config.audioFormat,
      egress_type: this.config.livekitEgress
        ? "livekit"
        : this.config.agoraEgress
          ? "agora"
          : "websocket",
    };
  }

  private notifyError(error: AvatarSDKError): void {
    try {
      this.config.onError?.(error);
    } catch {
      /* Isolate application callbacks. */
    }
  }
}

function toBuffer(raw: RawData): Buffer {
  return Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw);
}

function serverError(error: ServerErrorMessage, phase: string): AvatarSDKError {
  const context = {
    phase,
    serverCode: String(error.code ?? 0),
    serverDetail: error.message,
    connectionId: error.connectionId,
    reqId: error.reqId,
  };
  return new AvatarSDKError(
    classifyError(context),
    error.message || "Avatar session error",
    context,
  );
}

export function newAvatarSession(config: SessionConfig): AvatarSession {
  return new AvatarSession(config);
}
