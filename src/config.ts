export enum AudioFormat {
  PCM_S16LE = "pcm_s16le",
  OGG_OPUS = "ogg_opus",
}

export interface LiveKitEgressConfig {
  url: string;
  apiToken?: string;
  /** @deprecated Prefer apiToken. */
  apiKey?: string;
  /** @deprecated Prefer apiToken. */
  apiSecret?: string;
  roomName: string;
  publisherId: string;
  extraAttributes?: Record<string, string>;
  idleTimeout?: number;
}

export interface AgoraEgressConfig {
  channelName: string;
  token?: string;
  uid?: number;
  publisherId?: string;
}

export interface SessionConfig {
  avatarId: string;
  apiKey: string;
  appId: string;
  expireAt?: Date;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: AudioFormat | "pcm_s16le" | "ogg_opus";
  useQueryAuth?: boolean;
  region?: string;
  consoleEndpointUrl?: string;
  ingressEndpointUrl?: string;
  livekitEgress?: LiveKitEgressConfig;
  agoraEgress?: AgoraEgressConfig;
  extraParams?: Record<string, string>;
  /** Receives the complete binary protobuf envelope, not decoded animation data. */
  transportFrames?: (data: Uint8Array, isLast: boolean) => void;
  onError?: (error: import("./errors.js").AvatarSDKError) => void;
  onClose?: () => void;
  /** Timeout per HTTP exchange / WebSocket upgrade / protocol handshake. */
  timeoutMs?: number;
}

export function normalizeConfig(config: SessionConfig) {
  const result = {
    ...config,
    expireAt: new Date(config.expireAt?.getTime() ?? Date.now() + 3_600_000),
    sampleRate: config.sampleRate ?? 16_000,
    bitrate: config.bitrate ?? 0,
    audioFormat: config.audioFormat ?? AudioFormat.PCM_S16LE,
    region: config.region?.trim() || "auto",
    consoleEndpointUrl: config.consoleEndpointUrl ?? "",
    ingressEndpointUrl: config.ingressEndpointUrl ?? "",
    timeoutMs: config.timeoutMs ?? 10_000,
    extraParams: { ...config.extraParams },
  };
  if (!Object.values(AudioFormat).includes(result.audioFormat as AudioFormat))
    throw new TypeError("Unsupported audio format");
  if (!Number.isFinite(result.expireAt.getTime()))
    throw new TypeError("Invalid expireAt");
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0)
    throw new TypeError("timeoutMs must be positive");
  if (config.livekitEgress && config.agoraEgress)
    throw new TypeError("Cannot configure both LiveKit and Agora egress");
  if (
    Object.values(result.extraParams).some((value) => typeof value !== "string")
  )
    throw new TypeError("extraParams values must be strings");
  if (result.region !== "auto") applyRegion(result, result.region);
  return result;
}

export type ResolvedConfig = ReturnType<typeof normalizeConfig>;

export function applyRegion(
  config: {
    region: string;
    consoleEndpointUrl: string;
    ingressEndpointUrl: string;
  },
  region: string,
): void {
  config.region = region;
  const domain = region.startsWith("cn-") ? "spatialwalk.top" : "spatius.ai";
  config.consoleEndpointUrl ||= `https://console.${region}.${domain}/v1/console`;
  config.ingressEndpointUrl ||= `wss://api.${region}.${domain}/v2/driveningress`;
}
