import { readFile } from "node:fs/promises";
import { newAvatarSession } from "../src/index.js";

// Input must be raw mono s16le PCM, not a WAV file (no container header).
const pcm = await readFile(process.argv[2]!);
await using session = newAvatarSession({
  apiKey: process.env.SPATIUS_API_KEY!,
  appId: process.env.SPATIUS_APP_ID!,
  avatarId: process.env.SPATIUS_AVATAR_ID!,
  audioFormat: "ogg_opus",
  sampleRate: 24000,
  bitrate: 64000,
  oggOpusEncoder: { frameDurationMs: 20, application: "audio" },
  // Optional: onEncodedAudio(reqId, ogg) receives one complete Ogg stream.
  transportFrames: (data, last) => console.log(data.length, last),
});
await session.init();
await session.start();
for (let offset = 0; offset < pcm.length; offset += 4800) {
  await session.sendAudio(pcm.subarray(offset, offset + 4800));
}
await session.sendAudio(new Uint8Array(), true);
// Keep the session open while the avatar finishes responding.
await new Promise<void>((resolve) => process.once("SIGINT", resolve));
