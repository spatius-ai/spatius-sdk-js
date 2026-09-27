import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OggOpusEncoderConfig } from "./config.js";

interface Codec {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(pointer: number): void;
  encoder_create(rate: number, bitrate: number, application: number): number;
  encoder_lookahead(encoder: number): number;
  opus_encode(
    encoder: number,
    pcm: number,
    samples: number,
    output: number,
    maxBytes: number,
  ): number;
  opus_encoder_destroy(encoder: number): void;
}

let codecPromise: Promise<Codec> | undefined;
function loadCodec(): Promise<Codec> {
  return (codecPromise ??= (async () => {
    const bytes = await readFile(new URL("./opus.wasm", import.meta.url));
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { emscripten_notify_memory_growth() {} },
      wasi_snapshot_preview1: {
        // No filesystem or stdio capabilities. These libc fallbacks return WASI EBADF.
        fd_close: () => 8,
        fd_write: () => 8,
        fd_seek: () => 8,
      },
    });
    const codec = instance.exports as unknown as Codec;
    codec._initialize();
    return codec;
  })());
}

const applications = { voip: 2048, audio: 2049, restricted_lowdelay: 2051 };
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte << 24;
  for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

/** One complete packet per page. Opus packets here are far below the 65,025 byte page limit. */
export function oggPage(
  packet: Uint8Array,
  granule: number,
  serial: number,
  sequence: number,
  flags = 0,
): Buffer {
  const segments = Math.floor(packet.length / 255) + 1;
  if (segments > 255)
    throw new RangeError("Opus packet exceeds Ogg page capacity");
  const page = Buffer.alloc(27 + segments + packet.length);
  page.write("OggS");
  page[5] = flags;
  page.writeBigUInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequence, 18);
  page[26] = segments;
  page.fill(255, 27, 27 + segments - 1);
  page[27 + segments - 1] = packet.length % 255;
  page.set(packet, 27 + segments);
  let crc = 0;
  for (const byte of page)
    crc = (crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]!;
  page.writeUInt32LE(crc >>> 0, 22);
  return page;
}

/** Internal streaming encoder. Only a partial PCM frame and the last packet are retained. */
export class OggOpusEncoder {
  private encoder = 0;
  private pcm = 0;
  private output = 0;
  private readonly frame: Buffer;
  private buffered = 0;
  private pending?: Buffer;
  private encodedSamples = 0;
  private inputSamples = 0;
  private sequence = 0;
  private readonly serial = randomBytes(4).readUInt32LE();
  private readonly preSkip: number;
  private readonly scale: number;
  private ended = false;
  private collected?: Buffer[];

  static async create(
    rate: number,
    bitrate: number,
    config: OggOpusEncoderConfig,
    collect = false,
  ): Promise<OggOpusEncoder> {
    return new OggOpusEncoder(
      await loadCodec(),
      rate,
      bitrate,
      config,
      collect,
    );
  }

  private constructor(
    private readonly codec: Codec,
    private readonly rate: number,
    bitrate: number,
    config: OggOpusEncoderConfig,
    collect: boolean,
  ) {
    this.scale = 48000 / rate;
    this.frame = Buffer.alloc(
      ((rate * (config.frameDurationMs ?? 20)) / 1000) * 2,
    );
    try {
      this.encoder = codec.encoder_create(
        rate,
        bitrate,
        applications[config.application ?? "voip"],
      );
      this.pcm = codec.malloc(this.frame.length);
      this.output = codec.malloc(4000);
      if (!this.encoder || !this.pcm || !this.output)
        throw new Error("Could not allocate Opus encoder");
      const lookahead = codec.encoder_lookahead(this.encoder);
      if (lookahead < 0) throw new Error(`Opus lookahead failed: ${lookahead}`);
      this.preSkip = lookahead * this.scale;
      if (collect) this.collected = [];
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  *encode(pcm: Uint8Array, end: boolean): Generator<Buffer> {
    if (this.ended || !this.encoder) throw new Error("Opus stream is closed");
    if (pcm.length % 2) throw new TypeError("PCM input must be 16-bit aligned");
    this.inputSamples += pcm.length / 2;
    let offset = 0;
    while (offset < pcm.length) {
      const size = Math.min(
        pcm.length - offset,
        this.frame.length - this.buffered,
      );
      this.frame.set(pcm.subarray(offset, offset + size), this.buffered);
      this.buffered += size;
      offset += size;
      if (this.buffered === this.frame.length) {
        yield* this.encodeFrame();
        this.buffered = 0;
      }
    }
    if (!end) return;
    this.ended = true;
    if (this.buffered) {
      this.frame.fill(0, this.buffered);
      yield* this.encodeFrame();
      this.buffered = 0;
    }
    const finalGranule = this.preSkip + this.inputSamples * this.scale;
    // Encode delay-flushing silence, then trim it (and partial-frame padding) via EOS.
    // An empty request produces no Ogg stream, only the protocol end marker.
    while (
      this.inputSamples &&
      this.encodedSamples * this.scale < finalGranule
    ) {
      this.frame.fill(0);
      yield* this.encodeFrame();
    }
    if (this.pending) {
      yield this.page(this.pending, finalGranule, 4);
      this.pending = undefined;
    }
  }

  private *encodeFrame(): Generator<Buffer> {
    if (!this.encoder) throw new Error("Opus stream is closed");
    const { codec } = this;
    new Uint8Array(codec.memory.buffer, this.pcm, this.frame.length).set(
      this.frame,
    );
    const size = codec.opus_encode(
      this.encoder,
      this.pcm,
      this.frame.length / 2,
      this.output,
      4000,
    );
    if (size < 0) throw new Error(`Opus encoding failed: ${size}`);
    const packet = Buffer.from(
      new Uint8Array(codec.memory.buffer, this.output, size),
    );
    if (!this.sequence) {
      const head = Buffer.alloc(19);
      head.write("OpusHead");
      head[8] = 1;
      head[9] = 1;
      head.writeUInt16LE(this.preSkip, 10);
      head.writeUInt32LE(this.rate, 12);
      yield this.page(head, 0, 2);
      const vendor = Buffer.from("spatius-server-sdk");
      const tags = Buffer.alloc(16 + vendor.length);
      tags.write("OpusTags");
      tags.writeUInt32LE(vendor.length, 8);
      tags.set(vendor, 12);
      yield this.page(tags, 0);
    }
    if (this.pending)
      yield this.page(this.pending, this.encodedSamples * this.scale);
    this.pending = packet;
    this.encodedSamples += this.frame.length / 2;
  }

  private page(packet: Buffer, granule: number, flags = 0): Buffer {
    const page = oggPage(packet, granule, this.serial, this.sequence++, flags);
    this.collected?.push(page);
    return page;
  }

  completedStream(): Buffer | undefined {
    return this.ended && this.collected?.length
      ? Buffer.concat(this.collected)
      : undefined;
  }

  destroy(): void {
    if (this.encoder) this.codec.opus_encoder_destroy(this.encoder);
    this.codec.free(this.pcm);
    this.codec.free(this.output);
    this.encoder = this.pcm = this.output = 0;
    this.pending = undefined;
    this.collected = undefined;
  }
}
