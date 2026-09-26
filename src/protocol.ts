import protobuf from "protobufjs/light.js";
import schema from "./proto.json";

const messageType =
  protobuf.Root.fromJSON(schema).lookupType("message.Message");

export interface ServerErrorMessage {
  connectionId?: string;
  reqId?: string;
  code?: number;
  message?: string;
}

interface Envelope {
  type: number;
  serverConfirmSession?: { connectionId?: string };
  serverError?: ServerErrorMessage;
  serverResponseAnimation?: {
    connectionId?: string;
    reqId?: string;
    end?: boolean;
  };
}

export function encodeMessage(message: Record<string, unknown>): Uint8Array {
  const error = messageType.verify(message);
  if (error) throw new TypeError(error);
  return messageType.encode(messageType.create(message)).finish();
}

export function decodeMessage(data: Uint8Array): Envelope {
  return messageType.decode(data) as unknown as Envelope;
}
