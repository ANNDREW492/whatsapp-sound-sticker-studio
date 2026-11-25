const dropZone = document.getElementById("drop-zone");
const visualInput = document.getElementById("visual-input");
const audioInput = document.getElementById("audio-input");
const emptyPrompt = document.getElementById("empty-prompt");
const previewWrap = document.getElementById("preview-wrap");
const previewImg = document.getElementById("preview-img");
const previewVideo = document.getElementById("preview-video");
const soundBadge = document.getElementById("sound-badge");
const soundBadgeText = document.getElementById("sound-badge-text");
const btnChangeVisual = document.getElementById("btn-change-visual");

const btnClear = document.getElementById("btn-clear");
const btnDownload = document.getElementById("btn-download");
const btnSend = document.getElementById("btn-send");
const btnAudio = document.getElementById("btn-audio");
const audioLabel = document.getElementById("audio-label");
const btnClearAudio = document.getElementById("btn-clear-audio");
const audioPreview = document.getElementById("audio-preview");
const feedbackBar = document.getElementById("feedback-bar");

const durButtons = document.querySelectorAll(".dur-btn");
const optFit = document.getElementById("opt-fit");
const optStart = document.getElementById("opt-start");
const optIncludeAudio = document.getElementById("opt-include-audio");
const optPack = document.getElementById("opt-pack");
const optAuthor = document.getElementById("opt-author");
const optEmoji = document.getElementById("opt-emoji");

const btnWaStatus = document.getElementById("btn-wa-status");
const statusLabel = document.getElementById("status-label");
const waDialog = document.getElementById("wa-dialog");
const waQrBox = document.getElementById("wa-qr-box");
const waQrImg = document.getElementById("wa-qr-img");
const waPairingBox = document.getElementById("wa-pairing-box");
const waPairingCode = document.getElementById("wa-pairing-code");
const btnCopyPairing = document.getElementById("btn-copy-pairing");
const waConnectedBox = document.getElementById("wa-connected-box");
const waSelfName = document.getElementById("wa-self-name");
const waSelfJid = document.getElementById("wa-self-jid");
const waErrorBox = document.getElementById("wa-error-box");
const waLogs = document.getElementById("wa-logs");
const waModeNote = document.getElementById("wa-mode-note");
const waTtlBanner = document.getElementById("wa-ttl-banner");
const btnWaConnect = document.getElementById("btn-wa-connect");
const btnWaDisconnect = document.getElementById("btn-wa-disconnect");
const btnWaLogout = document.getElementById("btn-wa-logout");
const pairingPhone = document.getElementById("pairing-phone");
const btnWaPairing = document.getElementById("btn-wa-pairing");

const accessDialog = document.getElementById("access-dialog");
const accessForm = document.getElementById("access-form");
const accessCodeInput = document.getElementById("access-code-input");
const accessError = document.getElementById("access-error");

let selectedVisual = null;
let selectedAudio = null;
let selectedDuration = 10;
let visualObjectUrl = null;
let audioObjectUrl = null;
let waState = "disconnected";
let busy = false;
let accessCode = sessionStorage.getItem("sticker_access_code") || "";

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (accessCode) {
    headers["x-access-code"] = accessCode;
  }
  return headers;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: apiHeaders(options.headers || {}),
  });
  if (res.status === 401) {
    if (!accessDialog.open) {
      accessDialog.showModal();
    }
  }
  return res;
}

accessForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const candidate = accessCodeInput.value.trim();
  if (!candidate) return;
  accessCode = candidate;
  const res = await fetch("/api/auth-check", {
    method: "POST",
    headers: { "x-access-code": candidate },
  });
  if (res.ok) {
    sessionStorage.setItem("sticker_access_code", candidate);
    accessError.hidden = true;
    accessDialog.close();
    pollStatus();
  } else {
    accessCode = "";
    sessionStorage.removeItem("sticker_access_code");
    accessError.hidden = false;
  }
});

function showFeedback(text, kind = "") {
  feedbackBar.textContent = text;
  feedbackBar.className = `feedback-bar ${kind}`.trim();
  feedbackBar.hidden = false;
}

function hideFeedback() {
  feedbackBar.hidden = true;
}

function updateButtons() {
  const hasVisual = Boolean(selectedVisual);
  btnDownload.disabled = !hasVisual || busy;
  btnSend.disabled = !hasVisual || busy;

  const isVideo = selectedVisual?.type?.startsWith("video/");
  const willHaveAudio =
    optIncludeAudio.checked && (Boolean(selectedAudio) || Boolean(isVideo));

  if (hasVisual && willHaveAudio) {
    soundBadge.hidden = false;
    soundBadgeText.textContent = selectedAudio
      ? `Audio: ${selectedAudio.name.slice(0, 18)}`
      : `Audio del video (${selectedDuration}s)`;
  } else {
    soundBadge.hidden = true;
  }
}

function setVisualFile(file) {
  if (!file) return;
  if (visualObjectUrl) URL.revokeObjectURL(visualObjectUrl);
  selectedVisual = file;
  visualObjectUrl = URL.createObjectURL(file);

  emptyPrompt.hidden = true;
  previewWrap.hidden = false;

  if (file.type.startsWith("video/")) {
    previewImg.hidden = true;
    previewVideo.hidden = false;
    previewVideo.src = visualObjectUrl;
    previewVideo.load();
  } else {
    previewVideo.pause();
    previewVideo.hidden = true;
    previewVideo.removeAttribute("src");
    previewImg.hidden = false;
    previewImg.src = visualObjectUrl;
  }

  hideFeedback();
  updateButtons();
}

function setAudioFile(file) {
  if (!file) return;
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  selectedAudio = file;
  audioObjectUrl = URL.createObjectURL(file);

  audioLabel.textContent = file.name;
  btnAudio.classList.add("has-audio");
  btnClearAudio.hidden = false;
  audioPreview.src = audioObjectUrl;
  audioPreview.hidden = false;
  optIncludeAudio.checked = true;

  updateButtons();
}

function clearAudio() {
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  selectedAudio = null;
  audioObjectUrl = null;
  audioInput.value = "";
  audioLabel.textContent = "Elegir audio (MP3, M4A, WAV)";
  btnAudio.classList.remove("has-audio");
  btnClearAudio.hidden = true;
  audioPreview.pause();
  audioPreview.removeAttribute("src");
  audioPreview.hidden = true;
  updateButtons();
}

function clearAll() {
  if (visualObjectUrl) URL.revokeObjectURL(visualObjectUrl);
  selectedVisual = null;
  visualObjectUrl = null;
  visualInput.value = "";
  previewImg.hidden = true;
  previewImg.removeAttribute("src");
  previewVideo.pause();
  previewVideo.hidden = true;
  previewVideo.removeAttribute("src");
  previewWrap.hidden = true;
  emptyPrompt.hidden = false;
  clearAudio();
  hideFeedback();
  updateButtons();
}

function buildFormData() {
  const fd = new FormData();
  fd.append("visual", selectedVisual);
  if (selectedAudio) {
    fd.append("audio", selectedAudio);
  }
  fd.append("duration", String(selectedDuration));
  fd.append("startSec", String(optStart.value || "0"));
  fd.append("fit", optFit.value);
  fd.append("includeAudio", String(optIncludeAudio.checked));
  fd.append("packName", optPack.value);
  fd.append("author", optAuthor.value);
  fd.append("emoji", optEmoji.value || "🎵");
  return fd;
}

// Canvas interactions
dropZone.addEventListener("click", (e) => {
  if (e.target.closest("video") || e.target.closest("button")) return;
  visualInput.click();
});

dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    visualInput.click();
  }
});

btnChangeVisual.addEventListener("click", () => visualInput.click());

visualInput.addEventListener("change", () => {
  if (visualInput.files?.[0]) setVisualFile(visualInput.files[0]);
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer?.files || []);
  for (const f of files) {
    if (f.type.startsWith("audio/")) {
      setAudioFile(f);
    } else if (f.type.startsWith("image/") || f.type.startsWith("video/")) {
      setVisualFile(f);
    }
  }
});

btnAudio.addEventListener("click", () => audioInput.click());
audioInput.addEventListener("change", () => {
  if (audioInput.files?.[0]) setAudioFile(audioInput.files[0]);
});
btnClearAudio.addEventListener("click", clearAudio);
btnClear.addEventListener("click", clearAll);
optIncludeAudio.addEventListener("change", updateButtons);

durButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedDuration = Number(btn.dataset.sec);
    durButtons.forEach((b) => b.classList.toggle("active", b === btn));
    updateButtons();
  });
});

// Download WebP locally
btnDownload.addEventListener("click", async () => {
  if (!selectedVisual || busy) return;
  busy = true;
  updateButtons();
  showFeedback("Convirtiendo a WebP 512×512 con FFmpeg...");
  try {
    const res = await apiFetch("/api/download-webp", {
      method: "POST",
      body: buildFormData(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Error al convertir");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sticker.webp";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showFeedback(
      `WebP descargado (${Math.round(blob.size / 1024)} KB). Recuerda: el audio solo va al enviarlo directo a WhatsApp.`,
      "ok",
    );
  } catch (err) {
    showFeedback(err.message, "err");
  } finally {
    busy = false;
    updateButtons();
  }
});

// Send sound sticker to self on WhatsApp
btnSend.addEventListener("click", async () => {
  if (!selectedVisual || busy) return;
  if (waState !== "connected") {
    waDialog.showModal();
    showFeedback("Primero conecta tu WhatsApp (escanea el QR) para recibir el sticker en tu chat.", "err");
    return;
  }

  busy = true;
  updateButtons();
  showFeedback("Procesando con FFmpeg y enviando a tu chat personal de WhatsApp...");

  try {
    const res = await apiFetch("/api/send", {
      method: "POST",
      body: buildFormData(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Error enviando sticker");
    }
    const msg = data.withAudio
      ? `¡Listo! Sticker con audio enviado a tu chat "Tú" (WebP ${data.webpSizeKB} KB + Audio ${data.audioSizeKB} KB, ${data.audioDurationSec}s).`
      : `¡Listo! Sticker enviado a tu chat "Tú" (WebP ${data.webpSizeKB} KB, sin audio).`;
    showFeedback(msg, "ok");
  } catch (err) {
    showFeedback(`Error: ${err.message}`, "err");
  } finally {
    busy = false;
    updateButtons();
  }
});

// WhatsApp connection modal & polling
btnWaStatus.addEventListener("click", () => waDialog.showModal());

btnWaConnect.addEventListener("click", async () => {
  const res = await apiFetch("/api/connect", { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.error) showFeedback(data.error, "err");
  }
  pollStatus();
});

btnWaPairing.addEventListener("click", async () => {
  const phone = pairingPhone.value.trim();
  if (!phone) {
    waErrorBox.textContent = "Escribe tu número con código de país (sin +), ej: 51999888777";
    waErrorBox.hidden = false;
    return;
  }
  btnWaPairing.disabled = true;
  btnWaPairing.textContent = "Generando...";
  waErrorBox.hidden = true;
  try {
    const res = await apiFetch("/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingPhone: phone }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      waErrorBox.textContent = data.error || "No se pudo generar el código.";
      waErrorBox.hidden = false;
    }
  } catch (err) {
    waErrorBox.textContent = err.message || "Error de red generando código.";
    waErrorBox.hidden = false;
  } finally {
    btnWaPairing.disabled = false;
    btnWaPairing.textContent = "Pedir código";
    pollStatus();
  }
});

btnCopyPairing.addEventListener("click", async () => {
  const raw = waPairingCode.dataset.raw || waPairingCode.textContent.replace(/-/g, "");
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    btnCopyPairing.textContent = "¡Copiado!";
    setTimeout(() => {
      btnCopyPairing.textContent = "Copiar código";
    }, 1800);
  } catch {
    btnCopyPairing.textContent = "Cópialo manualmente arriba";
  }
});

btnWaDisconnect.addEventListener("click", async () => {
  await apiFetch("/api/disconnect", { method: "POST" });
  pollStatus();
});

btnWaLogout.addEventListener("click", async () => {
  await apiFetch("/api/logout", { method: "POST" });
  pollStatus();
});

function formatRemaining(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function pollStatus() {
  try {
    const res = await apiFetch("/api/status");
    if (!res.ok) return;
    const s = await res.json();
    waState = s.state;
    btnWaStatus.dataset.state = s.state;

    const labels = {
      disconnected: "Conectar WhatsApp",
      connecting: "Conectando...",
      qr: "Escanear QR",
      connected: s.selfName ? `Tú: ${s.selfName.slice(0, 16)}` : "Conectado",
      error: "Error de conexión",
    };
    statusLabel.textContent = labels[s.state] || s.state;

    if (s.mode === "local") {
      waModeNote.innerHTML =
        '<strong>Modo local personal:</strong> tu sesión se guarda solo en esta PC (<code>auth_info/</code>). No lee grupos ni chats ajenos y solo envía a tu chat <em>"Mensajes contigo mismo"</em>.';
      waTtlBanner.hidden = true;
    } else {
      waModeNote.innerHTML =
        '<strong>Modo multi-sesión temporal:</strong> tu sesión vive solo en memoria RAM (nunca se guarda en disco), no lee chats ni grupos y solo envía stickers a tu chat <em>"Mensajes contigo mismo"</em>.';
      if (s.expiresInSec !== null && s.expiresInSec !== undefined) {
        waTtlBanner.textContent = `Sesión temporal activa · se desvinculará y borrará automáticamente tras ${formatRemaining(s.expiresInSec)} de inactividad (${s.activeSessions}/${s.maxSessions} sesiones activas).`;
        waTtlBanner.hidden = false;
      } else {
        waTtlBanner.hidden = true;
      }
    }

    waQrBox.hidden = !(s.state === "qr" && s.qrDataUrl && !s.pairingCode);
    if (s.qrDataUrl) waQrImg.src = s.qrDataUrl;

    waPairingBox.hidden = !s.pairingCode;
    if (s.pairingCode) {
      waPairingCode.dataset.raw = s.pairingCode;
      waPairingCode.textContent =
        s.pairingCode.length === 8
          ? `${s.pairingCode.slice(0, 4)}-${s.pairingCode.slice(4)}`
          : s.pairingCode;
    }

    waConnectedBox.hidden = s.state !== "connected";
    if (s.state === "connected") {
      waSelfName.textContent = s.selfName || "Tu cuenta";
      waSelfJid.textContent = s.selfJid || "";
    }

    waErrorBox.hidden = !s.lastError;
    if (s.lastError) waErrorBox.textContent = s.lastError;

    btnWaConnect.hidden = s.state === "connected" || s.state === "connecting";
    btnWaDisconnect.hidden = s.mode !== "local" || s.state === "disconnected";
    btnWaLogout.hidden =
      s.mode === "local"
        ? !s.hasSavedSession && s.state === "disconnected"
        : s.state === "disconnected";

    waLogs.textContent = (s.logs || []).join("\n") || "(sin eventos aún)";
  } catch {
    // ignore transient poll errors
  }
}

pollStatus();
setInterval(pollStatus, 2500);
updateButtons();
