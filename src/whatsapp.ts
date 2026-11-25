import makeWASocket, {
  type AuthenticationCreds,
  type AuthenticationState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  jidNormalizedUser,
  prepareWAMessageMedia,
  type SignalDataTypeMap,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { Buffer } from "node:buffer";
import {
  clearPendingAudioSticker,
  installAudioStickerProtoPatch,
  registerPendingAudioSticker,
} from "./soundStickerProto.ts";
import type { ConvertedStickerResult } from "./media.ts";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "qr"
  | "connected"
  | "error";

export interface WhatsAppStatus {
  state: ConnectionState;
  mode: "ephemeral" | "local";
  qrDataUrl: string | null;
  pairingCode: string | null;
  selfJid: string | null;
  selfName: string | null;
  lastError: string | null;
  logs: string[];
  expiresInSec: number | null;
  activeSessions: number;
  maxSessions: number;
  hasSavedSession: boolean;
}

const AUTH_DIR = "./auth_info";
const PERSIST_LOCAL = Deno.env.get("PERSIST_LOCAL_SESSION") === "true";
const MAX_SESSIONS = Math.max(1, Number(Deno.env.get("MAX_SESSIONS") || "12"));
const SESSION_TTL_MS = Math.max(
  2,
  Number(Deno.env.get("SESSION_TTL_MIN") || "10"),
) * 60_000;

/**
 * Pure in-memory Baileys auth state. Zero credentials are ever written to disk.
 */
function createInMemoryAuthState(): {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  wipe: () => void;
} {
  const creds: AuthenticationCreds = initAuthCreds();
  const store = new Map<string, unknown>();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const val = store.get(`${type}:${id}`);
          if (val !== undefined) {
            result[id] = val as SignalDataTypeMap[T];
          }
        }
        return result;
      },
      set: (data) => {
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const [id, value] of Object.entries(entries)) {
            const key = `${category}:${id}`;
            if (value === null || value === undefined) {
              store.delete(key);
            } else {
              store.set(key, value);
            }
          }
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      // Mutated in memory; nothing touches disk
    },
    wipe: () => {
      store.clear();
    },
  };
}

export class PersonalWhatsAppSession {
  readonly id: string;
  readonly persistent: boolean;

  private sock: WASocket | null = null;
  private state: ConnectionState = "disconnected";
  private qrDataUrl: string | null = null;
  private pairingCode: string | null = null;
  private selfJid: string | null = null;
  private selfName: string | null = null;
  private lastError: string | null = null;
  private logs: string[] = [];
  private manualDisconnect = false;
  private reconnectTimer: number | null = null;
  private memoryAuth: ReturnType<typeof createInMemoryAuthState> | null = null;
  private lastActivityAt = Date.now();
  private connectAttempts = 0;
  private pendingPairingPhone: string | null = null;
  private pairingWaiters: Array<{
    resolve: (code: string) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(id: string, persistent: boolean) {
    this.id = id;
    this.persistent = persistent;
    installAudioStickerProtoPatch();
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivityAt;
  }

  isActive(): boolean {
    return (
      this.state === "connecting" ||
      this.state === "qr" ||
      this.state === "connected"
    );
  }

  private log(msg: string) {
    const time = new Date().toLocaleTimeString("es-PE", { hour12: false });
    const entry = `[${time}] ${msg}`;
    this.logs.unshift(entry);
    if (this.logs.length > 25) this.logs.pop();
    console.log(`[session:${this.id.slice(0, 6)}] ${entry}`);
  }

  async hasSavedLocalSession(): Promise<boolean> {
    if (!this.persistent) return false;
    try {
      await Deno.stat(`${AUTH_DIR}/creds.json`);
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(activeSessions: number): Promise<WhatsAppStatus> {
    const remainingMs = this.persistent || !this.isActive()
      ? null
      : Math.max(0, SESSION_TTL_MS - (Date.now() - this.lastActivityAt));

    return {
      state: this.state,
      mode: this.persistent ? "local" : "ephemeral",
      qrDataUrl: this.qrDataUrl,
      pairingCode: this.pairingCode,
      selfJid: this.selfJid,
      selfName: this.selfName,
      lastError: this.lastError,
      logs: this.logs,
      expiresInSec: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
      activeSessions,
      maxSessions: MAX_SESSIONS,
      hasSavedSession: await this.hasSavedLocalSession(),
    };
  }

  private resolvePairingWaiters(code: string) {
    const waiters = this.pairingWaiters.splice(0);
    for (const w of waiters) w.resolve(code);
  }

  private rejectPairingWaiters(err: Error) {
    const waiters = this.pairingWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  async connectWithPairingCode(phone: string): Promise<string> {
    this.touch();
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length < 8 || cleaned.length > 15) {
      throw new Error(
        "Número inválido. Escribe código de país + número sin +, ej: 51999888777",
      );
    }

    if (this.state === "connected") {
      throw new Error("Ya tienes una sesión de WhatsApp conectada.");
    }

    // If a socket is already open in QR stage (unregistered), request the pairing code immediately!
    if (this.sock && this.state === "qr" && !this.pairingCode) {
      this.log(`Solicitando código de vinculación para +${cleaned}...`);
      try {
        const code = await this.sock.requestPairingCode(cleaned);
        this.pairingCode = code;
        this.qrDataUrl = null;
        this.lastError = null;
        this.log(`Código de vinculación listo: ${code}`);
        return code;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.lastError = `No se pudo generar el código: ${e.message}`;
        this.log(this.lastError);
        throw e;
      }
    }

    // Otherwise start a clean fresh connection and wait for handshake ready (first QR tick)
    await this.disconnect();
    if (!this.persistent) {
      await this.wipeCredentials();
    }
    this.connectAttempts = 0;
    this.pendingPairingPhone = cleaned;

    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPairingPhone = null;
        reject(
          new Error(
            "Tiempo agotado esperando respuesta de WhatsApp. Intenta de nuevo.",
          ),
        );
      }, 20_000);

      this.pairingWaiters.push({
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    void this.connect();
    return await codePromise;
  }

  async connect(): Promise<void> {
    this.touch();
    if (this.sock && this.isActive()) {
      return;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.manualDisconnect = false;
    this.state = "connecting";
    this.lastError = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.connectAttempts += 1;

    this.log(
      this.persistent
        ? "Iniciando conexión local (solo chat personal)..."
        : "Iniciando sesión temporal en memoria (solo tu chat personal)...",
    );

    try {
      let authState: AuthenticationState;
      let saveCreds: () => Promise<void>;

      if (this.persistent) {
        const res = await useMultiFileAuthState(AUTH_DIR);
        authState = res.state;
        saveCreds = res.saveCreds;
      } else {
        // Reuse in-memory auth on mid-handshake reconnects (e.g. code 515 restart after QR/pairing)
        if (!this.memoryAuth) {
          this.memoryAuth = createInMemoryAuthState();
        }
        authState = this.memoryAuth.state;
        saveCreds = this.memoryAuth.saveCreds;
      }

      const { version } = await fetchLatestBaileysVersion();
      this.log(`Protocolo WA Web v${version.join(".")}`);

      const sock = makeWASocket({
        version,
        auth: authState,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.sock = sock;
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.state = "qr";

          if (this.pendingPairingPhone && !authState.creds.registered) {
            const phoneToPair = this.pendingPairingPhone;
            this.pendingPairingPhone = null;
            this.log(`Solicitando código de vinculación para +${phoneToPair}...`);
            try {
              const code = await sock.requestPairingCode(phoneToPair);
              this.pairingCode = code;
              this.qrDataUrl = null;
              this.lastError = null;
              this.log(`Código de vinculación listo: ${code}`);
              this.resolvePairingWaiters(code);
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              this.lastError = `No se pudo generar el código: ${e.message}`;
              this.log(this.lastError);
              this.rejectPairingWaiters(e);
            }
          } else if (!this.pairingCode) {
            this.qrDataUrl = await QRCode.toDataURL(qr, {
              width: 280,
              margin: 2,
              color: { dark: "#111b21", light: "#ffffff" },
            });
            this.log("QR listo. Escanéalo en WhatsApp → Dispositivos vinculados.");
          }
        }

        if (connection === "open") {
          this.touch();
          this.connectAttempts = 0;
          this.state = "connected";
          this.qrDataUrl = null;
          this.pairingCode = null;
          this.lastError = null;
          this.selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
          this.selfName = sock.user?.name || this.selfJid || "Tu cuenta";
          this.log(
            `Conectado como ${this.selfName}. Solo se enviarán stickers a tu propio chat.`,
          );
        }

        if (connection === "close") {
          const statusCode = (
            lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          this.sock = null;
          this.qrDataUrl = null;

          if (this.manualDisconnect) {
            this.state = "disconnected";
            return;
          }

          if (loggedOut) {
            this.state = "disconnected";
            this.selfJid = null;
            this.selfName = null;
            this.lastError = "Sesión cerrada desde el teléfono. Vuelve a vincular.";
            this.log(this.lastError);
            this.rejectPairingWaiters(new Error(this.lastError));
            await this.wipeCredentials();
          } else if (this.connectAttempts <= 4) {
            // Normal WA handshake restart (515) or transient disconnect
            this.state = "connecting";
            this.log(`Reconectando (código ${statusCode ?? "?"})...`);
            this.reconnectTimer = setTimeout(() => {
              this.connect();
            }, 2000) as unknown as number;
          } else {
            this.state = "error";
            this.lastError = "No se pudo mantener la conexión. Intenta vincular de nuevo.";
            this.log(this.lastError);
            this.rejectPairingWaiters(new Error(this.lastError));
            if (!this.persistent) {
              await this.wipeCredentials();
            }
          }
        }
      });

      // STRICT PRIVACY: No messages.upsert listener, never reads or replies to any chat.
    } catch (err) {
      this.state = "error";
      this.lastError = (err as Error).message;
      this.log(`Error al conectar: ${this.lastError}`);
      this.sock = null;
    }
  }

  private async wipeCredentials(): Promise<void> {
    if (this.memoryAuth) {
      this.memoryAuth.wipe();
      this.memoryAuth = null;
    }
    if (this.persistent) {
      await Deno.remove(AUTH_DIR, { recursive: true }).catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // ignore
      }
      this.sock = null;
    }
    this.state = "disconnected";
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.log("Conexión detenida.");
  }

  /**
   * Unlinks the device from the user's phone and erases all credentials from memory/disk.
   */
  async logoutAndWipe(reason = "Sesión desvinculada y borrada."): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      if (this.state === "connected") {
        try {
          await sock.logout();
        } catch {
          try {
            sock.end(undefined);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          sock.end(undefined);
        } catch {
          // ignore
        }
      }
    }
    await this.wipeCredentials();
    this.state = "disconnected";
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.selfJid = null;
    this.selfName = null;
    this.connectAttempts = 0;
    this.log(reason);
  }

  /**
   * Sends a sound sticker (or standard sticker if no audio) EXCLUSIVELY to the
   * connected user's own "Message Yourself" chat (selfJid).
   */
  async sendStickerToSelf(
    converted: ConvertedStickerResult,
    emoji = "🎵",
  ): Promise<{ messageId: string; withAudio: boolean; targetJid: string }> {
    this.touch();
    if (!this.sock || this.state !== "connected" || !this.selfJid) {
      throw new Error("WhatsApp no está conectado. Vincula tu cuenta primero.");
    }

    const sock = this.sock;
    const targetJid = this.selfJid;

    if (converted.audioBuffer && converted.audioBuffer.length > 0) {
      this.log(
        `Subiendo audio Opus (${Math.round(converted.audioBuffer.length / 1024)} KB, ${converted.audioDurationSec ?? "?"}s)...`,
      );

      const media = await prepareWAMessageMedia(
        {
          audio: Buffer.from(converted.audioBuffer),
          mimetype: "audio/ogg; codecs=opus",
          ptt: false,
        },
        { upload: sock.waUploadToServer },
      );

      if (!media.audioMessage) {
        throw new Error("No se pudo subir el audio a los servidores de WhatsApp.");
      }

      if (converted.audioDurationSec) {
        media.audioMessage.seconds = converted.audioDurationSec;
      }

      registerPendingAudioSticker(
        converted.webpSha256Base64,
        media.audioMessage,
        emoji,
      );

      try {
        this.log(
          `Enviando sticker con audio (${Math.round(converted.webpSizeBytes / 1024)} KB) a tu chat personal...`,
        );
        const sent = await sock.sendMessage(targetJid, {
          sticker: converted.webpBuffer,
          isAnimated: converted.isAnimated,
        });
        const messageId = sent?.key?.id || "ok";
        this.log(`¡Sticker con audio enviado! ID: ${messageId}`);
        return { messageId, withAudio: true, targetJid };
      } finally {
        setTimeout(() => {
          clearPendingAudioSticker(converted.webpSha256Base64);
        }, 15_000);
      }
    } else {
      this.log(
        `Enviando sticker sin audio (${Math.round(converted.webpSizeBytes / 1024)} KB) a tu chat personal...`,
      );
      const sent = await sock.sendMessage(targetJid, {
        sticker: converted.webpBuffer,
        isAnimated: converted.isAnimated,
      });
      const messageId = sent?.key?.id || "ok";
      this.log(`¡Sticker enviado! ID: ${messageId}`);
      return { messageId, withAudio: false, targetJid };
    }
  }
}

class SessionManager {
  private sessions = new Map<string, PersonalWhatsAppSession>();
  private localSession: PersonalWhatsAppSession | null = null;
  private reaperInterval: number;

  constructor() {
    if (PERSIST_LOCAL) {
      this.localSession = new PersonalWhatsAppSession("local", true);
    }

    // Reap idle ephemeral sessions every 30s
    this.reaperInterval = setInterval(() => {
      void this.reapIdleSessions();
    }, 30_000) as unknown as number;
  }

  isPersistentLocalMode(): boolean {
    return PERSIST_LOCAL;
  }

  getActiveSessionCount(): number {
    if (PERSIST_LOCAL) {
      return this.localSession?.isActive() ? 1 : 0;
    }
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.isActive()) count++;
    }
    return count;
  }

  getOrCreateSession(sessionId: string): PersonalWhatsAppSession {
    if (PERSIST_LOCAL && this.localSession) {
      return this.localSession;
    }

    let existing = this.sessions.get(sessionId);
    if (existing) {
      existing.touch();
      return existing;
    }

    // Enforce max concurrent active sessions before allocating a new one
    if (this.sessions.size >= MAX_SESSIONS * 2) {
      for (const [id, s] of this.sessions.entries()) {
        if (!s.isActive()) {
          this.sessions.delete(id);
        }
      }
    }

    existing = new PersonalWhatsAppSession(sessionId, false);
    this.sessions.set(sessionId, existing);
    return existing;
  }

  canStartNewConnection(sessionId: string): boolean {
    if (PERSIST_LOCAL) return true;
    const existing = this.sessions.get(sessionId);
    if (existing?.isActive()) return true;
    return this.getActiveSessionCount() < MAX_SESSIONS;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (PERSIST_LOCAL && this.localSession) {
      await this.localSession.logoutAndWipe();
      return;
    }
    const s = this.sessions.get(sessionId);
    if (s) {
      await s.logoutAndWipe("Sesión cerrada y borrada de memoria.");
      this.sessions.delete(sessionId);
    }
  }

  private async reapIdleSessions(): Promise<void> {
    if (PERSIST_LOCAL) return;
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      const idleMs = now - session.getLastActivity();
      if (idleMs > SESSION_TTL_MS) {
        if (session.isActive()) {
          await session.logoutAndWipe(
            "Sesión expirada automáticamente por inactividad.",
          );
        }
        this.sessions.delete(id);
      }
    }
  }

  async autoConnectLocalIfSaved(): Promise<void> {
    if (PERSIST_LOCAL && this.localSession) {
      if (await this.localSession.hasSavedLocalSession()) {
        await this.localSession.connect();
      }
    }
  }

  async shutdownAll(): Promise<void> {
    clearInterval(this.reaperInterval);
    if (this.localSession) {
      await this.localSession.disconnect();
    }
    for (const session of this.sessions.values()) {
      await session.logoutAndWipe("Servidor detenido; sesión temporal cerrada.");
    }
    this.sessions.clear();
  }
}

export const sessionManager = new SessionManager();
export { MAX_SESSIONS, SESSION_TTL_MS };
