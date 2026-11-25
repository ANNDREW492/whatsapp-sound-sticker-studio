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
  convertMs: number;
  webpPasses: number;
}

const FFMPEG_THREADS = (Deno.env.get("FFMPEG_THREADS") || "").trim();

function threadArgs(): string[] {
  return FFMPEG_THREADS ? ["-threads", FFMPEG_THREADS] : [];
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

async function probeMediaInfo(
  filePath: string,
): Promise<{ duration: number; hasAudio: boolean }> {
  const res = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    filePath,
  ]);
  if (res.code !== 0) {
    return { duration: 0, hasAudio: false };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const dur = parseFloat(parsed?.format?.duration ?? "0");
    const streams: Array<{ codec_type?: string }> = parsed?.streams ?? [];
    const hasAudio = streams.some((s) => s.codec_type === "audio");
    return {
      duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
      hasAudio,
    };
  } catch {
    return { duration: 0, hasAudio: false };
  }
}

/**
 * Appends a valid WhatsApp Sticker EXIF chunk to a WebP RIFF container.
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

  const needsPad = exifPayload.length % 2 === 1;
  const exifChunk = Buffer.alloc(8 + exifPayload.length + (needsPad ? 1 : 0));
  exifChunk.write("EXIF", 0, "ascii");
  exifChunk.writeUInt32LE(exifPayload.length, 4);
  exifPayload.copy(exifChunk, 8);

  const firstChunkFourCC = webp.toString("ascii", 12, 16);

  if (firstChunkFourCC === "VP8X") {
    const out = Buffer.concat([webp, exifChunk]);
    out[20] = out[20] | 0x08;
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  }

  return webp;
}

function buildScaleFilter(fit: "contain" | "cover", fps?: number): string {
  const parts: string[] = [];
  if (fps) {
    parts.push(`fps=${fps}`);
  }
  if (fit === "cover") {
    parts.push(
      "scale=512:512:force_original_aspect_ratio=increase:flags=fast_bilinear",
    );
    parts.push("crop=512:512");
    parts.push("format=yuv420p");
  } else {
    parts.push(
      "scale=512:512:force_original_aspect_ratio=decrease:flags=fast_bilinear",
    );
    parts.push("format=yuva420p");
    parts.push("pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000");
  }
  return parts.join(",");
}

export async function convertToSoundSticker(
  opts: ConvertOptions,
): Promise<ConvertedStickerResult> {
  const t0 = performance.now();
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

    // Single fast ffprobe call for visual info (duration + whether it has audio)
    const visualInfo = animated
      ? await probeMediaInfo(visualPath)
      : { duration: 0, hasAudio: false };

    const effectiveVisualDur = visualInfo.duration > 0
      ? Math.max(0.5, Math.min(duration, visualInfo.duration - start))
      : duration;

    const webpPath = `${tempDir}/sticker.webp`;
    const oggPath = `${tempDir}/audio.ogg`;

    // Task 1: Encode WebP (using compression_level 1 + fast_bilinear so Pass #1 fits <490KB quickly!)
    const encodeWebpTask = async (): Promise<{ buffer: Buffer; passes: number }> => {
      let webpBuffer: Buffer | null = null;
      let passes = 0;

      if (animated) {
        // Choose an optimal first-pass preset based on clip length so 95% of videos finish in 1 pass!
        const presets = effectiveVisualDur <= 2.5
          ? [
            { fps: 12, q: 48, maxDur: Math.min(duration, 5) },
            { fps: 9, q: 28, maxDur: Math.min(duration, 4.5) },
            { fps: 6, q: 18, maxDur: Math.min(duration, 4) },
          ]
          : [
            { fps: 10, q: 38, maxDur: Math.min(duration, 5.5) },
            { fps: 8, q: 24, maxDur: Math.min(duration, 4.5) },
            { fps: 6, q: 16, maxDur: Math.min(duration, 4) },
          ];

        for (const preset of presets) {
          passes++;
          const args = [
            "-y",
            ...threadArgs(),
            ...(start > 0 ? ["-ss", String(start)] : []),
            "-t",
            String(preset.maxDur),
            "-i",
            visualPath,
            "-an",
            "-sn",
            "-dn",
            "-vf",
            buildScaleFilter(opts.fit, preset.fps),
            "-c:v",
            "libwebp",
            "-lossless",
            "0",
            "-compression_level",
            "1",
            "-q:v",
            String(preset.q),
            "-loop",
            "0",
            webpPath,
          ];
          const res = await runCmd("ffmpeg", args);
          if (res.code !== 0) {
            throw new Error(
              `FFmpeg error generando WebP animado: ${res.stderr.slice(-400)}`,
            );
          }
          const bytes = Buffer.from(await Deno.readFile(webpPath));
          webpBuffer = bytes;
          if (bytes.length <= 490_000) {
            break;
          }
        }
      } else {
        for (const q of [80, 55, 35]) {
          passes++;
          const args = [
            "-y",
            ...threadArgs(),
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
            "-compression_level",
            "1",
            "-q:v",
            String(q),
            webpPath,
          ];
          const res = await runCmd("ffmpeg", args);
          if (res.code !== 0) {
            throw new Error(
              `FFmpeg error generando WebP estático: ${res.stderr.slice(-400)}`,
            );
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

      return {
        buffer: addWhatsAppExif(webpBuffer, opts.packName, opts.author, opts.emoji),
        passes,
      };
    };

    // Task 2: Encode Opus/OGG audio in parallel with WebP
    const encodeAudioTask = async (): Promise<{
      buffer?: Buffer;
      durationSec?: number;
    }> => {
      if (!opts.includeAudio) return {};

      let audioSourcePath: string | undefined;
      let audioStart = 0;

      if (customAudioPath) {
        audioSourcePath = customAudioPath;
        audioStart = 0;
      } else if (visualInfo.hasAudio) {
        audioSourcePath = visualPath;
        audioStart = start;
      }

      if (!audioSourcePath) return {};

      let audioBuffer: Buffer | undefined;
      for (const bitrate of ["32k", "20k"]) {
        const args = [
          "-y",
          ...threadArgs(),
          ...(audioStart > 0 ? ["-ss", String(audioStart)] : []),
          "-t",
          String(duration),
          "-i",
          audioSourcePath,
          "-vn",
          "-sn",
          "-dn",
          "-map",
          "0:a:0",
          "-c:a",
          "libopus",
          "-compression_level",
          "5",
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
          throw new Error(
            `FFmpeg error convirtiendo audio a Opus/OGG: ${res.stderr.slice(-400)}`,
          );
        }
        const bytes = Buffer.from(await Deno.readFile(oggPath));
        audioBuffer = bytes;
        if (bytes.length <= 900_000) {
          break;
        }
      }

      if (!audioBuffer) return {};

      const audioDur = customAudioPath
        ? (await probeMediaInfo(oggPath)).duration
        : effectiveVisualDur;

      return {
        buffer: audioBuffer,
        durationSec: Math.max(1, Math.round(audioDur || duration)),
      };
    };

    const [webpResult, audioResult] = await Promise.all([
      encodeWebpTask(),
      encodeAudioTask(),
    ]);

    const webpSha256Base64 = createHash("sha256")
      .update(webpResult.buffer)
      .digest("base64");

    return {
      webpBuffer: webpResult.buffer,
      webpSha256Base64,
      isAnimated: animated,
      audioBuffer: audioResult.buffer,
      audioDurationSec: audioResult.durationSec,
      audioSizeBytes: audioResult.buffer?.length,
      webpSizeBytes: webpResult.buffer.length,
      convertMs: Math.round(performance.now() - t0),
      webpPasses: webpResult.passes,
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}
