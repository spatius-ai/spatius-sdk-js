export { AvatarSession, newAvatarSession, generateLogId } from "./session.js";
export {
  AudioFormat,
  type SessionConfig,
  type LiveKitEgressConfig,
  type AgoraEgressConfig,
} from "./config.js";
export {
  AvatarSDKError,
  AvatarSDKErrorCode,
  SessionTokenError,
  type ErrorContext,
} from "./errors.js";
export { prewarm, type PrewarmOptions, type PrewarmResult } from "./network.js";
export {
  configureTelemetry,
  shutdownTelemetry,
  DEFAULT_TELEMETRY_ENDPOINT,
} from "./telemetry.js";
