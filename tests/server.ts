import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import protobuf from "protobufjs";
import type { TestContext } from "node:test";

// Parse the source .proto independently of the SDK's generated JSON descriptor.
export const wire = (
  await protobuf.load(
    fileURLToPath(new URL("../proto/message.proto", import.meta.url)),
  )
).lookupType("message.Message");
export const encode = (value: Record<string, unknown>) =>
  wire.encode(wire.create(value)).finish();
export const decode = (value: Uint8Array) =>
  wire.toObject(wire.decode(value), { bytes: Buffer });

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("Condition did not become true");
    await delay(5);
  }
}

export async function server(
  t: TestContext,
  options: {
    handshake?: (ws: WebSocket) => void;
    http?: (req: IncomingMessage, res: ServerResponse) => void;
    rejectUpgrade?: boolean;
  } = {},
) {
  const requests: {
    url?: string;
    headers: IncomingMessage["headers"];
    body: string;
  }[] = [];
  const upgrades: IncomingMessage[] = [];
  const messages: ReturnType<typeof decode>[] = [];
  const sockets: WebSocket[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (options.http) options.http(req, res);
      else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ sessionToken: "session & token" }));
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    upgrades.push(request);
    if (options.rejectUpgrade) {
      const body = JSON.stringify({
        errors: [{ code: "expired", detail: "session token expired" }],
      });
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws),
    );
  });
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (raw) => {
      const message = decode(raw as Buffer);
      messages.push(message);
      if (message.type === 1) {
        if (options.handshake) options.handshake(ws);
        else
          ws.send(
            encode({
              type: 2,
              serverConfirmSession: { connectionId: "connection-123" },
            }),
          );
      }
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    upgrades,
    messages,
    sockets,
    config: {
      apiKey: "test-api-key",
      appId: "app & id",
      avatarId: "avatar/123",
      consoleEndpointUrl: `${url}/v1/console/`,
      ingressEndpointUrl: `${url}/v2/driveningress/?keep=1`,
    },
  };
}
