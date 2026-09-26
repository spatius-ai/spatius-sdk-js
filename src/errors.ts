export enum AvatarSDKErrorCode {
  sessionTokenExpired = "sessionTokenExpired",
  sessionTokenInvalid = "sessionTokenInvalid",
  appIDUnrecognized = "appIDUnrecognized",
  appIDMismatch = "appIDMismatch",
  avatarNotFound = "avatarNotFound",
  billingRequired = "billingRequired",
  creditsExhausted = "creditsExhausted",
  sessionDurationExceeded = "sessionDurationExceeded",
  unsupportedSampleRate = "unsupportedSampleRate",
  invalidEgressConfig = "invalidEgressConfig",
  egressUnavailable = "egressUnavailable",
  idleTimeout = "idleTimeout",
  upstreamError = "upstreamError",
  invalidRequest = "invalidRequest",
  connectionFailed = "connectionFailed",
  connectionClosed = "connectionClosed",
  protocolError = "protocolError",
  serverError = "serverError",
  unknown = "unknown",
}

export interface ErrorContext {
  phase?: string;
  httpStatus?: number;
  serverCode?: string;
  serverTitle?: string;
  serverDetail?: string;
  connectionId?: string;
  reqId?: string;
  rawBody?: string;
  closeCode?: number;
  closeReason?: string;
  cause?: unknown;
}

export class AvatarSDKError extends Error {
  readonly phase: string;
  readonly httpStatus?: number;
  readonly serverCode?: string;
  readonly serverTitle?: string;
  readonly serverDetail?: string;
  readonly connectionId?: string;
  readonly reqId?: string;
  readonly rawBody?: string;
  readonly closeCode?: number;
  readonly closeReason?: string;

  constructor(
    readonly code: AvatarSDKErrorCode,
    message: string,
    context: ErrorContext = {},
  ) {
    super(message, { cause: context.cause });
    this.name = "AvatarSDKError";
    Object.assign(this, context);
    this.phase = context.phase ?? "unknown";
  }
}

export class SessionTokenError extends AvatarSDKError {
  constructor(
    message: string,
    code = AvatarSDKErrorCode.invalidRequest,
    context: ErrorContext = {},
  ) {
    super(code, message, { ...context, phase: "session_token" });
    this.name = "SessionTokenError";
  }
}

export function classifyError(context: ErrorContext): AvatarSDKErrorCode {
  const C = AvatarSDKErrorCode;
  const code = context.serverCode;
  const text = [code, context.serverTitle, context.serverDetail]
    .join(" | ")
    .toLowerCase();
  const has = (...values: string[]) =>
    values.some((value) => text.includes(value));
  if (code === "3" || code === "INVALID_ARGUMENT")
    return has("livekit", "agora", "egress")
      ? C.invalidEgressConfig
      : C.invalidRequest;
  if (code === "16" || code === "UNAUTHENTICATED") return C.invalidEgressConfig;
  if (code === "14" || code === "UNAVAILABLE") return C.egressUnavailable;
  if (code === "4001" || has("credits exhausted")) return C.creditsExhausted;
  if (
    code === "4002" ||
    has("session time limit reached", "maximum session duration")
  )
    return C.sessionDurationExceeded;
  if (has("session denied") || context.httpStatus === 402)
    return C.billingRequired;
  if (has("invalid session token", "empty token")) return C.sessionTokenInvalid;
  if (has("token is expired", "session token expired"))
    return C.sessionTokenExpired;
  if (has("app id mismatch")) return C.appIDMismatch;
  if (has("appidunrecognized", "app id unrecognized"))
    return C.appIDUnrecognized;
  if (has("avatar not found")) return C.avatarNotFound;
  if (has("unsupported sample rate")) return C.unsupportedSampleRate;
  if (has("livekit silence timeout", "no audio input for"))
    return C.idleTimeout;
  if (
    has(
      "livekit_egress",
      "agora_egress",
      "missing livekit credentials",
      "provide api_token or both api_key and api_secret",
      "unauthorized",
    )
  )
    return C.invalidEgressConfig;
  if (
    has(
      "egress client is not configured on server",
      "failed to create egress connection",
    )
  )
    return C.egressUnavailable;
  if (
    has(
      "driven server returned non-200 status code",
      "driven server request failed",
    )
  )
    return C.upstreamError;
  if (
    has(
      "expected clientconfiguresession message",
      "clientconfiguresession message is nil",
      "unexpected message type",
      "failed to unmarshal initial message",
    )
  )
    return C.protocolError;
  const status = context.httpStatus;
  if (status === 401) return C.sessionTokenExpired;
  if (status === 404) return C.appIDUnrecognized;
  if (status === 400 && context.phase === "websocket_connect")
    return C.sessionTokenInvalid;
  if (status && status >= 400 && status < 500) return C.invalidRequest;
  if (status && status >= 500) return C.serverError;
  return ["websocket_handshake", "websocket_runtime"].includes(
    context.phase ?? "",
  )
    ? C.serverError
    : C.unknown;
}

export function httpError(
  status: number,
  rawBody: string,
  phase: string,
): AvatarSDKError {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object")
      details = parsed.errors?.[0] ?? parsed;
  } catch {
    /* Keep the raw body for non-JSON failures. */
  }
  const str = (value: unknown) => (value == null ? undefined : String(value));
  const context: ErrorContext = {
    phase,
    httpStatus: status,
    rawBody,
    serverCode: str(details.code ?? details.id ?? details.error),
    serverTitle: str(details.title),
    serverDetail: str(details.detail ?? details.message),
  };
  const message = `Request failed (HTTP ${status})${context.serverDetail ? `: ${context.serverDetail}` : ""}`;
  return phase === "session_token"
    ? new SessionTokenError(message, classifyError(context), context)
    : new AvatarSDKError(classifyError(context), message, context);
}
