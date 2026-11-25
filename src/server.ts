import { convertToSoundSticker } from "./media.ts";
import {
  MAX_SESSIONS,
  sessionManager,
  type PersonalWhatsAppSession,
} from "./whatsapp.ts";

const PORT = Number(Deno.env.get("PORT") || "3000");
const HOST = Deno.env.get("HOST") || "127.0.0.1";
const ACCESS_CODE = (Deno.env.get("ACCESS_CODE") || "").trim();
const MAX_CONCURRENT_FFMPEG = Math.max(
  1,
  Number(Deno.env.get("MAX_CONCURRENT_FFMPEG") || "2"),
);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
};

// Simple concurrency semaphore so multiple simultaneous FFmpeg jobs queue cleanly
let activeFfmpegJobs = 0;
const ffmpegWaiters: (() => void)[] = [];

async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFfmpegJobs >= MAX_CONCURRENT_FFMPEG) {
    await new Promise<void>((resolve) => ffmpegWaiters.push(resolve));
  }
  activeFfmpegJobs++;
  try {
    return await fn();
  } finally {
    activeFfmpegJobs--;
    const next = ffmpegWaiters.shift();
    if (next) next();
  }
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  return out;
}

function getOrIssueSessionId(req: Request): {
  sessionId: string;
  setCookieHeader?: string;
} {
  const cookies = parseCookies(req);
  const existing = cookies["wa_sid"];
  if (existing && /^[a-f0-9-]{16,64}$/i.test(existing)) {
    return { sessionId: existing };
  }
  const sessionId = crypto.randomUUID();
  const isHttps =
    req.url.startsWith("https://") ||
    req.headers.get("x-forwarded-proto") === "https";
  const secureFlag = isHttps ? "; Secure" : "";
  return {
    sessionId,
    setCookieHeader: `wa_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`,
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function isAuthorized(req: Request): boolean {
  if (!ACCESS_CODE) return true;
  const provided = (req.headers.get("x-access-code") || "").trim();
  return provided === ACCESS_CODE;
}

async function serveStatic(
  pathname: string,
  setCookieHeader?: string,
): Promise<Response> {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  if (safePath.includes("..") || safePath.includes("\\")) {
    return new Response("Forbidden", { status: 403 });
  }
  const filePath = `./public${safePath}`;
  try {
    const file = await Deno.readFile(filePath);
    const ext = safePath.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? "";
    const headers: Record<string, string> = {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    };
    if (setCookieHeader) {
      headers["set-cookie"] = setCookieHeader;
    }
    return new Response(file, { status: 200, headers });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function parseStickerForm(req: Request) {
  const form = await req.formData();
  const visual = form.get("visual");
  if (!(visual instanceof File) || visual.size === 0) {
    throw new Error("Debes elegir una foto, GIF o video corto.");
  }
  if (visual.size > 60 * 1024 * 1024) {
    throw new Error("El archivo visual supera el límite de 60 MB.");
  }

  const audio = form.get("audio");
  let audioBytes: Uint8Array | undefined;
  let audioName: string | undefined;
  if (audio instanceof File && audio.size > 0) {
    if (audio.size > 25 * 1024 * 1024) {
      throw new Error("El archivo de audio supera el límite de 25 MB.");
    }
    audioBytes = new Uint8Array(await audio.arrayBuffer());
    audioName = audio.name;
  }

  const durationSec = Number(form.get("duration") ?? "10");
  const startSec = Number(form.get("startSec") ?? "0");
  const fit = form.get("fit") === "cover" ? "cover" : "contain";
  const packName = String(form.get("packName") ?? "Mis Sound Stickers").slice(0, 40);
  const author = String(form.get("author") ?? "Sticker Studio").slice(0, 40);
  const emoji = String(form.get("emoji") ?? "🎵").slice(0, 4) || "🎵";
  const includeAudio = form.get("includeAudio") !== "false";

  const visualBytes = new Uint8Array(await visual.arrayBuffer());

  const converted = await withFfmpegSlot(() =>
    convertToSoundSticker({
      visualBytes,
      visualName: visual.name,
      visualMime: visual.type || "application/octet-stream",
      audioBytes,
      audioName,
      durationSec: Number.isFinite(durationSec) ? durationSec : 10,
      startSec: Number.isFinite(startSec) ? startSec : 0,
      fit,
      packName,
      author,
      emoji,
      includeAudio,
    })
  );

  return { converted, emoji };
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/api/health" && req.method === "GET") {
    return jsonResponse({
      ok: true,
      mode: sessionManager.isPersistentLocalMode() ? "local" : "ephemeral",
      activeSessions: sessionManager.getActiveSessionCount(),
      maxSessions: MAX_SESSIONS,
      requiresAccessCode: Boolean(ACCESS_CODE),
    });
  }

  const { sessionId, setCookieHeader } = getOrIssueSessionId(req);
  const cookieHeaderObj = setCookieHeader
    ? { "set-cookie": setCookieHeader }
    : undefined;

  try {
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/auth-check" && req.method === "POST") {
        if (!ACCESS_CODE) {
          return jsonResponse({ ok: true, requiresAccessCode: false }, 200, cookieHeaderObj);
        }
        const ok = isAuthorized(req);
        return jsonResponse(
          { ok, requiresAccessCode: true },
          ok ? 200 : 401,
          cookieHeaderObj,
        );
      }

      if (!isAuthorized(req)) {
        return jsonResponse(
          {
            ok: false,
            requiresAccessCode: true,
            error: "Se requiere la clave de acceso del grupo.",
          },
          401,
          cookieHeaderObj,
        );
      }

      const session: PersonalWhatsAppSession = sessionManager.getOrCreateSession(sessionId);

      if (pathname === "/api/status" && req.method === "GET") {
        const status = await session.getStatus(
          sessionManager.getActiveSessionCount(),
        );
        return jsonResponse(
          { ...status, requiresAccessCode: Boolean(ACCESS_CODE) },
          200,
          cookieHeaderObj,
        );
      }

      if (pathname === "/api/connect" && req.method === "POST") {
        if (!sessionManager.canStartNewConnection(sessionId)) {
          return jsonResponse(
            {
              ok: false,
              error: `El servidor alcanzó el límite de ${MAX_SESSIONS} sesiones activas. Intenta en un minuto.`,
            },
            429,
            cookieHeaderObj,
          );
        }

        let pairingPhone: string | undefined;
        try {
          const body = await req.json();
          if (body && typeof body.pairingPhone === "string" && body.pairingPhone.trim()) {
            pairingPhone = body.pairingPhone.trim();
          }
        } catch {
          // empty body is fine
        }
        if (pairingPhone) {
          await session.connectWithPairingCode(pairingPhone);
        } else {
          await session.connect();
        }
        const status = await session.getStatus(
          sessionManager.getActiveSessionCount(),
        );
        return jsonResponse({ ok: true, ...status }, 200, cookieHeaderObj);
      }

      if (pathname === "/api/disconnect" && req.method === "POST") {
        await session.disconnect();
        const status = await session.getStatus(
          sessionManager.getActiveSessionCount(),
        );
        return jsonResponse({ ok: true, ...status }, 200, cookieHeaderObj);
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        await sessionManager.deleteSession(sessionId);
        return jsonResponse(
          {
            ok: true,
            state: "disconnected",
            mode: sessionManager.isPersistentLocalMode() ? "local" : "ephemeral",
            activeSessions: sessionManager.getActiveSessionCount(),
            maxSessions: MAX_SESSIONS,
          },
          200,
          cookieHeaderObj,
        );
      }

      if (pathname === "/api/download-webp" && req.method === "POST") {
        const { converted } = await parseStickerForm(req);
        return new Response(new Uint8Array(converted.webpBuffer), {
          status: 200,
          headers: {
            "content-type": "image/webp",
            "content-disposition": 'attachment; filename="sticker.webp"',
            "x-webp-bytes": String(converted.webpSizeBytes),
            "x-has-audio": String(Boolean(converted.audioBuffer)),
            ...(cookieHeaderObj || {}),
          },
        });
      }

      if (pathname === "/api/send" && req.method === "POST") {
        const status = await session.getStatus(
          sessionManager.getActiveSessionCount(),
        );
        if (status.state !== "connected") {
          return jsonResponse(
            { ok: false, error: "Conecta primero tu WhatsApp con el botón superior." },
            400,
            cookieHeaderObj,
          );
        }
        const { converted, emoji } = await parseStickerForm(req);
        const sent = await session.sendStickerToSelf(converted, emoji);

        return jsonResponse(
          {
            ok: true,
            messageId: sent.messageId,
            withAudio: sent.withAudio,
            targetJid: sent.targetJid,
            isAnimated: converted.isAnimated,
            webpSizeKB: Math.round((converted.webpSizeBytes / 1024) * 10) / 10,
            audioSizeKB: converted.audioSizeBytes
              ? Math.round((converted.audioSizeBytes / 1024) * 10) / 10
              : 0,
            audioDurationSec: converted.audioDurationSec ?? 0,
          },
          200,
          cookieHeaderObj,
        );
      }

      return jsonResponse({ ok: false, error: "Endpoint no encontrado" }, 404);
    }

    if (req.method === "GET") {
      return await serveStatic(pathname, setCookieHeader);
    }

    return new Response("Method Not Allowed", { status: 405 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[HTTP Error]", pathname, message);
    return jsonResponse({ ok: false, error: message }, 500, cookieHeaderObj);
  }
}

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, async () => {
      console.log(`Recibido ${sig}, cerrando sesiones...`);
      await sessionManager.shutdownAll();
      Deno.exit(0);
    });
  } catch {
    // SIGTERM is not supported on Windows Deno builds
  }
}

await sessionManager.autoConnectLocalIfSaved();

const modeLabel = sessionManager.isPersistentLocalMode()
  ? "LOCAL (sesión persistente en ./auth_info)"
  : `MULTI-SESIÓN EFÍMERA (en memoria, máx ${MAX_SESSIONS} usuarios)`;

console.log(`Sound Sticker Studio escuchando en http://${HOST}:${PORT}`);
console.log(`Modo: ${modeLabel}${ACCESS_CODE ? " · Clave de grupo ACTIVADA" : ""}`);
Deno.serve({ hostname: HOST, port: PORT }, handleRequest);
