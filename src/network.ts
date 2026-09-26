import http from "node:http";
import https from "node:https";
import {
  applyRegion,
  normalizeConfig,
  type ResolvedConfig,
  type SessionConfig,
} from "./config.js";
import { AvatarSDKErrorCode, SessionTokenError, httpError } from "./errors.js";
import { recordDuration } from "./telemetry.js";
import { version } from "../package.json";

/** Node's shared agents reuse keep-alive connections and TLS sessions. No redirects. */
async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
) {
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new TypeError("Expected HTTP(S) endpoint");
  const data = JSON.stringify(body);
  const started = performance.now();
  let status: number | undefined;
  try {
    return await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = (endpoint.protocol === "https:" ? https : http).request(
          endpoint,
          {
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              ...headers,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            },
          },
          (response) => {
            status = response.statusCode ?? 0;
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1_048_576)
                response.destroy(new Error("HTTP response exceeds 1 MiB"));
              else chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: status!,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(data);
      },
    );
  } finally {
    recordDuration(
      "http.client.request.duration",
      performance.now() - started,
      {
        "http.request.method": "POST",
        "server.address": endpoint.hostname,
        ...(status === undefined
          ? {}
          : { "http.response.status_code": status }),
      },
    );
  }
}

let cachedRegion: { region: string; at: number } | undefined;

export async function resolveEndpoints(config: ResolvedConfig): Promise<void> {
  if (config.consoleEndpointUrl && config.ingressEndpointUrl) return;
  if (config.region !== "auto") {
    applyRegion(config, config.region);
    return;
  }
  if (config.consoleEndpointUrl || config.ingressEndpointUrl) {
    applyRegion(config, "us-west");
    return;
  }
  if (!cachedRegion || performance.now() - cachedRegion.at >= 300_000) {
    try {
      const response = await post(
        "https://global.spatialwalk.top/bootstrap",
        {
          app_id: config.appId,
          sdk_version: version,
          region: "auto",
          platform: "node",
        },
        {},
        Math.min(config.timeoutMs, 5_000),
      );
      const current =
        response.status === 200
          ? JSON.parse(response.body)?.region?.current
          : undefined;
      if (
        typeof current === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(current)
      )
        cachedRegion = { region: current, at: performance.now() };
    } catch {
      /* Use the last successful region, even if stale. */
    }
  }
  applyRegion(config, cachedRegion?.region ?? "us-west");
}

export async function fetchSessionToken(
  config: ResolvedConfig,
): Promise<string> {
  if (!config.apiKey) throw new TypeError("Missing API key");
  const url = new URL(config.consoleEndpointUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/session-tokens";
  let response;
  try {
    response = await post(
      url.toString(),
      { expireAt: Math.floor(config.expireAt.getTime() / 1000) },
      { "X-Api-Key": config.apiKey },
      config.timeoutMs,
    );
  } catch (cause) {
    throw new SessionTokenError(
      "Failed to create session token",
      AvatarSDKErrorCode.connectionFailed,
      { cause },
    );
  }
  if (response.status !== 200)
    throw httpError(response.status, response.body, "session_token");
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    /* Report a protocol error below. */
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length) {
    const status = Number(parsed.errors[0]?.status);
    throw httpError(
      Number.isFinite(status) ? status : response.status,
      response.body,
      "session_token",
    );
  }
  if (typeof parsed?.sessionToken !== "string" || !parsed.sessionToken)
    throw new SessionTokenError(
      "Missing or invalid sessionToken in response",
      AvatarSDKErrorCode.protocolError,
      { rawBody: response.body },
    );
  return parsed.sessionToken;
}

const tokens = new Map<string, { token: string; expires: number }>();
function tokenKey(config: ResolvedConfig): string {
  return JSON.stringify([
    config.apiKey,
    config.appId,
    config.consoleEndpointUrl,
  ]);
}

export function cachedToken(config: ResolvedConfig): string | undefined {
  for (const [key, value] of tokens)
    if (Date.now() >= value.expires - 60_000) tokens.delete(key);
  return tokens.get(tokenKey(config))?.token;
}

export interface PrewarmOptions extends Pick<
  SessionConfig,
  "appId" | "region" | "consoleEndpointUrl" | "ingressEndpointUrl" | "timeoutMs"
> {
  apiKey?: string;
  prefetchSessionToken?: boolean;
  sessionExpireAt?: Date;
}

export interface PrewarmResult {
  region?: string;
  consoleEndpointUrl: string;
  ingressEndpointUrl: string;
  sessionTokenPrefetched: boolean;
}

/** Best-effort region resolution and optional reusable token prefetch. Never throws. */
export async function prewarm(options: PrewarmOptions): Promise<PrewarmResult> {
  const result: PrewarmResult = {
    consoleEndpointUrl: "",
    ingressEndpointUrl: "",
    sessionTokenPrefetched: false,
  };
  try {
    const config = normalizeConfig({
      ...options,
      avatarId: "",
      apiKey: options.apiKey ?? "",
      expireAt: options.sessionExpireAt,
    });
    await resolveEndpoints(config);
    Object.assign(result, {
      region: config.region === "auto" ? undefined : config.region,
      consoleEndpointUrl: config.consoleEndpointUrl,
      ingressEndpointUrl: config.ingressEndpointUrl,
    });
    if (options.prefetchSessionToken && config.apiKey) {
      const token = await fetchSessionToken(config);
      cachedToken(config); // Evict expired credentials before retaining a new entry.
      tokens.set(tokenKey(config), {
        token,
        expires: config.expireAt.getTime(),
      });
      result.sessionTokenPrefetched = true;
    }
  } catch {
    /* Warm-up is optional and must not block application startup. */
  }
  return result;
}
