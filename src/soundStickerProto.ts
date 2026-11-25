import { proto } from "@whiskeysockets/baileys";
import protobuf from "protobufjs";
import { Buffer } from "node:buffer";

export interface PendingAudioSticker {
  audioMessage: proto.Message.IAudioMessage;
  emoji?: string;
  expiresAt: number;
}

const pendingBySha256 = new Map<string, PendingAudioSticker>();
let isPatched = false;

function cleanupExpired() {
  const now = Date.now();
  for (const [key, val] of pendingBySha256.entries()) {
    if (val.expiresAt < now) {
      pendingBySha256.delete(key);
    }
  }
}

export function registerPendingAudioSticker(
  webpSha256Base64: string,
  audioMessage: proto.Message.IAudioMessage,
  emoji = "🎵",
  ttlMs = 120_000,
): void {
  cleanupExpired();
  pendingBySha256.set(webpSha256Base64, {
    audioMessage,
    emoji,
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearPendingAudioSticker(webpSha256Base64: string): void {
  pendingBySha256.delete(webpSha256Base64);
}

/**
 * Patches proto.Message.encode in Baileys 7.0.0-rc14 to emit WhatsApp's native
 * sound sticker wire format (Message.audioStickerMessage = field 134):
 *
 *   Message {
 *     134 (FutureProofMessage): {
 *       1 (Message): {
 *         26 (StickerMessage): {
 *           ...standard StickerMessage fields...,
 *           24 (varint): 0,
 *           25 (string, optional): emoji,
 *           26 (AudioMessage): audioMessage
 *         }
 *       }
 *     }
 *   }
 *
 * Because Baileys runs proto.Message.encode for both top-level messages and nested
 * deviceSentMessage payloads, keying by sticker fileSha256 guarantees the patch
 * applies consistently across all synced devices without touching normal messages.
 */
export function installAudioStickerProtoPatch(): void {
  if (isPatched) return;
  isPatched = true;

  const originalEncode = proto.Message.encode.bind(proto.Message);

  proto.Message.encode = function patchedMessageEncode(
    message: proto.IMessage,
    writer?: protobuf.Writer,
  ): protobuf.Writer {
    const w = writer ?? protobuf.Writer.create();

    const sticker = message?.stickerMessage;
    if (sticker?.fileSha256) {
      const shaB64 = Buffer.from(sticker.fileSha256).toString("base64");
      const pending = pendingBySha256.get(shaB64);

      if (pending && pending.expiresAt >= Date.now()) {
        // Encode every other field on Message (e.g. messageContextInfo), dropping top-level stickerMessage
        const rest: Record<string, unknown> = {};
        for (const key of Object.keys(message)) {
          if (key !== "stickerMessage") {
            rest[key] = (message as Record<string, unknown>)[key];
          }
        }
        originalEncode(rest as proto.IMessage, w);

        // Field 134 (audioStickerMessage, wireType 2): (134 << 3) | 2 = 1074
        w.uint32(1074).fork();
        // FutureProofMessage.message = field 1 (wireType 2): (1 << 3) | 2 = 10
        w.uint32(10).fork();
        // Inner Message.stickerMessage = field 26 (wireType 2): (26 << 3) | 2 = 210
        w.uint32(210).fork();

        // Standard StickerMessage fields
        proto.Message.StickerMessage.encode(sticker, w);

        // StickerMessage.premium = field 24 (varint, wireType 0): (24 << 3) | 0 = 192
        w.uint32(192).int32(0);

        // StickerMessage.emojis = field 25 (string, wireType 2): (25 << 3) | 2 = 202
        if (pending.emoji) {
          w.uint32(202).string(pending.emoji);
        }

        // StickerMessage.audioMessage = field 26 (wireType 2): (26 << 3) | 2 = 210
        proto.Message.AudioMessage.encode(
          pending.audioMessage,
          w.uint32(210).fork(),
        ).ldelim();

        // Close stickerMessage (26), inner Message (1), audioStickerMessage (134)
        w.ldelim().ldelim().ldelim();

        return w;
      }
    }

    return originalEncode(message, w);
  };
}

/**
 * Helper for unit testing & inspecting raw protobuf bytes for field 134.
 */
export function inspectAudioStickerWire(bytes: Uint8Array): {
  hasField134: boolean;
  sticker?: proto.Message.IStickerMessage;
  premium?: number;
  emojis?: string;
  audioMessage?: proto.Message.IAudioMessage;
} {
  const reader = protobuf.Reader.create(bytes);
  let field134Bytes: Uint8Array | null = null;

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 134 && wireType === 2) {
      field134Bytes = reader.bytes();
    } else {
      reader.skipType(wireType);
    }
  }

  if (!field134Bytes) {
    return { hasField134: false };
  }

  // Unwrap field 1 (FutureProofMessage.message)
  const r134 = protobuf.Reader.create(field134Bytes);
  let innerMsgBytes: Uint8Array | null = null;
  while (r134.pos < r134.len) {
    const tag = r134.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      innerMsgBytes = r134.bytes();
    } else {
      r134.skipType(wireType);
    }
  }
  if (!innerMsgBytes) return { hasField134: true };

  // Unwrap field 26 (stickerMessage)
  const rInner = protobuf.Reader.create(innerMsgBytes);
  let stickerBytes: Uint8Array | null = null;
  while (rInner.pos < rInner.len) {
    const tag = rInner.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 26 && wireType === 2) {
      stickerBytes = rInner.bytes();
    } else {
      rInner.skipType(wireType);
    }
  }
  if (!stickerBytes) return { hasField134: true };

  const sticker = proto.Message.StickerMessage.decode(stickerBytes);
  let premium: number | undefined;
  let emojis: string | undefined;
  let audioMessage: proto.Message.IAudioMessage | undefined;

  const rSticker = protobuf.Reader.create(stickerBytes);
  while (rSticker.pos < rSticker.len) {
    const tag = rSticker.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 24 && wireType === 0) {
      premium = rSticker.int32();
    } else if (fieldNo === 25 && wireType === 2) {
      emojis = rSticker.string();
    } else if (fieldNo === 26 && wireType === 2) {
      audioMessage = proto.Message.AudioMessage.decode(rSticker.bytes());
    } else {
      rSticker.skipType(wireType);
    }
  }

  return { hasField134: true, sticker, premium, emojis, audioMessage };
}
