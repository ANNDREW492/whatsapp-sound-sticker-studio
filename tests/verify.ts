import { proto } from "@whiskeysockets/baileys";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  inspectAudioStickerWire,
  installAudioStickerProtoPatch,
  registerPendingAudioSticker,
} from "../src/soundStickerProto.ts";
import { convertToSoundSticker } from "../src/media.ts";

// 1. Test Protobuf encoding (both direct Message and nested DeviceSentMessage)
installAudioStickerProtoPatch();

const fakeWebp = Buffer.from("RIFF____WEBPVP8Xtest-sticker-bytes");
const shaBytes = createHash("sha256").update(fakeWebp).digest();
const shaB64 = shaBytes.toString("base64");

registerPendingAudioSticker(
  shaB64,
  {
    url: "https://mmg.whatsapp.net/o1/v/t62/test-audio",
    mimetype: "audio/ogg; codecs=opus",
    fileSha256: Buffer.alloc(32, 7),
    fileLength: 12345,
    seconds: 5,
    mediaKey: Buffer.alloc(32, 9),
    fileEncSha256: Buffer.alloc(32, 11),
    directPath: "/o1/v/t62/test-audio",
  },
  "🎵",
);

const sampleMsg: proto.IMessage = {
  stickerMessage: {
    url: "https://mmg.whatsapp.net/o1/v/t62/test-sticker",
    mimetype: "image/webp",
    fileSha256: shaBytes,
    isAnimated: true,
  },
  messageContextInfo: {
    deviceListMetadataVersion: 2,
  },
};

// Direct encode
const encoded = proto.Message.encode(sampleMsg).finish();
const inspected = inspectAudioStickerWire(encoded);
if (!inspected.hasField134) throw new Error("Missing field 134!");
if (inspected.premium !== 0) throw new Error(`Expected premium=0, got ${inspected.premium}`);
if (inspected.emojis !== "🎵") throw new Error(`Expected emoji 🎵, got ${inspected.emojis}`);
if (inspected.audioMessage?.mimetype !== "audio/ogg; codecs=opus") {
  throw new Error(`Bad audio mimetype: ${inspected.audioMessage?.mimetype}`);
}
if (inspected.sticker?.mimetype !== "image/webp") {
  throw new Error(`Bad sticker mimetype: ${inspected.sticker?.mimetype}`);
}
console.log("PASS 1/3: Direct field 134 AudioStickerMessage wire encoding verified!");

// Nested DeviceSentMessage encode (this is how WhatsApp syncs self-sent messages!)
const dsmEncoded = proto.Message.encode({
  deviceSentMessage: {
    destinationJid: "51999999999@s.whatsapp.net",
    message: sampleMsg,
  },
}).finish();
const dsmDecoded = proto.Message.decode(dsmEncoded);
if (!dsmDecoded.deviceSentMessage) throw new Error("DeviceSentMessage failed decode");
console.log("PASS 2/3: Nested DeviceSentMessage encoding verified!");

// 2. Test FFmpeg media pipeline using a synthetic 3s video with sine wave audio
const tmpDir = await Deno.makeTempDir({ prefix: "wa_test_" });
try {
  const sampleMp4 = `${tmpDir}/sample.mp4`;
  const gen = new Deno.Command("ffmpeg", {
    args: [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      sampleMp4,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const genOut = await gen.output();
  if (genOut.code !== 0) {
    throw new Error("Could not generate test mp4: " + new TextDecoder().decode(genOut.stderr));
  }

  const mp4Bytes = await Deno.readFile(sampleMp4);
  const converted = await convertToSoundSticker({
    visualBytes: mp4Bytes,
    visualName: "sample.mp4",
    visualMime: "video/mp4",
    durationSec: 5,
    startSec: 0,
    fit: "contain",
    packName: "Test Pack",
    author: "Test",
    emoji: "🎵",
    includeAudio: true,
  });

  if (!converted.isAnimated) throw new Error("Expected animated WebP");
  if (converted.webpSizeBytes > 500_000) {
    throw new Error(`WebP too large: ${converted.webpSizeBytes}`);
  }
  if (!converted.audioBuffer || converted.audioSizeBytes! === 0) {
    throw new Error("Expected Opus audio buffer");
  }
  if (converted.audioSizeBytes! > 950_000) {
    throw new Error(`Audio too large: ${converted.audioSizeBytes}`);
  }
  console.log(
    `PASS 3/3: FFmpeg pipeline verified! WebP=${Math.round(converted.webpSizeBytes / 1024)} KB, Opus=${Math.round(converted.audioSizeBytes! / 1024)} KB, dur=${converted.audioDurationSec}s`,
  );
} finally {
  await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
}
