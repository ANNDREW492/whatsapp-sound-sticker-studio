import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export interface ConvertOptions {
  visualBytes: Uint8Array;
  visualName: string;
  visualMime: string;
  audioBytes?: Uint8Array;
  audioName?: string;
  durationSec: number; // 5 or 10 (capped 1..15)
  startSec: number;
  fit: "contain" | "cover";
  packName: string;
  author: string;
  emoji: string;
  includeAudio: boolean;
}

export interface ConvertedStickerResult {
  webpBuffer: Buffer;
  webpSha256Base64: string;
  isAnimated: boolean;
  audioBuffer?: Buffer;
  audioDurationSec?: number;
  audioSizeBytes?: number;
  webpSizeBytes: number;
}

async function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await command.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

function getExt(name: string, fallback: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? `.${m[1]}` : fallback;
}

function isVideoOrGif(mime: string, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    mime.startsWith("video/") ||
    mime === "image/gif" ||
    /\.(mp4|mov|webm|mkv|avi|m4v|gif)$/.test(lower)
  );
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  const res = await runCmd("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return res.code === 0 && res.stdout.trim().includes("audio");
}

async function probeDuration(filePath: string): Promise<number> {
  const res = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const val = parseFloat(res.stdout.trim());
  return Number.isFinite(val) && val > 0 ? val : 0;
}

/**
 * Appends a valid WhatsApp Sticker EXIF chunk to a WebP RIFF container.
 * Handles both simple VP8/VP8L/VP8X WebP files safely.
 */
function addWhatsAppExif(
  webp: Buffer,
  packName: string,
  author: string,
  emoji: string,
): Buffer {
  if (
    webp.length < 16 ||
    webp.toString("ascii", 0, 4) !== "RIFF" ||
    webp.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return webp;
  }

  const json = JSON.stringify({
    "sticker-pack-id": `local.soundstudio.${Date.now()}`,
    "sticker-pack-name": packName || "Sound Stickers",
    "sticker-pack-publisher": author || "Yo",
    emojis: [emoji || "🎵"],
  });

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuf = Buffer.from(json, "utf8");
  exifAttr.writeUInt32LE(jsonBuf.length, 14);
  const exifPayload = Buffer.concat([exifAttr, jsonBuf]);

  // Build EXIF chunk (4-byte tag + 4-byte LE length + payload + optional pad byte)
  const needsPad = exifPayload.length % 2 === 1;
  const exifChunk = Buffer.alloc(8 + exifPayload.length + (needsPad ? 1 : 0));
  exifChunk.write("EXIF", 0, "ascii");
  exifChunk.writeUInt32LE(exifPayload.length, 4);
  exifPayload.copy(exifChunk, 8);

  const firstChunkFourCC = webp.toString("ascii", 12, 16);

  if (firstChunkFourCC === "VP8X") {
    // Set the EXIF flag bit (bit 3 = 0x08) in VP8X flags byte at offset 20
    const out = Buffer.concat([webp, exifChunk]);
    out[20] = out[20] | 0x08;
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  }

  // For simple static VP8/VP8L without VP8X, keep original WebP untouched so we don't break header dimensions
  return webp;
}

function buildScaleFilter(fit: "contain" | "cover", fps?: number): string {
  const parts: string[] = [];
  if (fps) {
    parts.push(`fps=${fps}`);
  }
  if (fit === "cover") {
    parts.push(
      "scale=512:512:force_original_aspect_ratio=increase:flags=lanczos",
    );
    parts.push("crop=512:512");
  } else {
    parts.push(
      "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos",
    );
    parts.push("pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000");
  }
  parts.push("format=rgba");
  return parts.join(",");
}

export async function convertToSoundSticker(
  opts: ConvertOptions,
): Promise<ConvertedStickerResult> {
  const tempDir = await Deno.makeTempDir({ prefix: "wa_sound_sticker_" });
  try {
    const visualExt = getExt(
      opts.visualName,
      opts.visualMime.startsWith("video/") ? ".mp4" : ".png",
    );
    const visualPath = `${tempDir}/input_visual${visualExt}`;
    await Deno.writeFile(visualPath, opts.visualBytes);

    let customAudioPath: string | undefined;
    if (opts.audioBytes && opts.audioBytes.length > 0) {
      const audioExt = getExt(opts.audioName || "audio.mp3", ".mp3");
      customAudioPath = `${tempDir}/input_audio${audioExt}`;
      await Deno.writeFile(customAudioPath, opts.audioBytes);
    }

    const duration = Math.max(1, Math.min(15, opts.durationSec || 10));
    const start = Math.max(0, opts.startSec || 0);
    const animated = isVideoOrGif(opts.visualMime, opts.visualName);

    const webpPath = `${tempDir}/sticker.webp`;
    let webpBuffer: Buffer | null = null;

    if (animated) {
      // Animated WebP must stay under 500 KB for WhatsApp.
      // Try progressive quality/fps presets until it fits cleanly.
      const presets = [
        { fps: 15, q: 70, maxDur: Math.min(duration, 6) },
        { fps: 12, q: 55, maxDur: Math.min(duration, 6) },
        { fps: 10, q: 42, maxDur: Math.min(duration, 5) },
        { fps: 8, q: 30, maxDur: Math.min(duration, 5) },
        { fps: 6, q: 20, maxDur: Math.min(duration, 4) },
      ];

      for (const preset of presets) {
        const args = [
          "-y",
          "-ss",
          String(start),
          "-t",
          String(preset.maxDur),
          "-i",
          visualPath,
          "-an",
          "-vf",
          buildScaleFilter(opts.fit, preset.fps),
          "-c:v",
          "libwebp",
          "-lossless",
          "0",
          "-compression_level",
          "4",
          "-q:v",
          String(preset.q),
          "-loop",
          "0",
          "-preset",
          "default",
          webpPath,
        ];
        const res = await runCmd("ffmpeg", args);
        if (res.code !== 0) {
          throw new Error(`FFmpeg error generando WebP animado: ${res.stderr.slice(-400)}`);
        }
        const bytes = Buffer.from(await Deno.readFile(webpPath));
        webpBuffer = bytes;
        if (bytes.length <= 490_000) {
          break;
        }
      }
    } else {
      // Static WebP must stay under 100 KB for WhatsApp.
      for (const q of [85, 70, 50, 35]) {
        const args = [
          "-y",
          "-i",
          visualPath,
          "-vf",
          buildScaleFilter(opts.fit),
          "-frames:v",
          "1",
          "-c:v",
          "libwebp",
          "-lossless",
          "0",
          "-q:v",
          String(q),
          webpPath,
        ];
        const res = await runCmd("ffmpeg", args);
        if (res.code !== 0) {
          throw new Error(`FFmpeg error generando WebP estático: ${res.stderr.slice(-400)}`);
        }
        const bytes = Buffer.from(await Deno.readFile(webpPath));
        webpBuffer = bytes;
        if (bytes.length <= 98_000) {
          break;
        }
      }
    }

    if (!webpBuffer) {
      throw new Error("No se pudo generar el archivo WebP.");
    }

    webpBuffer = addWhatsAppExif(webpBuffer, opts.packName, opts.author, opts.emoji);

    // Process audio -> OGG/Opus (no video/cover-art stream! WhatsApp rejects OGG with Theora cover art)
    let audioBuffer: Buffer | undefined;
    let audioDurationSec: number | undefined;

    if (opts.includeAudio) {
      let audioSourcePath: string | undefined;
      let audioStart = 0;

      if (customAudioPath) {
        audioSourcePath = customAudioPath;
        audioStart = 0;
      } else if (await probeHasAudio(visualPath)) {
        audioSourcePath = visualPath;
        audioStart = start;
      }

      if (audioSourcePath) {
        const oggPath = `${tempDir}/audio.ogg`;
        for (const bitrate of ["48k", "32k", "24k", "16k"]) {
          const args = [
            "-y",
            ...(audioStart > 0 ? ["-ss", String(audioStart)] : []),
            "-t",
            String(duration),
            "-i",
            audioSourcePath,
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "libopus",
            "-b:a",
            bitrate,
            "-ar",
            "48000",
            "-ac",
            "1",
            "-application",
            "audio",
            "-avoid_negative_ts",
            "make_zero",
            oggPath,
          ];
          const res = await runCmd("ffmpeg", args);
          if (res.code !== 0) {
            throw new Error(`FFmpeg error convirtiendo audio a Opus/OGG: ${res.stderr.slice(-400)}`);
          }
          const bytes = Buffer.from(await Deno.readFile(oggPath));
          audioBuffer = bytes;
          if (bytes.length <= 900_000) {
            break;
          }
        }
        if (audioBuffer) {
          const d = await probeDuration(oggPath);
          audioDurationSec = Math.max(1, Math.round(d || duration));
        }
      }
    }

    const webpSha256Base64 = createHash("sha256")
      .update(webpBuffer)
      .digest("base64");

    return {
      webpBuffer,
      webpSha256Base64,
      isAnimated: animated,
      audioBuffer,
      audioDurationSec,
      audioSizeBytes: audioBuffer?.length,
      webpSizeBytes: webpBuffer.length,
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}
