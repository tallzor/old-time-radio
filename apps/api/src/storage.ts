import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export class LocalMediaStorage {
  public readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "media");
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  pathFor(objectKey: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(objectKey)) throw new Error("Unsafe media key");
    return join(this.root, objectKey);
  }

  async read(objectKey: string): Promise<Buffer> {
    return readFile(this.pathFor(objectKey));
  }

  async save(fileName: string, bytes: Buffer): Promise<string> {
    await this.ensure();
    const key = `${randomUUID()}-${basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await writeFile(this.pathFor(key), bytes, { flag: "wx" });
    return key;
  }

  async inspectWave(objectKey: string): Promise<{ mimeType: string; bytes: number; durationMs: number; checksum: string }> {
    const body = await this.read(objectKey);
    if (body.length < 44 || body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("只接受可校验的 WAV 音频文件");
    }
    const channels = body.readUInt16LE(22);
    const sampleRate = body.readUInt32LE(24);
    const bitsPerSample = body.readUInt16LE(34);
    let offset = 12;
    let dataBytes = 0;
    while (offset + 8 <= body.length) {
      const chunk = body.toString("ascii", offset, offset + 4);
      const size = body.readUInt32LE(offset + 4);
      if (chunk === "data") { dataBytes = size; break; }
      offset += 8 + size + (size % 2);
    }
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    if (!dataBytes || !byteRate || !Number.isFinite(byteRate)) throw new Error("WAV 缺少可用时长信息");
    return {
      mimeType: "audio/wav",
      bytes: (await stat(this.pathFor(objectKey))).size,
      durationMs: Math.floor((dataBytes / byteRate) * 1000),
      checksum: createHash("sha256").update(body).digest("hex")
    };
  }

  async ensureDevelopmentTone(): Promise<{ key: string; durationMs: number }> {
    await this.ensure();
    const key = "development-tone.wav";
    try {
      const info = await this.inspectWave(key);
      return { key, durationMs: info.durationMs };
    } catch {
      const wav = generateToneWav(12);
      await writeFile(this.pathFor(key), wav);
      return { key, durationMs: 12_000 };
    }
  }
}

export function generateToneWav(seconds: number): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bits = 16;
  const frames = sampleRate * seconds;
  const dataSize = frames * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buffer.writeUInt16LE(channels * (bits / 8), 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frames; index++) {
    const fade = Math.min(1, index / (sampleRate / 4), (frames - index) / (sampleRate / 4));
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.12 * fade * 32767);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}
