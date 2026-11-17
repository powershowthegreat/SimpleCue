import { icon, hydrateIcons } from "./icons.js";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheKeys,
  mediaBlob,
  peaks,
  setMediaNetworkEnabled,
} from "./cache.js";
import { renameMediaFile } from "./media-name.js";
import {
  queueChange,
  queuedChanges,
  acknowledge,
  blockChange,
  retryChanges,
} from "./outbox.js";
import { CueEngine } from "./engine.js";
import { formatTime as fmt, formatCropTime, parseCropTime } from "./time.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
function linkedToNext(c, index) {
  const next = current()?.cues[index + 1];
  return Boolean(next?.follow && next.followFrom === c.id);
}
function modifierSummary(c, index) {
  const parts = [],
    loop = c.loop ?? 1;
  if (loop === "forever") parts.push("loop forever");
  else if (loop > 1) parts.push(`loop ${loop}x`);
  if (linkedToNext(c, index)) parts.push("autoplay next");
  if (c.fadeIn > 0) parts.push(`fade in ${c.fadeIn}s`);
  if (c.fadeOut > 0) parts.push(`fade out ${c.fadeOut}s`);
  if (c.fadeOutAtPause > 0)
    parts.push(`fade out at pause ${c.fadeOutAtPause}s`);
  return parts.join(" | ");
}
function normalizeLinks(s) {
  s.cues.forEach((c, i) => {
    const yes = Boolean(i > 0 && c.follow && c.followFrom === s.cues[i - 1].id);
    c.follow = yes;
    c.followFrom = yes ? s.cues[i - 1].id : null;
  });
}
const defaults = {
  next: "ArrowRight",
  previous: "ArrowLeft",
  reset: "r",
  toggle: " ",
};
const state = {
  tab: "editor",
  media: [],
  sequences: [],
  activeId: null,
  mediaQuery: "",
  libraryQuery: "",
  view: "media",
  selected: new Set(),
  cached: new Set(),
  busy: new Set(),
  collapsed: new Set(),
  offline: !navigator.onLine,
  manualOffline: localStorage.getItem("simplecue-offline-mode") === "true",
  pending: [],
  syncing: false,
  authExpired: false,
  verifiedUser: null,
  prefs: { accent: "#d6e5a5", keybinds: { ...defaults } },
  devices: [],
  deviceLabel: "System default",
  user: null,
};
const isOffline = () =>
  state.manualOffline || state.offline || !navigator.onLine;
const current = () =>
  state.sequences.find((s) => s.id === state.activeId) || state.sequences[0];
const media = (id) => state.media.find((m) => m.id === id);
const duration = (seq) =>
  seq.cues.reduce(
    (n, c) =>
      n +
      (c.loop === "forever"
        ? Infinity
        : ((c.end - c.start) / c.speed) * (c.loop ?? 1)),
    0,
  );
const isCached = (type, id) =>
  type === "media"
    ? state.cached.has(`media:${id}`)
    : state.cached.has(`sequence:${id}`) &&
      state.sequences
        .find((s) => s.id === id)
        ?.cues.every((c) => state.cached.has(`media:${c.mediaId}`));
const engine = new CueEngine(current, media);
let renderIndex = -1,
  keyCapture = null,
  uploadFolder = "Uploads",
  waveResize;
const modal = $("#modal");
function toast(message, error = false) {
  const d = document.createElement("div");
  d.className = `toast ${error ? "error" : ""}`;
  d.textContent = message;
  $("#toast-region").append(d);
  setTimeout(() => d.remove(), 5000);
}
async function readResponse(r, url, silentAuth = false) {
  const responseError = (message) =>
    Object.assign(new Error(message), { status: r.status });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (r.status === 413)
      throw responseError(
        "The hosting service rejected the upload size (HTTP 413). Reload to use chunked local uploads, or configure Upstash Blob for cloud uploads.",
      );
    if (r.status === 401 || r.status === 403)
      throw responseError(
        `The hosting service denied this request (HTTP ${r.status}). Check deployment access and sign in again.`,
      );
    if (r.status >= 500)
      throw responseError(
        `The server or upload gateway failed (HTTP ${r.status}). Retry after checking the server logs.`,
      );
    throw responseError(
      `Expected an API response but received a page (HTTP ${r.status}). Check that /api routes point to the Express function, then reload.`,
    );
  }
  if (!r.ok) {
    if (r.status === 401 && url != "/api/login" && !silentAuth) showLogin();
    throw Object.assign(
      new Error(data.error || `Request failed (HTTP ${r.status}).`),
      { status: r.status },
    );
  }
  return data;
}
let networkController = new AbortController(),
  probeTimer = null,
  probeDelay = 10000,
  probing = null,
  endpointMissing = false;
const offlineError = () =>
  Object.assign(
    new Error(
      "Offline: changes are saved on this device and will sync after reconnecting.",
    ),
    { offline: true },
  );
function updateConnectivity() {
  setMediaNetworkEnabled(!isOffline());
  navigator.serviceWorker?.controller?.postMessage({
    type: "NETWORK_MODE",
    offline: isOffline(),
  });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.ready
      .then((reg) =>
        reg.active?.postMessage({ type: "NETWORK_MODE", offline: isOffline() }),
      )
      .catch(() => {});
  const badge = $("#online-status");
  if (badge) {
    badge.innerHTML = `<i></i>${state.manualOffline ? "Offline mode" : isOffline() ? "Offline" : "Online"}`;
    badge.dataset.offline = String(isOffline());
    badge.title = state.manualOffline
      ? "Offline mode is on in settings"
      : isOffline()
        ? "Server unavailable. Click to retry."
        : "Connected to the server";
  }
  $("#login-offline-toggle")?.classList.toggle("hidden", !state.manualOffline);
  updateCacheStatus();
  updateSyncStatus();
}
function scheduleProbe() {
  clearTimeout(probeTimer);
  if (state.manualOffline || !navigator.onLine || endpointMissing) return;
  probeTimer = setTimeout(() => probeConnection(), probeDelay);
  probeDelay = Math.min(60000, probeDelay * 2);
}
function markOffline() {
  state.offline = true;
  state.verifiedUser = null;
  updateConnectivity();
  scheduleProbe();
}
async function api(url, options = {}) {
  if (isOffline()) throw offlineError();
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || networkController.signal,
      headers:
        options.body instanceof FormData
          ? options.headers
          : { "Content-Type": "application/json", ...options.headers },
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });
  } catch {
    if (!state.manualOffline) markOffline();
    throw offlineError();
  }
  if (response.status >= 500) {
    markOffline();
    throw Object.assign(offlineError(), { status: response.status });
  }
  if (
    response.status === 404 &&
    ["/api/session", "/api/workspace", "/api/health"].includes(url)
  ) {
    endpointMissing = true;
    markOffline();
    throw Object.assign(offlineError(), { status: 404 });
  }
  return readResponse(response, url, options.silentAuth);
}
async function probeConnection() {
  if (state.manualOffline || !navigator.onLine) {
    updateConnectivity();
    return false;
  }
  if (probing) return probing;
  probing = (async () => {
    try {
      const response = await fetch("/api/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) {
        endpointMissing = true;
        markOffline();
        return false;
      }
      if (!response.ok) throw new Error("Server unavailable.");
      const health = await response.json();
      if (!health.ok) throw new Error("Server unavailable.");
      if (state.manualOffline) return false;
      state.offline = false;
      endpointMissing = false;
      probeDelay = 10000;
      clearTimeout(probeTimer);
      updateConnectivity();
      if (state.user) {
        const user = await api("/api/session", { silentAuth: true });
        if (user.username !== state.user.username) {
          state.authExpired = true;
          updateSyncStatus();
          return false;
        }
        state.verifiedUser = user.username;
        state.authExpired = false;
        await syncPending();
      }
      return true;
    } catch (error) {
      if (error.status === 401) {
        state.authExpired = true;
        updateSyncStatus();
      } else markOffline();
      return false;
    } finally {
      probing = null;
    }
  })();
  return probing;
}
async function setOfflineMode(enabled) {
  state.manualOffline = enabled;
  localStorage.setItem("simplecue-offline-mode", String(enabled));
  await cacheSet("meta", "network-mode", enabled);
  networkController.abort();
  networkController = new AbortController();
  clearTimeout(probeTimer);
  updateConnectivity();
  render();
  if (!enabled) {
    endpointMissing = false;
    state.offline = !navigator.onLine;
    await probeConnection();
  }
}
function setAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  state.prefs.accent = color;
  document.documentElement.style.setProperty("--accent", color);
  drawWaves();
}
function setTheme(mode) {
  state.prefs.mode = mode === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.prefs.mode;
  const toggle = $("#theme-toggle");
  toggle.innerHTML = icon(mode === "dark" ? "sun" : "moon");
  toggle.title = `Switch to ${mode === "dark" ? "light" : "dark"} mode`;
  toggle.setAttribute("aria-label", toggle.title);
  drawWaves();
}
async function prefs() {
  const values = { ...state.prefs, activeId: state.activeId };
  localStorage.setItem("simplecue-prefs", JSON.stringify(values));
  await persistWorkspace();
  if (state.user) {
    await queueChange(
      state.user.username,
      "preferences",
      "settings",
      "put",
      values,
    );
    await refreshPending();
    requestSync();
  }
}
async function persistWorkspace() {
  await cacheSet("meta", "workspace", {
    media: state.media,
    sequences: state.sequences,
    preferences: { ...state.prefs, activeId: state.activeId },
    user: state.user,
    database: state.database,
    uploads: state.uploads,
  });
}
async function refreshCache() {
  state.cached = new Set(await cacheKeys("assets"));
  updateCacheStatus();
}
function updateCacheStatus() {
  const n = state.media.filter((m) => isCached("media", m.id)).length;
  $("#cache-status").innerHTML =
    `${icon("harddrive")}${n} / ${state.media.length} media cached`;
  $("#connection-status").innerHTML =
    `<i class="status-dot" style="${isOffline() ? "background:#c79e69" : ""}"></i> ${isOffline() ? "Offline · local workspace" : state.database === "redis" ? "Redis connected" : "Local storage"}`;
}
function cacheButton(type, id, small = false) {
  const yes = isCached(type, id),
    busy = state.busy.has(`${type}:${id}`);
  return `<button class="icon-button ${small ? "small" : ""} ${yes ? "cached-icon" : ""}" data-action="cache" data-type="${type}" data-id="${esc(id)}" title="${yes ? "Remove from local cache" : "Cache for offline use"}" aria-label="${yes ? "Uncache" : "Cache"} ${type}" ${busy ? "disabled" : ""}>${icon(busy ? "clock" : yes ? "uncache" : "download")}</button>`;
}
function renderSidebar() {
  return `<aside class="sidebar"><section class="sidebar-sequences"><div class="section-header"><span class="section-kicker">SEQUENCES <span class="count-badge">${state.sequences.length}</span></span><button class="icon-button small" data-action="new-sequence" title="New sequence" aria-label="New sequence">${icon("plus")}</button></div><div class="sequence-list">${state.sequences.map((s) => `<div class="sequence-tile ${current()?.id === s.id ? "active" : ""}" role="button" tabindex="0" data-action="select-sequence" data-id="${esc(s.id)}"><span class="file-icon">${icon("file")}</span><div class="tile-info"><div class="tile-title">${esc(s.name)}</div><div class="tile-meta">${esc(s.description || "No description")} · ${isCached("sequence", s.id) ? "Cached" : "Not cached"}</div></div>${cacheButton("sequence", s.id, true)}</div>`).join("") || '<div class="empty-state">No sequences.</div>'}</div></section><div class="panel-divider horizontal" role="separator" tabindex="0" aria-label="Resize sequence list" aria-orientation="horizontal" data-resize="library"></div><section class="media-library"><div class="section-header"><span class="section-kicker">MEDIA LIBRARY <span class="count-badge">${state.media.length}</span></span><button class="icon-button small" data-action="upload" title="Upload media" aria-label="Upload media">${icon("upload")}</button></div><div class="search-wrap">${icon("search")}<input class="search-input" id="library-search" placeholder="Find your media…" aria-label="Search media library" value="${esc(state.libraryQuery)}"></div><div id="library-files" class="library-files">${renderLibraryFiles()}</div><button class="upload-zone" data-action="upload">${icon("plus")} Upload media</button></section></aside>`;
}
function renderLibraryFiles() {
  const filtered = state.media.filter((m) =>
    `${m.name} ${m.folder} ${m.extension}`
      .toLowerCase()
      .includes(state.libraryQuery.toLowerCase()),
  );
  const folders = [...new Set(filtered.map((m) => m.folder))];
  return (
    folders
      .map((folder) => {
        const items = filtered.filter((m) => m.folder === folder),
          closed = state.collapsed.has(folder);
        return `<div class="folder-group"><div class="folder-label" role="button" tabindex="0" data-action="folder" data-folder="${esc(folder)}">${icon(closed ? "chevron" : "down", "chevron")}${icon("folder")}${esc(folder)}<span class="folder-count">${items.length}</span></div>${closed ? "" : items.map((m) => `<div class="media-tile" draggable="true" data-media-id="${esc(m.id)}" title="Drag into the cue list, or use + to add"><span class="file-icon">${icon(m.type.startsWith("video") ? "video" : "audio")}</span><div class="tile-info"><div class="tile-title">${esc(m.name)}</div><div class="tile-meta">${esc(m.extension)} · ${fmt(m.duration)} · ${isCached("media", m.id) ? "Cached" : "Not cached"}</div></div><button class="icon-button small add-media" data-action="add-media" data-id="${esc(m.id)}" aria-label="Add ${esc(m.name)} to sequence" title="Add to sequence">${icon("plus")}</button>${cacheButton("media", m.id, true)}</div>`).join("")}</div>`;
      })
      .join("") ||
    '<div class="empty-state tiny">No media matches your search.</div>'
  );
}
function cropValue(cue, key, seconds) {
  const value = Math.round(seconds * 100) / 100,
    duration = media(cue.mediaId).duration;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > Math.round(duration * 100) / 100 ||
    (key === "start" && value >= cue.end) ||
    (key === "end" && value <= cue.start)
  )
    throw new Error(
      "Crop In must be before Crop Out, within the media’s duration.",
    );
  return value;
}
function setCropPoint(cueId, key, seconds) {
  assertEditable(current());
  const seq = current(),
    index = seq?.cues.findIndex((c) => c.id === cueId),
    cue = seq?.cues[index];
  if (!cue || !["start", "end"].includes(key))
    throw new Error("Cue no longer available.");
  cue[key] = cropValue(cue, key, seconds);
  if (index === engine.index) engine.apply();
  scheduleSave(seq);
  render();
}
function renderCue(c, i, production = false) {
  const m = media(c.mediaId);
  if (!m) return "";
  return `<article class="cue-card ${production ? "production-cue" : ""} ${i === engine.index ? "active-cue" : ""}" data-cue-id="${esc(c.id)}" data-index="${i}">
    <div class="cue-card-top" ${!production ? `draggable="true" data-cue-drag="${i}"` : ""}><span class="cue-number" title="${production ? "Cue number" : "Drag track to reorder"}">${String(i + 1).padStart(2, "0")}</span>
      <div class="cue-name-row"><div><div class="cue-name">${esc(m.name)}</div></div><span class="filetype">${esc(m.extension)}</span>${production ? (c.cueText ? `<strong class="cue-word">${esc(c.cueText)}</strong>` : "") : `<input class="cue-word cue-word-input" type="text" data-cue-setting="cueText" data-index="${i}" aria-label="Cue word for cue ${i + 1}" placeholder="Cue word" maxlength="120" value="${esc(c.cueText || "")}" autocomplete="off">`}</div>
      ${production ? `<span class="production-settings">${c.volume}% · ${c.speed}× · ${modifierSummary(c, i) || "Manual next"}</span>` : ""}
      ${cacheButton("media", m.id, true)}${!production ? `<button class="icon-button small" data-action="cue-duplicate" data-index="${i}" aria-label="Duplicate ${esc(m.name)}" title="Duplicate track">${icon("copy")}</button><button class="icon-button small danger-button" data-action="cue-remove" data-index="${i}" aria-label="Delete ${esc(m.name)}" title="Delete track from sequence">${icon("trash")}</button>` : ""}
    </div>
    <div class="wave-wrap" data-seek-index="${i}" role="slider" tabindex="0" aria-label="Seek ${esc(m.name)} using waveform" aria-valuemin="0" aria-valuemax="${m.duration}" aria-valuenow="0"><canvas class="wave-canvas" data-wave="${esc(m.id)}" data-start="${c.start}" data-end="${c.end}" aria-label="Waveform of ${esc(m.name)}"></canvas><div class="wave-loading">Loading waveform…</div><div class="wave-trim-shade before" style="width:${(c.start / m.duration) * 100}%"></div><div class="wave-trim-shade after" style="width:${Math.max(0, ((m.duration - c.end) / m.duration) * 100)}%"></div>${c.start > 0 ? `<div class="trim-marker in-marker" style="left:${(c.start / m.duration) * 100}%"><span>IN ${fmt(c.start)}</span></div>` : ""}${c.end < m.duration - 0.005 ? `<div class="trim-marker out-marker" style="left:${(c.end / m.duration) * 100}%"><span>OUT ${fmt(c.end)}</span></div>` : ""}<div class="wave-playhead" data-playhead="${i}" style="display:${i === engine.index ? "block" : "none"};left:${(c.start / m.duration) * 100}%"></div></div><div class="wave-range-meta"><span>${fmt(0)}</span>${c.start > 0 || c.end < m.duration - 0.005 ? `<span class="crop-relative">Crop: ${fmt(c.start)} — ${fmt(c.end)}</span>` : "<span></span>"}<span>${fmt(m.duration)}</span></div>
    ${trackTransport(c, i)}${m.type.startsWith("video") ? `<div class="track-video-slot ${i === engine.index ? "" : "hidden"}" data-video-index="${i}"></div>` : ""}
    ${production ? "" : `<div class="cue-controls"><div class="control-field">${icon("volume")}<span>Gain</span><input aria-label="Gain for cue ${i + 1}" type="range" min="0" max="200" step="1" value="${c.volume}" data-cue-setting="volume" data-index="${i}"><button class="editable-value volume-value" data-action="edit-setting-value" data-setting="volume" data-index="${i}" title="Click to enter gain">${c.volume}%</button></div><span class="control-divider"></span><div class="control-field">${icon("speed")}<span>Speed</span><span class="speed-range"><input aria-label="Speed for cue ${i + 1}" aria-valuetext="${Math.round(c.speed * 100)}%${c.speed === 1 ? ", normal speed" : ""}" type="range" min="0" max="200" step="1" value="${Math.min(200, Math.round(c.speed * 100))}" data-cue-setting="speed" data-index="${i}"><span class="speed-reference" title="100% · normal playback" aria-hidden="true">100%</span></span><button class="editable-value speed-value" data-action="edit-setting-value" data-setting="speed" data-index="${i}" title="Click to enter speed">${Math.round(c.speed * 100)}%</button></div><span class="control-divider"></span><label class="control-field"><span class="trim-label">${icon("trim")} In</span><input type="text" class="time-input" aria-label="Crop in for cue ${i + 1}" title="Minutes:seconds:hundredths (MM:SS:cc)" placeholder="00:00:00" autocomplete="off" spellcheck="false" value="${formatCropTime(c.start)}" data-cue-setting="start" data-index="${i}"></label><label class="control-field"><span class="trim-label">Out</span><input type="text" class="time-input" aria-label="Crop out for cue ${i + 1}" title="Minutes:seconds:hundredths (MM:SS:cc)" placeholder="00:00:00" autocomplete="off" spellcheck="false" value="${formatCropTime(c.end)}" data-cue-setting="end" data-index="${i}"></label><div class="cue-config-wrap"><span class="cue-modifiers" aria-label="Active cue modifiers">${esc(modifierSummary(c, i))}</span><button class="button cue-config-button" data-action="cue-config" data-cue-id="${esc(c.id)}" aria-label="Configure ${esc(m.name)}">${icon("settings")} Config</button></div></div>`}
  </article>`;
}
function trackTransport(c, i) {
  const active = i === engine.index,
    elapsed =
      active && !engine.loading
        ? Math.max(c.start, Math.min(c.end, engine.el.currentTime))
        : c.start,
    total = c.end;
  return `<div class="track-transport" data-track-transport="${i}">
    <button class="icon-button track-play" data-action="play-cue" data-index="${i}" aria-label="Play ${esc(media(c.mediaId)?.name)}" title="Play / pause">${icon(active && engine.playing && !engine.pausing ? "pause" : "play")}</button>
    <button class="icon-button small" data-action="reset-cue" data-index="${i}" aria-label="Reset cue ${i + 1}" title="Reset to in point">${icon("reset")}</button>
    <button class="icon-button small" data-action="stop-cue" data-index="${i}" aria-label="Stop cue ${i + 1}" title="Stop">${icon("stop")}</button>
    <span class="track-time" data-track-elapsed="${i}">${fmt(elapsed)}</span>
    <span class="track-time-divider">/</span>
    <span class="track-time">${fmt(total)}</span><span class="flex-1"></span><span class="track-status" data-track-status="${i}">${active ? "Active" : "Ready"}</span>
  </div>`;
}
function renderEditor() {
  const s = current();
  return `<div class="editor-layout">${renderSidebar()}<div class="panel-divider vertical" role="separator" tabindex="0" aria-label="Resize media sidebar" aria-orientation="vertical" data-resize="editor"></div><section class="workspace">${
    s
      ? `
    <div class="sequence-heading"><div class="sequence-title-row"><div class="sequence-title"><h2>${esc(s.name)}</h2><button class="icon-button small" data-action="edit-sequence" aria-label="Edit sequence details">${icon("edit")}</button><span class="tiny muted">${s.cues.length} cues · ${fmt(duration(s))} · ${s.cues.filter((c) => isCached("media", c.mediaId)).length} cached</span></div>
    <div class="flex items-center gap-2"><button class="button" data-action="cache-sequence">${icon("download")} Cache all</button><button class="icon-button small" data-action="sequence-menu" aria-label="Sequence options">${icon("more")}</button></div></div>${s.description ? `<p class="sequence-description">${esc(s.description)}</p>` : ""}</div>
    <div class="cues-scroll" id="cue-dropzone">${s.cues.map((c, i) => renderCue(c, i)).join("") || '<div class="empty-state">No cues. Add media from the library.</div>'}<button class="add-cue-area w-full" data-action="add-picker">${icon("plus")} Add cue</button></div>
    `
      : '<div class="empty-state"><p>No sequences.</p><button class="button button-dark" data-action="new-sequence">New sequence</button></div>'
  }</section></div>`;
}
function renderPlayer() {
  const s = current();
  return `<div class="player-layout"><section class="workspace"><div class="sequence-heading"><div class="sequence-title-row"><div class="sequence-title"><h2>${esc(s?.name || "No sequence")}</h2><span class="tiny muted">${s?.cues.length || 0} cues · ${fmt(s ? duration(s) : 0)}</span></div><span class="deck-status" id="deck-status">Standing by</span></div></div><div class="cues-scroll player-cues">${s?.cues.map((c, i) => renderCue(c, i, true)).join("") || '<div class="empty-state">Add cues in the editor.</div>'}</div></section>
  <div class="panel-divider vertical" role="separator" tabindex="0" aria-label="Resize master output" aria-orientation="vertical" data-resize="output"></div><aside class="output-panel"><span class="section-kicker">MASTER GAIN</span><div class="output-device">${icon(/bluetooth|airpod|wireless/i.test(state.deviceLabel) ? "bluetooth" : "speaker")}<div class="device-name" id="output-device-name" title="${esc(state.deviceLabel)}">${esc(state.deviceLabel)}</div><select id="output-device-select" class="output-select" aria-label="Audio output device">${deviceOptions()}</select><span class="output-permission-note" id="output-permission-note"></span></div><div class="fader-wrap"><input class="fader" type="range" min="0" max="200" step="1" value="${engine.master * 100}" data-master aria-label="Master output gain"><div class="fader-labels"><span>200</span><span>150</span><span>100</span><span>50</span><span>0</span></div></div><div class="output-level"><span data-master-label>${Math.round(engine.master * 100)}</span><small> %</small></div><button class="icon-button output-mute" data-action="mute" aria-label="Mute master output" title="Mute master output">${icon(engine.muted ? "mute" : "volume")}</button><span class="tiny muted mt-3">${engine.muted ? "Muted" : "Stereo"}</span></aside></div>`;
}
function filteredRows() {
  return (state.view === "media" ? state.media : state.sequences).filter((m) =>
    `${m.name} ${m.folder || ""} ${m.description || ""} ${m.extension || "m3u"}`
      .toLowerCase()
      .includes(state.mediaQuery.toLowerCase()),
  );
}
function renderMediaRows() {
  const seq = state.view === "sequences",
    type = seq ? "sequence" : "media";
  return (
    filteredRows()
      .map(
        (m) =>
          `<tr><td><input type="checkbox" data-select-id="${esc(m.id)}" aria-label="Select ${esc(m.name)}" ${state.selected.has(m.id) ? "checked" : ""}></td><td><div class="table-name"><span class="file-icon">${icon(seq ? "file" : m.type.startsWith("video") ? "video" : "audio")}</span><div>${seq ? `<div class="tile-title">${esc(m.name)}</div>` : `<button class="media-name-button tile-title" data-action="rename-media" data-id="${esc(m.id)}" title="Rename file" aria-label="Rename ${esc(m.filename)}">${esc(m.name)} ${icon("edit")}</button>`}<div class="tile-meta">${esc(seq ? m.description : m.filename)}${m.demo ? " · Sample" : ""}</div></div></div></td><td>${esc(seq ? "M3U" : m.extension)}</td><td>${seq ? `${m.cues.length} cues` : esc(m.folder)}</td><td>${fmt(seq ? duration(m) : m.duration)}</td><td>${seq ? "—" : bytes(m.size)}</td><td><span class="${isCached(type, m.id) ? "cached-pill" : "cached-pill no"}">${icon(isCached(type, m.id) ? "check" : "harddrive")}${isCached(type, m.id) ? "Cached" : "Not cached"}</span></td><td>${new Date(m.updatedAt || m.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td><td><div class="table-actions">${cacheButton(type, m.id, true)}<button class="icon-button small" data-action="${seq ? "open-sequence" : "preview-media"}" data-id="${esc(m.id)}" aria-label="${seq ? "Open sequence" : "Preview media"}" title="${seq ? "Open sequence" : "Preview media"}">${icon("play")}</button><button class="icon-button small" data-action="download-${type}" data-id="${esc(m.id)}" aria-label="Download ${esc(m.name)}" title="Download file">${icon("file")}</button><button class="icon-button small" data-action="${seq ? "edit-row-sequence" : "edit-media"}" data-id="${esc(m.id)}" aria-label="Edit ${esc(m.name)}" title="Edit details">${icon("edit")}</button><button class="icon-button small danger-button" data-action="delete-${type}" data-id="${esc(m.id)}" aria-label="Delete ${esc(m.name)}" title="Delete">${icon("trash")}</button></div></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="9"><div class="empty-state">No files found. Try another search or upload something new.</div></td></tr>'
  );
}
function renderMedia() {
  const seq = state.view === "sequences";
  return `<section class="media-view"><div class="media-view-header"><div><h2>Media</h2><p>Manage sequences and media files.</p></div><div class="flex gap-2"><button class="button" data-action="import">${icon("file")} Import M3U</button><button class="button button-dark" data-action="upload">${icon("upload")} Upload media</button></div></div><div class="media-view-tools"><select class="view-select" id="media-view-select" aria-label="Media category"><option value="media" ${!seq ? "selected" : ""}>Media files (${state.media.length})</option><option value="sequences" ${seq ? "selected" : ""}>Sequences (${state.sequences.length})</option></select><div class="search-wrap">${icon("search")}<input id="media-search" class="search-input" value="${esc(state.mediaQuery)}" placeholder="Search names, folders, file types…" aria-label="Search all files"></div><span class="flex-1"></span><button class="button" data-action="mass-cache">${icon("download")} Cache <span id="cache-selection-label">${state.selected.size ? "selected" : "all"}</span></button><button class="button" data-action="mass-uncache">${icon("uncache")} Uncache <span id="uncache-selection-label">${state.selected.size ? "selected" : "all"}</span></button></div><div class="table-scroll"><table class="media-table"><thead><tr><th><input type="checkbox" id="select-all" aria-label="Select all visible files"></th><th>NAME</th><th>TYPE</th><th>${seq ? "CONTENTS" : "FOLDER"}</th><th>LENGTH</th><th>SIZE</th><th>LOCAL CACHE</th><th>UPDATED</th><th>ACTIONS</th></tr></thead><tbody id="media-table-body">${renderMediaRows()}</tbody></table></div><div class="media-count" id="media-row-count">${filteredRows().length} ${seq ? "sequences" : "media files"}<span class="float-right">Cached files are available offline on this device.</span></div></section>`;
}
function render() {
  closeCropMenu();
  const main = $("#main-content");
  const scroll = $(".cues-scroll")?.scrollTop || 0;
  main.innerHTML =
    state.tab === "editor"
      ? renderEditor()
      : state.tab === "player"
        ? renderPlayer()
        : renderMedia();
  if ($(".cues-scroll")) $(".cues-scroll").scrollTop = scroll;
  $$(".nav-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    b.setAttribute(
      "aria-current",
      b.dataset.tab === state.tab ? "page" : "false",
    );
  });
  renderIndex = engine.index;
  applyPanelLayout();
  applyOfflineControls();
  drawWaves();
  updateEngineUI();
  updateCacheStatus();
}
async function drawWaves() {
  for (const canvas of $$("canvas[data-wave]")) {
    const m = media(canvas.dataset.wave);
    if (!m) continue;
    const p = await peaks(m).catch(() => null);
    if (!canvas.isConnected) continue;
    const load = canvas.parentElement.querySelector(".wave-loading");
    if (!p) {
      if (load)
        load.textContent = m.type.startsWith("video")
          ? "Video preview available in Player"
          : "Waveform unavailable for this format";
      continue;
    }
    load?.remove();
    drawCanvas(canvas, p, m.duration);
  }
}
function drawCanvas(canvas, p, total) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width,
    h = rect.height,
    count = Math.floor(w / 4),
    start = 0,
    end = total;
  let max = Math.max(...p, 0.01);
  ctx.fillStyle = getComputedStyle(canvas).color;
  for (let i = 0; i < count; i++) {
    const t = (start + ((end - start) * i) / count) / total,
      level = p[Math.min(p.length - 1, Math.floor(t * p.length))] || 0,
      bh = Math.max(2, (level / max) ** 1.25 * h * 0.79);
    ctx.beginPath();
    ctx.roundRect(i * 4, (h - bh) / 2, 2, bh, 1);
    ctx.fill();
  }
}
function positionVideo() {
  $$("[data-video-index]").forEach((e) =>
    e.classList.toggle("hidden", Number(e.dataset.videoIndex) !== engine.index),
  );
  const slot = $(`[data-video-index="${engine.index}"]`);
  engine.el.classList.toggle("hidden", !slot);
  if (slot) {
    const r = slot.getBoundingClientRect(),
      clip = slot.closest(".cues-scroll").getBoundingClientRect();
    Object.assign(engine.el.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      zIndex: "3",
      margin: "0",
      clipPath: `inset(${Math.max(0, clip.top - r.top)}px 0 ${Math.max(0, r.bottom - clip.bottom)}px 0)`,
    });
  }
}
function updateTime() {
  const c = engine.cue;
  if (!c) return;
  const m = media(c.mediaId),
    position = engine.loading
      ? c.start
      : Math.max(c.start, Math.min(c.end, engine.el.currentTime)),
    ratio = m ? position / m.duration : 0;
  $$("[data-track-elapsed]").forEach((e) => {
    const index = Number(e.dataset.trackElapsed),
      cue = current()?.cues[index];
    e.textContent = fmt(index === engine.index ? position : cue?.start || 0);
  });
  $$("[data-seek-index]").forEach((w) =>
    w.setAttribute(
      "aria-valuenow",
      Number(w.dataset.seekIndex) === engine.index ? position.toFixed(2) : "0",
    ),
  );
  $$("[data-playhead]").forEach((e) => {
    e.style.display =
      Number(e.dataset.playhead) === engine.index ? "block" : "none";
    e.style.left = `${ratio * 100}%`;
  });
}
function updateEngineUI() {
  $$(".cue-card").forEach((e) => {
    const active = Number(e.dataset.index) === engine.index;
    e.classList.toggle("active-cue", active);
    e.classList.toggle("playing", active && engine.playing && !engine.pausing);
    const p = e.querySelector('[data-action="play-cue"]');
    if (p) {
      p.innerHTML = icon(
        active && engine.playing && !engine.pausing ? "pause" : "play",
      );
      p.setAttribute(
        "aria-label",
        `${active && engine.playing && !engine.pausing ? "Pause" : "Play"} ${media(current()?.cues[Number(e.dataset.index)]?.mediaId)?.name || "cue"}`,
      );
    }
  });
  $$("[data-track-status]").forEach(
    (e) =>
      (e.textContent =
        Number(e.dataset.trackStatus) === engine.index
          ? engine.loading
            ? "Loading"
            : engine.pausing
              ? "Fading out"
              : engine.playing
                ? (engine.cue.loop ?? 1) !== 1
                  ? `Play ${engine.iteration}/${engine.cue.loop === "forever" ? "∞" : engine.cue.loop}`
                  : "Playing"
                : engine.finished
                  ? "Ended"
                  : "Active"
          : "Ready"),
  );
  if ($("#deck-status"))
    $("#deck-status").innerHTML =
      `<i class="status-dot"></i>${engine.loading ? "Loading" : engine.pausing ? "Fading out" : engine.playing ? "Playing" : engine.finished ? "Complete" : "Standing by"}`;
  $$("[data-master-label]").forEach(
    (e) => (e.textContent = Math.round(engine.master * 100)),
  );
  $$("[data-master]").forEach((e) => {
    if (document.activeElement !== e) e.value = engine.master * 100;
  });
  updateTime();
  positionVideo();
}
engine.addEventListener("time", updateTime);
engine.addEventListener("change", updateEngineUI);
engine.addEventListener("problem", (e) => toast(e.detail, true));
function openModal(title, body, actions = "") {
  keyCapture = null;
  $("#modal-content").innerHTML =
    `<div class="modal-header"><h2>${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div><div class="modal-body">${body}</div>${actions ? `<div class="modal-actions">${actions}</div>` : ""}`;
  if (!modal.open) modal.showModal();
}
function closeModal() {
  modal.close();
  keyCapture = null;
  modal.querySelectorAll("audio,video").forEach((e) => {
    e.pause();
    if (e.src.startsWith("blob:")) URL.revokeObjectURL(e.src);
  });
}
function keyLabel(key) {
  return esc(
    {
      " ": "Space",
      ArrowRight: "→",
      ArrowLeft: "←",
      ArrowUp: "↑",
      ArrowDown: "↓",
      Escape: "Esc",
    }[key] ||
      key?.toUpperCase() ||
      "—",
  );
}
function settings() {
  openModal(
    "Workspace settings",
    `<label class="offline-mode-option"><span><strong>Offline mode</strong><small>Edit cached sequences locally. Sync resumes when this is turned off and the server is reachable.</small></span><input type="checkbox" id="offline-mode-toggle" ${state.manualOffline ? "checked" : ""} aria-label="Offline mode"></label><p>Theme and keyboard shortcuts.</p><div class="setting-label">HIGHLIGHT COLOR</div><div class="color-options">${["#d6e5a5", "#e7c896", "#bccfe4", "#d9bfdc", "#e4b4a2", "#b4d8c8"].map((c) => `<button class="color-swatch ${state.prefs.accent === c ? "selected" : ""}" style="background:${c}" data-action="accent" data-color="${c}" aria-label="Use ${c} theme"></button>`).join("")}<input class="custom-color" type="color" id="custom-accent" value="${state.prefs.accent}" aria-label="Custom highlight color"></div><div class="setting-label">KEYBOARD SHORTCUTS</div>${[
      ["toggle", "Play / pause"],
      ["next", "Next cue"],
      ["previous", "Previous cue"],
      ["reset", "Reset current cue"],
    ]
      .map(
        ([action, label]) =>
          `<div class="shortcut-row"><span>${label}</span><button class="shortcut-key" data-action="set-key" data-key-action="${action}">${keyLabel(state.prefs.keybinds[action])}</button></div>`,
      )
      .join(
        "",
      )}<div class="settings-note">Select a key to reassign it. Shortcuts pause while you type or use a dialog.</div>`,
    `<button class="button" data-action="reset-keys">Reset shortcuts</button><button class="button button-dark" data-action="close-modal">Done ${icon("check")}</button>`,
  );
}
function cueConfig(cueId) {
  assertEditable(current());
  const seq = current(),
    index = seq.cues.findIndex((c) => c.id === cueId),
    c = seq.cues[index];
  if (!c) return;
  const next = seq.cues[index + 1],
    loop = c.loop ?? 1,
    mode = loop === "forever" ? "forever" : loop > 1 ? "count" : "off",
    on = linkedToNext(c, index);
  openModal(
    "Cue configuration",
    `<form id="cue-config-form" data-sequence-id="${esc(seq.id)}" data-cue-id="${esc(c.id)}" data-next-id="${esc(next?.id || "")}">
    <p>${esc(media(c.mediaId).name)}</p>
    <fieldset class="cue-option-group"><legend>Linkage: to next</legend><div class="cue-link-options"><label><input type="radio" name="linkNext" value="off" ${!on ? "checked" : ""}> Off</label><label><input type="radio" name="linkNext" value="on" ${on ? "checked" : ""} ${!next ? "disabled" : ""}> On</label></div><div class="settings-note">${next ? `Next: ${esc(media(next.mediaId).name)}` : "Last cue — no next track."}</div></fieldset>
    <label class="form-label">Loop<select name="loopMode" id="cue-loop-mode"><option value="off" ${mode === "off" ? "selected" : ""}>Off</option><option value="count" ${mode === "count" ? "selected" : ""}>N times</option><option value="forever" ${mode === "forever" ? "selected" : ""}>Forever</option></select></label>
    <label class="form-label ${mode === "count" ? "" : "hidden"}" id="loop-count-label">Number of plays<input type="number" name="loopCount" min="1" max="10000" step="1" value="${typeof loop === "number" && loop > 1 ? loop : 2}" ${mode !== "count" ? "disabled" : ""} required><span class="settings-note">Total plays, including the first.</span></label>
    <div class="fade-options"><label class="form-label">Fade in (seconds)<input type="number" name="fadeIn" min="0" max="3600" step=".01" value="${c.fadeIn || 0}" required></label><label class="form-label">Fade out (seconds)<input type="number" name="fadeOut" min="0" max="3600" step=".01" value="${c.fadeOut || 0}" required></label><label class="form-label">Fade out at pause (seconds)<input type="number" name="fadeOutAtPause" min="0" max="3600" step=".01" value="${c.fadeOutAtPause || 0}" required></label></div>
    <p class="settings-note">Zero disables a fade. Fade out applies only before the Out point. Fade out at pause applies only when pausing. Press Play during a pause fade to resume. Stop silences immediately and keeps the current position; Reset returns to the In point. Fade lengths are limited to available playback time.</p>
    <p class="settings-note">Loops use the In/Out range. Linked playback starts after the final play. Forever keeps this cue active until stopped or another cue is selected.</p>
    <div id="form-error" class="form-error"></div><button class="button button-dark w-full" type="submit">Save configuration ${icon("check")}</button>
  </form>`,
  );
}
function sequenceForm(s = null) {
  if (s) assertEditable(s);
  openModal(
    s ? "Edit sequence" : "New sequence",
    `<form id="sequence-form" data-id="${esc(s?.id || "")}"><label class="form-label">Sequence name<input name="name" value="${esc(s?.name || "")}" placeholder="e.g. Friday night · Main stage" required maxlength="150" autofocus></label><label class="form-label">Description<textarea name="description" placeholder="Description" maxlength="1000">${esc(s?.description || "")}</textarea></label><div class="form-error" id="form-error"></div><button class="button button-dark w-full" type="submit">${s ? "Save details" : "Create sequence"} ${icon("arrow-right")}</button></form>`,
  );
}
let localSaves = new Map(),
  syncTimer = null,
  syncPromise = null;
function canEdit(seq) {
  return (
    Boolean(seq) &&
    (!isOffline() ||
      state.cached.has(`sequence:${seq.id}`) ||
      state.pending.some(
        (e) =>
          e.kind === "sequence" && e.id === seq.id && e.operation !== "delete",
      ))
  );
}
function assertEditable(seq) {
  if (!canEdit(seq))
    throw new Error("Cache this sequence before editing it offline.");
}
function applyOfflineControls() {
  if (!isOffline()) return;
  const editable = canEdit(current());
  $$(
    '.cue-card input,.cue-card select,.cue-card [data-action="cue-config"],.cue-card [data-action="edit-setting-value"],.cue-card [data-action="cue-duplicate"],.cue-card [data-action="cue-remove"],[data-action="edit-sequence"],.add-cue-area',
  ).forEach((el) => (el.disabled = !editable));
  if (!editable) $$(".cue-card-top").forEach((el) => (el.draggable = false));
  $$('[data-action="add-media"]').forEach(
    (el) => (el.disabled = !editable || !isCached("media", el.dataset.id)),
  );
}
function setSaveStatus(label) {
  $("#save-status").innerHTML = `<i></i>${esc(label)}`;
}
function updateSyncStatus() {
  const issues = state.pending.filter((e) => e.error).length,
    n = state.pending.length;
  setSaveStatus(
    localSaves.size
      ? "Saving locally…"
      : state.authExpired
        ? "Sign in to sync"
        : state.syncing
          ? "Syncing…"
          : issues
            ? `${issues} sync ${issues === 1 ? "issue" : "issues"}`
            : n
              ? isOffline()
                ? `Saved locally · ${n} pending`
                : `${n} pending sync`
              : "All changes saved",
  );
  $("#save-status").title = n
    ? "Changes are safe on this device. Click for sync details."
    : "Click to save the active sequence";
}
async function refreshPending() {
  state.pending = state.user ? await queuedChanges(state.user.username) : [];
  updateSyncStatus();
}
function requestSync() {
  clearTimeout(syncTimer);
  if (!isOffline() && state.user && !state.authExpired)
    syncTimer = setTimeout(() => syncPending(), 500);
}
async function stageSequence(seq, operation = "put") {
  if (operation !== "create") assertEditable(seq);
  normalizeLinks(seq);
  const snapshot = structuredClone(seq),
    owner = state.user?.username;
  const previous = localSaves.get(seq.id) || Promise.resolve();
  const job = previous
    .catch(() => {})
    .then(async () => {
      await queueChange(owner, "sequence", seq.id, operation, snapshot);
      if (
        state.cached.has(`sequence:${seq.id}`) ||
        (operation === "create" && isOffline())
      ) {
        await cacheSet(
          "assets",
          `sequence:${seq.id}`,
          new Blob([m3uText(snapshot)], { type: "audio/x-mpegurl" }),
        );
        state.cached.add(`sequence:${seq.id}`);
      }
      await persistWorkspace();
      await refreshPending();
    })
    .finally(() => {
      if (localSaves.get(seq.id) === job) localSaves.delete(seq.id);
      updateSyncStatus();
    });
  localSaves.set(seq.id, job);
  updateSyncStatus();
  return job;
}
function scheduleSave(seq) {
  stageSequence(seq)
    .then(requestSync)
    .catch((error) => toast(error.message, true));
}
async function saveSequence(seq) {
  await stageSequence(seq);
  if (!isOffline()) await syncPending();
  const issue = state.pending.find(
    (e) => e.kind === "sequence" && e.id === seq.id && e.error,
  );
  if (issue && !isOffline())
    throw Object.assign(new Error(issue.error.message), {
      status: issue.error.status,
    });
  return seq;
}
async function flushSaves() {
  await Promise.all([...localSaves.values()]);
  if (!isOffline()) await syncPending();
}
async function createSequence(values) {
  const seq = {
    ...values,
    id: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  state.sequences.push(seq);
  await stageSequence(seq, "create");
  if (!isOffline()) await syncPending();
  return seq;
}
async function syncPending() {
  if (isOffline() || !state.user || state.authExpired) return;
  if (syncPromise) return syncPromise;
  const owner = state.user.username;
  const work = async () => {
    if (state.verifiedUser !== owner) {
      try {
        const user = await api("/api/session", { silentAuth: true });
        if (user.username !== owner) {
          state.authExpired = true;
          return;
        }
        state.verifiedUser = owner;
      } catch (error) {
        if (error.status === 401) state.authExpired = true;
        return;
      }
    }
    state.syncing = true;
    updateSyncStatus();
    try {
      while (!isOffline() && !state.authExpired) {
        const entry = (await queuedChanges(owner)).find((e) => !e.error);
        if (!entry) break;
        try {
          let saved;
          if (entry.kind === "sequence") {
            saved =
              entry.operation === "delete"
                ? await api(`/api/sequences/${entry.id}`, {
                    method: "DELETE",
                    silentAuth: true,
                  })
                : entry.operation === "create"
                  ? await api("/api/sequences", {
                      method: "POST",
                      body: { ...entry.data, clientId: entry.id },
                      silentAuth: true,
                    })
                  : await api(`/api/sequences/${entry.id}`, {
                      method: "PUT",
                      body: entry.data,
                      silentAuth: true,
                    });
          } else if (entry.kind === "media")
            saved = await api(`/api/media/${entry.id}`, {
              method: "PATCH",
              body: entry.data,
              silentAuth: true,
            });
          else
            saved = await api("/api/preferences", {
              method: "PUT",
              body: entry.data,
              silentAuth: true,
            });
          const newer = await acknowledge(entry);
          if (entry.kind === "media") {
            const m = media(entry.id);
            if (m) {
              if (!newer) Object.assign(m, saved);
              await refreshMediaReferences(m);
            }
          }
          if (entry.kind === "sequence" && entry.operation !== "delete") {
            const seq = state.sequences.find((s) => s.id === entry.id);
            if (seq) seq.updatedAt = saved.updatedAt;
            if (!newer && state.cached.has(`sequence:${entry.id}`))
              await cacheSet(
                "assets",
                `sequence:${entry.id}`,
                new Blob([m3uText(saved)], { type: "audio/x-mpegurl" }),
              );
          }
        } catch (error) {
          if (error.offline || isOffline()) break;
          if (error.status === 401 || error.status === 403) {
            state.authExpired = true;
            break;
          }
          await blockChange(entry, error);
        }
        await refreshPending();
      }
    } finally {
      state.syncing = false;
      await refreshPending();
      await persistWorkspace();
      updateSyncStatus();
    }
  };
  syncPromise = (
    navigator.locks
      ? navigator.locks.request(`simplecue-sync:${owner}`, work)
      : work()
  )
    .catch((error) => {
      if (!error.offline)
        console.error("SimpleCue sync paused:", error.message);
    })
    .finally(() => {
      syncPromise = null;
      updateSyncStatus();
    });
  return syncPromise;
}
async function refreshMediaReferences(m) {
  for (const seq of state.sequences) {
    let used = false;
    for (const cue of seq.cues)
      if (cue.mediaId === m.id) {
        cue.name = m.name;
        used = true;
      }
    if (used && state.cached.has(`sequence:${seq.id}`))
      await cacheSet(
        "assets",
        `sequence:${seq.id}`,
        new Blob([m3uText(seq)], { type: "audio/x-mpegurl" }),
      );
  }
}
function syncDetails() {
  openModal(
    "Sync status",
    `<p>${state.manualOffline ? "Offline mode is enabled." : isOffline() ? "Offline. Changes stay on this device." : "Online. Changes sync to the server."}</p>${state.pending.map((entry) => `<div class="sync-entry"><strong>${esc(entry.data?.name || entry.kind)}</strong><span>${esc(entry.error?.message || "Saved locally · waiting to sync")}</span></div>`).join("") || "<p>No pending changes.</p>"}`,
    `<button class="button" data-action="settings">Settings</button>${state.authExpired ? '<button class="button button-dark" data-action="sync-sign-in">Sign in to sync</button>' : '<button class="button button-dark" data-action="sync-now">Sync now</button>'}`,
  );
}
let manualSavePromise = null;
async function saveWorkspaceNow() {
  const form = modal.open ? modal.querySelector("form") : null;
  if (form) {
    form.dataset.manualSave = "true";
    form.requestSubmit();
    return;
  }
  const active = document.activeElement;
  if (active?.matches(".media-name-input")) {
    const saved = await active.commitRename();
    if (saved)
      toast(
        isOffline()
          ? "File name saved on this device. It will sync when online."
          : "File name saved.",
      );
    return;
  } else if (active?.matches(".time-input")) {
    const cue = current()?.cues[Number(active.dataset.index)];
    cropValue(cue, active.dataset.cueSetting, parseCropTime(active.value));
    // Blur commits through the normal change handler before rendering replaces the focused input.
    active.blur();
  } else if (active?.matches(".value-editor")) {
    const value = Number(active.value);
    if (
      active.value === "" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number(active.max)
    )
      throw new Error(`Enter a value from 0 to ${active.max}.`);
    active.blur();
  }
  if (manualSavePromise) return manualSavePromise;
  const seq = current();
  if (!seq) throw new Error("No active sequence to save.");
  const cached = state.cached.has(`sequence:${seq.id}`);
  manualSavePromise = (async () => {
    await saveSequence(seq);
    await flushSaves();
    toast(
      isOffline()
        ? "Saved on this device. Changes will sync when online."
        : cached
          ? "Saved to server and refreshed local cache."
          : "Saved to server.",
    );
  })().finally(() => (manualSavePromise = null));
  return manualSavePromise;
}
function m3uText(s) {
  return (
    "#EXTM3U\n#PLAYLIST:" +
    s.name +
    "\n#SIMPLECUE:" +
    JSON.stringify({ ...s, cues: undefined }) +
    "\n" +
    s.cues
      .map((c) => {
        const m = media(c.mediaId);
        return `#EXTINF:${m.duration},${m.name}\n#CUE:${JSON.stringify(c)}\n${m.filename}`;
      })
      .join("\n") +
    "\n"
  );
}
async function cacheItem(type, id, remove = false, quiet = false) {
  const key = `${type}:${id}`;
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    if (type === "media") {
      if (remove) await cacheDelete("assets", key);
      else {
        const m = media(id);
        if (!m) throw new Error("Media not found.");
        const blob = await mediaBlob(m);
        await cacheSet("assets", key, blob);
      }
    } else {
      const s = state.sequences.find((s) => s.id === id);
      if (!s) throw new Error("Sequence not found.");
      if (remove) {
        await cacheDelete("assets", key);
        const protectedIds = new Set(
          state.sequences
            .filter((v) => v.id !== id && state.cached.has(`sequence:${v.id}`))
            .flatMap((v) => v.cues.map((c) => c.mediaId)),
        );
        for (const c of s.cues)
          if (!protectedIds.has(c.mediaId))
            await cacheDelete("assets", `media:${c.mediaId}`);
      } else {
        for (const mediaId of new Set(s.cues.map((c) => c.mediaId))) {
          const m = media(mediaId);
          await cacheSet("assets", `media:${mediaId}`, await mediaBlob(m));
        }
        await cacheSet(
          "assets",
          key,
          new Blob([m3uText(s)], { type: "audio/x-mpegurl" }),
        );
      }
    }
    await refreshCache();
    if (!quiet)
      toast(
        remove
          ? "Removed from this device’s cache."
          : "Cached on this device. Available offline.",
      );
  } finally {
    state.busy.delete(key);
    render();
  }
}
async function selectSequence(id) {
  await flushSaves();
  engine.halt(true);
  state.activeId = id;
  state.selected.clear();
  await prefs();
  await engine.select(0);
  render();
}
async function addMedia(id, at = null) {
  assertEditable(current());
  if (isOffline() && !isCached("media", id))
    throw new Error("Only cached media can be added while offline.");
  const s = current(),
    m = media(id);
  if (!s) throw new Error("Create a sequence first.");
  const cue = {
    id: crypto.randomUUID(),
    mediaId: id,
    name: m.name,
    volume: 100,
    speed: 1,
    start: 0,
    end: m.duration,
    follow: false,
  };
  if (at === null) s.cues.push(cue);
  else {
    s.cues.splice(at, 0, cue);
    if (at <= engine.index) engine.index++;
  }
  await saveSequence(s);
  if (s.cues.length === 1) await engine.select(0);
  render();
  toast(`${m.name} added to the sequence.`);
}
function addPicker() {
  openModal(
    "Add cue",
    `<p>Select media for ${esc(current()?.name || "your sequence")}.</p>${state.media.map((m) => `<button class="add-picker" data-action="pick-media" data-id="${esc(m.id)}">${icon(m.type.startsWith("video") ? "video" : "audio")}<div class="tile-info"><div class="tile-title">${esc(m.name)}</div><div class="tile-meta">${esc(m.folder)} · ${esc(m.extension)} · ${fmt(m.duration)}</div></div>${icon("plus")}</button>`).join("") || "<p>No media files.</p>"}`,
  );
}
function confirmDialog(title, message, action, id) {
  openModal(
    title,
    `<p>${esc(message)}</p>`,
    `<button class="button" data-action="close-modal">Cancel</button><button class="button button-dark" data-action="${action}" data-id="${esc(id)}">Delete ${icon("trash")}</button>`,
  );
}
function duplicateCues(cues) {
  const ids = new Map(cues.map((c) => [c.id, crypto.randomUUID()]));
  return cues.map((c) => ({
    ...c,
    id: ids.get(c.id),
    followFrom: c.followFrom ? ids.get(c.followFrom) : null,
  }));
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function uploadDialog() {
  if (isOffline()) throw new Error("Connect to the server to upload media.");
  openModal(
    "Upload media",
    `<p>Upload audio or video files.</p><label class="form-label">Save to folder<input id="upload-folder" value="Uploads" list="folder-options" maxlength="150"><datalist id="folder-options">${[...new Set(state.media.map((m) => m.folder))].map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label><button class="button button-dark w-full" data-action="choose-files">${icon("upload")} Choose audio or video files</button><p class="settings-note mt-4">WAV, MP3, OGG, M4A, AAC, FLAC, AIFF, MP4, WEBM, MOV.<br>${state.uploads === "disk" ? "Up to 500 MB per file. Transfers use 2 MB chunks." : "Up to 500 MB per file via Upstash Blob."}</p>`,
  );
}
async function probe(file) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(
        file.type.startsWith("video") ? "video" : "audio",
      ),
      url = URL.createObjectURL(file);
    el.preload = "metadata";
    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Could not read ${file.name}. Try another media format.`),
      );
    }, 15000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      const n = el.duration;
      cleanup();
      Number.isFinite(n) && n > 0
        ? resolve(n)
        : reject(new Error("The file has no readable duration."));
    };
    el.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`This browser cannot read ${file.name}.`));
    };
    el.src = url;
  });
}
function mimeFor(filename) {
  return (
    {
      flac: "audio/flac",
      wav: "audio/wav",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      aiff: "audio/aiff",
      aif: "audio/aiff",
      aac: "audio/aac",
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
    }[filename.split(".").pop().toLowerCase()] || "application/octet-stream"
  );
}
async function uploadLocal(file, metadata) {
  if (file.size > 500 * 1024 * 1024)
    throw new Error("Media files must be smaller than 500 MB.");
  const session = await api("/api/uploads", {
    method: "POST",
    body: {
      ...metadata,
      size: file.size,
      type: file.type || mimeFor(file.name),
    },
  });
  try {
    for (let offset = 0; offset < file.size;) {
      const body = file.slice(
        offset,
        Math.min(file.size, offset + session.chunkSize),
      );
      let data;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(
            `/api/uploads/${session.id}/chunks?offset=${offset}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body,
            },
          );
          data = await readResponse(r, "/api/uploads");
          break;
        } catch (e) {
          if (attempt === 2) throw e;
        }
      }
      if (!data || data.received <= offset)
        throw new Error("Upload did not advance. Retry the file.");
      offset = data.received;
      setSaveStatus(`Uploading ${Math.round((offset / file.size) * 100)}%`);
    }
    return await api(`/api/uploads/${session.id}/complete`, { method: "POST" });
  } catch (e) {
    api(`/api/uploads/${session.id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}
async function uploadFiles(files) {
  if (isOffline()) throw new Error("Connect to the server to upload media.");
  if (!files.length) return;
  if (
    state.uploads === "unconfigured" &&
    files.some((f) => !/\.m3u8?$/i.test(f.name))
  )
    throw new Error(
      "Set UPSTASH_BLOB_TOKEN on the server to enable Upstash Blob uploads.",
    );
  closeModal();
  let count = 0;
  for (const file of files) {
    try {
      toast(`Uploading ${file.name}…`);
      if (/\.m3u8?$/i.test(file.name)) {
        const fd = new FormData();
        fd.append("file", file);
        const s = await api("/api/sequences/import", {
          method: "POST",
          body: fd,
        });
        state.sequences.push(s);
        if (!state.activeId) state.activeId = s.id;
      } else {
        const duration = await probe(file),
          name = file.name.replace(/\.[^.]+$/, ""),
          metadata = {
            name,
            filename: file.name,
            folder: uploadFolder,
            duration,
          };
        let m;
        if (state.uploads === "disk") {
          m = await uploadLocal(file, metadata);
        } else {
          if (state.uploads !== "upstash")
            throw new Error(
              "Set UPSTASH_BLOB_TOKEN to enable Upstash Blob uploads.",
            );
          const { upload } = await import("./upstash-upload.js");
          const uploadFile = new File([file], file.name, {
            type: mimeFor(file.name),
          });
          const task = upload(uploadFile, {
            route: "/api/uploads/blob",
            input: metadata,
          });
          const unsubscribe = task.subscribe(() =>
            setSaveStatus(`Uploading ${task.snapshot().percent}%`),
          );
          try {
            const result = await task.done;
            m =
              result.data?.media ||
              (await api("/api/media/upstash-complete", {
                method: "POST",
                body: { path: result.path },
              }));
          } finally {
            unsubscribe();
          }
        }
        if (!state.media.some((v) => v.id === m.id)) state.media.push(m);
      }
      count++;
    } catch (e) {
      toast(e.message, true);
    }
  }
  setSaveStatus("All changes saved");
  await persistWorkspace();
  render();
  if (count) toast(`${count} ${count === 1 ? "file" : "files"} added. `);
  $("#upload-input").value = "";
}
let outputPermissionAsked = false;
async function requestOutputAccess() {
  if (outputPermissionAsked) return;
  outputPermissionAsked = true;
  if (!navigator.mediaDevices) {
    toast(
      "Audio device detection needs HTTPS or localhost. Use your system sound settings.",
      true,
    );
    return;
  }
  try {
    if (navigator.mediaDevices.selectAudioOutput) {
      const device = await navigator.mediaDevices.selectAudioOutput();
      if (engine.el.setSinkId) await engine.setDevice(device.deviceId);
      state.deviceLabel = device.label || "Selected output";
    } else if (!state.devices.some((d) => d.label)) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    await detectOutputs();
  } catch (e) {
    if ($("#output-permission-note"))
      $("#output-permission-note").textContent =
        e.name === "NotAllowedError"
          ? "Device permission denied"
          : "Device names unavailable";
    if (!["NotAllowedError", "AbortError"].includes(e.name))
      toast("Device access: " + e.message, true);
  }
}
function deviceOptions() {
  const devices = state.devices;
  return (
    `<option value="">System default</option>` +
    devices
      .filter((d) => d.deviceId !== "default")
      .map(
        (d, i) =>
          `<option value="${esc(d.deviceId)}" ${d.deviceId === engine.sinkId ? "selected" : ""}>${esc(d.label || `Output ${i + 1} (name unavailable)`)}</option>`,
      )
      .join("")
  );
}
async function detectOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    state.devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audiooutput",
    );
    const selected =
      state.devices.find((d) => d.deviceId === (engine.sinkId || "default")) ||
      (!engine.sinkId ? state.devices[0] : null);
    state.deviceLabel =
      selected?.label ||
      (!engine.sinkId ? "System default" : "Selected audio output");
    if ($("#output-device-name")) {
      $("#output-device-name").textContent = state.deviceLabel;
      $("#output-device-name").title = state.deviceLabel;
    }
    if ($("#output-device-select")) {
      $("#output-device-select").innerHTML = deviceOptions();
      $("#output-device-select").value = engine.sinkId;
    }
  } catch (e) {
    toast("Audio devices could not be enumerated: " + e.message, true);
  }
}
async function outputDevices() {
  if (!engine.el.setSinkId || !navigator.mediaDevices) {
    openModal(
      "Audio output",
      `<p>This browser uses your system’s selected audio output. Connect a Bluetooth device and select it in your system sound settings.</p>`,
    );
    return;
  }
  if (navigator.mediaDevices.selectAudioOutput) {
    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      await engine.setDevice(device.deviceId);
      state.deviceLabel = device.label || "Selected output";
      render();
      return;
    } catch (e) {
      if (e.name === "NotAllowedError") return;
    }
  }
  await detectOutputs();
  const devices = state.devices;
  openModal(
    "Audio output",
    `<p>Select a connected output. If names are hidden, allow device access below or use your system sound settings.</p><label class="form-label">Output device<select id="device-select"><option value="">System default</option>${devices.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === engine.sinkId ? "selected" : ""}>${esc(d.label || "Audio output")}</option>`).join("")}</select></label>`,
    `<button class="button" data-action="reveal-devices">Allow device names</button><button class="button button-dark" data-action="apply-device">Use this output</button>`,
  );
}
const actions = {
  "close-modal": () => closeModal(),
  "rename-media": (button) => {
    const m = media(button.dataset.id),
      input = document.createElement("input");
    input.className = "media-name-input";
    input.value = m.filename;
    input.setAttribute("aria-label", `File name for ${m.id}`);
    input.maxLength = 180;
    let done = false,
      cancelled = false,
      job;
    const commit = () => {
      if (done) return job;
      done = true;
      job = Promise.resolve().then(async () => {
        try {
          if (!cancelled && input.value !== m.filename) {
            const values = renameMediaFile(m, input.value);
            await queueChange(
              state.user.username,
              "media",
              m.id,
              "put",
              values,
            );
            Object.assign(m, values);
            await refreshPending();
            await refreshMediaReferences(m);
            await persistWorkspace();
            if (!isOffline()) await syncPending();
            const issue = state.pending.find(
              (e) => e.kind === "media" && e.id === m.id && e.error,
            );
            if (issue) throw new Error(issue.error.message);
          }
          return !cancelled;
        } catch (error) {
          toast(error.message, true);
          return false;
        } finally {
          localSaves.delete(`media:${m.id}`);
          updateSyncStatus();
          render();
        }
      });
      localSaves.set(`media:${m.id}`, job);
      updateSyncStatus();
      return job;
    };
    input.commitRename = commit;
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelled = true;
        input.blur();
      }
    });
    button.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, m.filename.length - m.extension.length - 1);
  },
  "sync-details": () =>
    state.pending.length || state.authExpired
      ? syncDetails()
      : saveWorkspaceNow(),
  "sync-now": async () => {
    if (state.manualOffline) {
      toast("Turn off Offline mode in settings to sync.");
      return;
    }
    await retryChanges(state.user.username);
    state.authExpired = false;
    endpointMissing = false;
    await probeConnection();
    if (modal.open) syncDetails();
  },
  "sync-sign-in": () => {
    closeModal();
    showLogin();
  },
  "go-online": () => setOfflineMode(false),
  "network-status": async () => {
    if (state.manualOffline) settings();
    else {
      endpointMissing = false;
      await probeConnection();
    }
  },
  "cue-config": (b) => cueConfig(b.dataset.cueId),
  settings,
  shortcuts: settings,
  "toggle-theme": () => {
    setTheme(state.prefs.mode === "dark" ? "light" : "dark");
    prefs();
  },
  "edit-setting-value": (b) => {
    assertEditable(current());
    const index = Number(b.dataset.index),
      setting = b.dataset.setting,
      c = current().cues[index],
      original = setting === "speed" ? Math.round(c.speed * 100) : c.volume;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "200";
    input.step = "1";
    input.value = original;
    input.className = "value-editor";
    input.setAttribute(
      "aria-label",
      `${setting === "volume" ? "gain" : setting} percentage for cue ${index + 1}`,
    );
    let canceled = false,
      committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const n = Number(input.value);
      if (!canceled) {
        if (
          input.value === "" ||
          !Number.isFinite(n) ||
          n < 0 ||
          n > Number(input.max)
        ) {
          toast(`Enter a value from 0 to ${input.max}.`, true);
        } else {
          c[setting] = setting === "speed" ? n / 100 : n;
          if (index === engine.index) engine.apply();
          scheduleSave(current());
        }
      }
      render();
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        canceled = true;
        input.blur();
      }
    });
    b.replaceWith(input);
    input.focus();
    input.select();
  },
  account: () =>
    openModal(
      "Account",
      `<p>Signed in as <strong>${esc(state.user?.name || "Admin")}</strong> (${esc(state.user?.username || "admin")}).<br>Account credentials are managed in the backend’s config/users.json file.</p>`,
      `<button class="button" data-action="close-modal">Close</button><button class="button button-dark" data-action="logout">${icon("logout")} Sign out</button>`,
    ),
  logout: async () => {
    await flushSaves();
    await api("/api/logout", { method: "POST" });
    engine.halt(true);
    await cacheDelete("meta", "workspace");
    closeModal();
    showLogin();
  },
  "new-sequence": () => sequenceForm(),
  "edit-sequence": () => sequenceForm(current()),
  "edit-row-sequence": (b) =>
    sequenceForm(state.sequences.find((s) => s.id === b.dataset.id)),
  "select-sequence": (b) => selectSequence(b.dataset.id),
  "open-sequence": async (b) => {
    await selectSequence(b.dataset.id);
    state.tab = "editor";
    render();
  },
  folder: (b) => {
    state.collapsed.has(b.dataset.folder)
      ? state.collapsed.delete(b.dataset.folder)
      : state.collapsed.add(b.dataset.folder);
    $("#library-files").innerHTML = renderLibraryFiles();
  },
  cache: (b) =>
    cacheItem(
      b.dataset.type,
      b.dataset.id,
      isCached(b.dataset.type, b.dataset.id),
    ),
  "cache-sequence": () => cacheItem("sequence", current().id),
  "mass-cache": () => massCache(false),
  "mass-uncache": () => massCache(true),
  "add-media": (b) => addMedia(b.dataset.id),
  "add-picker": addPicker,
  "pick-media": async (b) => {
    closeModal();
    await addMedia(b.dataset.id);
  },
  "play-cue": async (b) => {
    const i = Number(b.dataset.index);
    if (engine.index === i && !engine.loading) await engine.toggle();
    else await engine.select(i, true);
  },
  "reset-cue": async (b) => {
    const i = Number(b.dataset.index);
    if (engine.index !== i) await engine.select(i);
    engine.reset();
  },
  "stop-cue": async (b) => {
    const i = Number(b.dataset.index);
    if (engine.index !== i) await engine.select(i);
    await engine.stop();
  },
  "select-cue": (b) => engine.select(Number(b.dataset.index)),
  toggle: () => engine.toggle(),
  next: () => engine.step(1),
  previous: () => engine.step(-1),
  reset: () => engine.reset(),
  stop: () => engine.stop(),
  mute: () => {
    engine.muted = !engine.muted;
    engine.apply();
    render();
  },
  accent: (b) => {
    setAccent(b.dataset.color);
    prefs();
    settings();
    drawWaves();
  },
  "set-key": (b) => {
    keyCapture = b.dataset.keyAction;
    $$(".shortcut-key").forEach((e) => e.classList.remove("listening"));
    b.textContent = "Press a key…";
    b.classList.add("listening");
  },
  "reset-keys": () => {
    state.prefs.keybinds = { ...defaults };
    prefs();
    settings();
  },
  upload: uploadDialog,
  "choose-files": () => {
    uploadFolder = $("#upload-folder").value.trim() || "Uploads";
    $("#upload-input").accept =
      "audio/*,video/*,.wav,.mp3,.ogg,.m4a,.flac,.aif,.aiff,.aac,.mp4,.webm,.mov";
    $("#upload-input").click();
  },
  import: () => {
    $("#upload-input").accept = ".m3u,.m3u8";
    $("#upload-input").click();
  },
  "sequence-menu": () => {
    const s = current();
    openModal(
      "Sequence options",
      `<p>${esc(s.name)} · ${s.cues.length} cues · ${fmt(duration(s))}</p><div class="grid gap-2"><button class="button justify-start" data-action="download-sequence" data-id="${s.id}">${icon("download")} Download M3U</button><button class="button justify-start" data-action="duplicate-sequence" data-id="${s.id}">${icon("copy")} Duplicate sequence</button><button class="button justify-start danger-button" data-action="delete-sequence" data-id="${s.id}">${icon("trash")} Delete sequence</button></div>`,
    );
  },
  "duplicate-sequence": async (b) => {
    const s = state.sequences.find((v) => v.id === b.dataset.id),
      copy = await createSequence({
        ...s,
        name: `${s.name} (copy)`,
        cues: duplicateCues(s.cues),
      });
    closeModal();
    await selectSequence(copy.id);
    toast("Sequence duplicated.");
  },
  "download-sequence": async (b) => {
    const s = state.sequences.find((v) => v.id === b.dataset.id);
    await flushSaves();
    download(
      new Blob([m3uText(s)], { type: "audio/x-mpegurl" }),
      s.name + ".m3u",
    );
  },
  "download-media": async (b) => {
    const m = media(b.dataset.id);
    download(await mediaBlob(m), m.filename);
  },
  "delete-sequence": (b) => {
    const s = state.sequences.find((v) => v.id === b.dataset.id);
    confirmDialog(
      "Delete sequence?",
      `“${s.name}” will be removed from the server. Its media files will stay in your library.`,
      "confirm-delete-sequence",
      s.id,
    );
  },
  "confirm-delete-sequence": async (b) => {
    const id = b.dataset.id;
    await flushSaves();
    const removed = state.sequences.find((s) => s.id === id);
    assertEditable(removed);
    await queueChange(state.user.username, "sequence", id, "delete", removed);
    await refreshPending();
    if (current()?.id === id) engine.halt(true);
    state.sequences = state.sequences.filter((s) => s.id !== id);
    if (state.activeId === id) {
      state.activeId = state.sequences[0]?.id;
      await engine.select(0);
    }
    await cacheDelete("assets", `sequence:${id}`);
    await persistWorkspace();
    await refreshCache();
    state.selected.delete(id);
    closeModal();
    render();
    if (!isOffline()) await syncPending();
    toast(
      isOffline()
        ? "Sequence removed locally. Server deletion is queued."
        : "Sequence removed.",
    );
  },
  "cue-duplicate": async (b) => {
    assertEditable(current());
    const s = current(),
      i = Number(b.dataset.index),
      activeId = engine.cue?.id;
    s.cues.splice(i + 1, 0, {
      ...s.cues[i],
      id: crypto.randomUUID(),
      follow: false,
      followFrom: null,
    });
    if (activeId)
      engine.index = Math.max(
        0,
        s.cues.findIndex((c) => c.id === activeId),
      );
    await saveSequence(s);
    closeModal();
    render();
  },
  "cue-remove": async (b) => {
    assertEditable(current());
    const s = current(),
      i = Number(b.dataset.index),
      activeId = engine.cue?.id;
    engine.halt(true);
    s.cues.splice(i, 1);
    await saveSequence(s);
    await engine.select(
      Math.max(
        0,
        s.cues.findIndex((c) => c.id === activeId),
      ),
    );
    closeModal();
    render();
  },
  "preview-media": async (b) => {
    const m = media(b.dataset.id),
      blob = await mediaBlob(m),
      url = URL.createObjectURL(blob);
    engine.el.pause();
    openModal(
      esc(m.name),
      `<${m.type.startsWith("video") ? "video" : "audio"} class="media-preview" controls src="${url}"></${m.type.startsWith("video") ? "video" : "audio"}><p>${esc(m.filename)}<br>${esc(m.extension)} · ${fmt(m.duration)} · ${bytes(m.size)}<br>${esc(m.folder)}${m.description ? "<br>" + esc(m.description) : ""}${m.demo ? "<br>Original synthesized sample audio." : ""}</p>`,
    );
  },
  "edit-media": (b) => {
    const m = media(b.dataset.id);
    openModal(
      "Edit media",
      `<form id="media-edit-form" data-id="${m.id}"><label class="form-label">Display name<input name="name" value="${esc(m.name)}" required maxlength="150"></label><label class="form-label">Folder<input name="folder" value="${esc(m.folder)}" required maxlength="150"></label><label class="form-label">Description<textarea name="description" maxlength="1000">${esc(m.description || "")}</textarea></label><div id="form-error" class="form-error"></div><button class="button button-dark w-full">Save details ${icon("check")}</button></form>`,
    );
  },
  "delete-media": (b) => {
    const m = media(b.dataset.id);
    confirmDialog(
      "Delete media?",
      `“${m.name}” will be deleted from the server and this device. Media used in a sequence must be removed from that sequence first.`,
      "confirm-delete-media",
      m.id,
    );
  },
  "confirm-delete-media": async (b) => {
    if (isOffline())
      throw new Error("Connect to the server to delete media files.");
    const id = b.dataset.id;
    await api(`/api/media/${id}`, { method: "DELETE" });
    state.media = state.media.filter((m) => m.id !== id);
    await cacheDelete("assets", `media:${id}`);
    await cacheDelete("waves", id);
    state.selected.delete(id);
    await persistWorkspace();
    await refreshCache();
    closeModal();
    render();
    toast("Media removed.");
  },
  "reveal-devices": async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await detectOutputs();
    await outputDevices();
  },
  "output-device": outputDevices,
  "apply-device": async () => {
    const id = $("#device-select").value;
    await engine.setDevice(id);
    state.deviceLabel =
      state.devices.find((d) => d.deviceId === id)?.label || "System default";
    closeModal();
    render();
  },
  "retry-save": () => saveWorkspaceNow(),
};
async function massCache(remove) {
  const type = state.view === "media" ? "media" : "sequence",
    rows = filteredRows().filter(
      (r) => !state.selected.size || state.selected.has(r.id),
    );
  if (!rows.length) return;
  let count = 0;
  for (const r of rows) {
    try {
      await cacheItem(type, r.id, remove, true);
      count++;
    } catch (e) {
      toast(e.message, true);
      break;
    }
  }
  toast(
    `${count} ${type === "media" ? "files" : "sequences"} ${remove ? "removed from local cache" : "cached for offline use"}.`,
  );
}
async function reorder(from, to) {
  assertEditable(current());
  const s = current();
  if (from === to || to < 0 || to >= s.cues.length) return;
  const active = engine.cue?.id,
    wasPlaying = engine.playing;
  engine.el.pause();
  const [cue] = s.cues.splice(from, 1);
  s.cues.splice(to, 0, cue);
  await saveSequence(s);
  await engine.select(
    s.cues.findIndex((c) => c.id === active),
    wasPlaying,
  );
  closeModal();
  render();
}
document.addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    render();
    if (state.tab === "player") await requestOutputAccess();
    return;
  }
  const card = e.target.closest(".cue-card");
  if (
    card &&
    !e.target.closest("button,input,select,textarea,label,a,[data-seek-index]")
  ) {
    const index = Number(card.dataset.index);
    if (index !== engine.index) await engine.select(index);
    return;
  }
  const b = e.target.closest("[data-action]");
  if (b && actions[b.dataset.action]) {
    e.preventDefault();
    try {
      await actions[b.dataset.action](b);
    } catch (err) {
      toast(err.message, true);
    }
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!e.repeat) {
      closeCropMenu();
      saveWorkspaceNow().catch((error) => toast(error.message, true));
    }
    return;
  }
  if (cropMenu) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCropMenu(true);
    } else if (e.key === "Tab") {
      closeCropMenu(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const items = [...cropMenu.querySelectorAll("button:not(:disabled)")];
      if (items.length) {
        const index = items.indexOf(document.activeElement),
          next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? items.length - 1
                : (index + (e.key === "ArrowUp" ? -1 : 1) + items.length) %
                  items.length;
        items[next].focus();
      }
    }
    return;
  }
  if (e.target.matches(".time-input") && ["Enter", "Escape"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "Escape") {
      const cue = current()?.cues[Number(e.target.dataset.index)];
      if (cue)
        e.target.value = formatCropTime(cue[e.target.dataset.cueSetting]);
    }
    e.target.blur();
    return;
  }
  if (keyCapture) {
    e.preventDefault();
    if (e.key === "Escape") {
      keyCapture = null;
      settings();
      return;
    }
    if (["Control", "Shift", "Alt", "Meta", "Tab"].includes(e.key)) return;
    if (
      Object.entries(state.prefs.keybinds).some(
        ([a, k]) => a !== keyCapture && k === e.key,
      )
    ) {
      toast("That key is already assigned to another action.", true);
      return;
    }
    state.prefs.keybinds[keyCapture] = e.key;
    keyCapture = null;
    prefs();
    settings();
    return;
  }
  if (e.key === "Enter" && e.target.matches('[role="button"][data-action]')) {
    e.preventDefault();
    e.target.click();
    return;
  }
  if (
    modal.open ||
    ($("#login-screen") && !$("#login-screen").classList.contains("hidden")) ||
    e.target.matches(
      'input,textarea,select,[contenteditable="true"],[role="separator"],[data-seek-index]',
    ) ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.repeat
  )
    return;
  const match = Object.entries(state.prefs.keybinds).find(
    ([, key]) => e.key.toLowerCase() === key.toLowerCase(),
  );
  if (match) {
    e.preventDefault();
    ({
      toggle: () => engine.toggle(),
      next: () => engine.step(1),
      previous: () => engine.step(-1),
      reset: () => engine.reset(),
    })[match[0]]();
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "library-search") {
    state.libraryQuery = el.value;
    $("#library-files").innerHTML = renderLibraryFiles();
  }
  if (el.id === "media-search") {
    state.mediaQuery = el.value;
    $("#media-table-body").innerHTML = renderMediaRows();
    $("#media-row-count").textContent =
      `${filteredRows().length} ${state.view === "media" ? "media files" : "sequences"}`;
    updateSelection();
  }
  if (el.id === "custom-accent") {
    setAccent(el.value);
    prefs();
  }
  if (el.dataset.cueSetting && !canEdit(current())) {
    render();
    return;
  }
  if (el.dataset.cueSetting === "cueText") {
    const cue = current()?.cues[Number(el.dataset.index)];
    if (cue) {
      cue.cueText = el.value.slice(0, 120);
      scheduleSave(current());
    }
  }
  if (el.hasAttribute("data-master")) engine.setMaster(Number(el.value) / 100);
  if (["volume", "speed"].includes(el.dataset.cueSetting)) {
    const s = current(),
      c = s.cues[Number(el.dataset.index)];
    const key = el.dataset.cueSetting;
    c[key] = key === "speed" ? Number(el.value) / 100 : Number(el.value);
    const valueLabel = el
      .closest(".control-field")
      .querySelector(".editable-value");
    if (valueLabel) valueLabel.textContent = `${Number(el.value)}%`;
    if (key === "speed")
      el.setAttribute(
        "aria-valuetext",
        `${Number(el.value)}%${Number(el.value) === 100 ? ", normal speed" : ""}`,
      );
    if (Number(el.dataset.index) === engine.index) engine.apply();
    scheduleSave(s);
  }
});
document.addEventListener("change", async (e) => {
  const el = e.target;
  try {
    if (el.id === "offline-mode-toggle") {
      await setOfflineMode(el.checked);
      return;
    }
    if (el.id === "cue-loop-mode") {
      const counted = el.value === "count";
      $("#loop-count-label").classList.toggle("hidden", !counted);
      $("#loop-count-label input").disabled = !counted;
    }
    if (el.id === "output-device-select") {
      await engine.setDevice(el.value);
      await detectOutputs();
    }
    if (el.id === "media-view-select") {
      state.view = el.value;
      state.selected.clear();
      render();
    }
    if (el.dataset.selectId) {
      el.checked
        ? state.selected.add(el.dataset.selectId)
        : state.selected.delete(el.dataset.selectId);
      updateSelection();
    }
    if (el.id === "select-all") {
      filteredRows().forEach((r) =>
        el.checked ? state.selected.add(r.id) : state.selected.delete(r.id),
      );
      $("#media-table-body").innerHTML = renderMediaRows();
      updateSelection();
    }
    if (el.id === "upload-input") await uploadFiles([...el.files]);
    const key = el.dataset.cueSetting;
    if (key === "start" || key === "end") {
      const cue = current()?.cues[Number(el.dataset.index)];
      setCropPoint(cue.id, key, parseCropTime(el.value));
    }
  } catch (err) {
    if (["start", "end"].includes(el.dataset.cueSetting)) {
      const cue = current()?.cues[Number(el.dataset.index)];
      if (cue) el.value = formatCropTime(cue[el.dataset.cueSetting]);
    }
    toast(err.message, true);
  }
});
function applyPanelLayout() {
  const layout = state.prefs.panelLayout || {};
  const editor = $(".editor-layout"),
    player = $(".player-layout");
  if (editor) {
    editor.style.setProperty(
      "--sidebar-width",
      layout.editorWidth ? `${layout.editorWidth}%` : "260px",
    );
    if (layout.libraryHeight)
      $(".sidebar-sequences").style.height = `${layout.libraryHeight}px`;
  }
  if (player)
    player.style.setProperty("--output-width", `${layout.outputWidth || 15}%`);
  $$(".media-table th").forEach((th, index) => {
    if (index === 0) return;
    th.style.position = "relative";
    if (layout.columns?.[index]) th.style.width = `${layout.columns[index]}px`;
    if (!th.querySelector("[data-column-resize]"))
      th.insertAdjacentHTML(
        "beforeend",
        `<span class="column-resizer" data-column-resize="${index}" title="Drag to resize column"></span>`,
      );
  });
}
function updateSelection() {
  const rows = filteredRows();
  if ($("#select-all")) {
    $("#select-all").checked =
      rows.length > 0 && rows.every((r) => state.selected.has(r.id));
    $("#select-all").indeterminate =
      rows.some((r) => state.selected.has(r.id)) && !$("#select-all").checked;
  }
  if ($("#cache-selection-label"))
    $("#cache-selection-label").textContent = state.selected.size
      ? "selected"
      : "all";
  if ($("#uncache-selection-label"))
    $("#uncache-selection-label").textContent = state.selected.size
      ? "selected"
      : "all";
}
document.addEventListener("submit", async (e) => {
  if (
    !["sequence-form", "media-edit-form", "cue-config-form"].includes(
      e.target.id,
    )
  )
    return;
  e.preventDefault();
  const form = e.target,
    btn = form.querySelector('button[type="submit"],button'),
    values = Object.fromEntries(new FormData(form));
  btn.disabled = true;
  try {
    if (form.id === "cue-config-form") {
      const seq = current();
      assertEditable(seq);
      if (seq?.id !== form.dataset.sequenceId)
        throw new Error("The active sequence has changed.");
      const index = seq.cues.findIndex((c) => c.id === form.dataset.cueId),
        cue = seq.cues[index],
        next = seq.cues[index + 1];
      if (!cue || (next?.id || "") !== form.dataset.nextId)
        throw new Error("The cue order has changed. Reopen configuration.");
      const loop =
        values.loopMode === "forever"
          ? "forever"
          : values.loopMode === "count"
            ? Number(values.loopCount)
            : 1;
      if (
        loop !== "forever" &&
        (!Number.isInteger(loop) || loop < 1 || loop > 10000)
      )
        throw new Error("Enter 1–10,000 total plays.");
      const fadeIn = Number(values.fadeIn),
        fadeOut = Number(values.fadeOut),
        fadeOutAtPause = Number(values.fadeOutAtPause);
      if (
        ![fadeIn, fadeOut, fadeOutAtPause].every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 3600,
        )
      )
        throw new Error("Enter fade durations between 0 and 3600 seconds.");
      cue.loop = loop;
      cue.fadeIn = fadeIn;
      cue.fadeOut = fadeOut;
      cue.fadeOutAtPause = fadeOutAtPause;
      if (index === engine.index) engine.apply();
      if (next) {
        next.follow = values.linkNext === "on";
        next.followFrom = next.follow ? cue.id : null;
      }
      await saveSequence(seq);
      closeModal();
      render();
      engine.emit();
    } else if (form.id === "sequence-form") {
      const id = form.dataset.id;
      if (id) {
        const s = state.sequences.find((v) => v.id === id);
        assertEditable(s);
        Object.assign(s, values);
        await saveSequence(s);
        closeModal();
        render();
      } else {
        const s = await createSequence({ ...values, cues: [] });
        closeModal();
        await selectSequence(s.id);
      }
    } else {
      const m = media(form.dataset.id);
      Object.assign(m, values);
      await queueChange(state.user.username, "media", m.id, "put", values);
      await refreshPending();
      if (!isOffline()) await syncPending();
      await persistWorkspace();
      closeModal();
      render();
    }
    if (form.dataset.manualSave) {
      const seq = current();
      if (seq && state.cached.has(`sequence:${seq.id}`))
        await cacheSet(
          "assets",
          `sequence:${seq.id}`,
          new Blob([m3uText(seq)], { type: "audio/x-mpegurl" }),
        );
    }
    toast("Details saved.");
  } catch (err) {
    if ($("#form-error")) $("#form-error").textContent = err.message;
    else toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
let drag = null;
document.addEventListener("dragstart", (e) => {
  const m = e.target.closest("[data-media-id]"),
    c = e.target.closest("[data-cue-drag]");
  if (c && e.target.closest("button,input,select,.wave-wrap")) {
    e.preventDefault();
    return;
  }
  drag = m
    ? { type: "media", id: m.dataset.mediaId }
    : c
      ? { type: "cue", index: Number(c.dataset.cueDrag) }
      : null;
  if (drag) {
    e.dataTransfer.setData("application/simplecue", JSON.stringify(drag));
    e.dataTransfer.effectAllowed = drag.type === "media" ? "copy" : "move";
    c?.classList.add("dragging");
  }
});
document.addEventListener("dragover", (e) => {
  const zone = e.target.closest("#cue-dropzone");
  if (zone && (drag || e.dataTransfer.types.includes("Files"))) {
    e.preventDefault();
    zone.classList.add("drag-over");
    $$(".drop-before,.drop-after").forEach((c) =>
      c.classList.remove("drop-before", "drop-after"),
    );
    const card = e.target.closest(".cue-card");
    if (card && drag) {
      const r = card.getBoundingClientRect();
      card.classList.add(
        e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after",
      );
    }
  }
});
document.addEventListener("dragleave", (e) => {
  const zone = e.target.closest("#cue-dropzone");
  if (zone && !zone.contains(e.relatedTarget))
    zone.classList.remove("drag-over");
});
document.addEventListener("drop", async (e) => {
  const zone = e.target.closest("#cue-dropzone");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("drag-over");
  try {
    if (e.dataTransfer.files.length) {
      uploadFolder = "Uploads";
      await uploadFiles([...e.dataTransfer.files]);
      return;
    }
    const data =
      drag || JSON.parse(e.dataTransfer.getData("application/simplecue"));
    const card = e.target.closest(".cue-card"),
      r = card?.getBoundingClientRect(),
      slot = card
        ? Number(card.dataset.index) +
          (e.clientY >= r.top + r.height / 2 ? 1 : 0)
        : current().cues.length;
    if (data.type === "media") await addMedia(data.id, slot);
    else {
      const to = slot - (data.index < slot ? 1 : 0);
      await reorder(data.index, to);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    drag = null;
    $$(".drop-before,.drop-after,.dragging").forEach((c) =>
      c.classList.remove("drop-before", "drop-after", "dragging"),
    );
  }
});
document.addEventListener("dragend", () => {
  drag = null;
  $("#cue-dropzone")?.classList.remove("drag-over");
  $$(".drop-before,.drop-after,.dragging").forEach((c) =>
    c.classList.remove("drop-before", "drop-after", "dragging"),
  );
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeModal();
  }
});
modal.addEventListener("cancel", () => {
  keyCapture = null;
  modal.querySelectorAll("audio,video").forEach((e) => e.pause());
});
let cropMenu = null,
  cropMenuWave = null;
function closeCropMenu(restoreFocus = false) {
  const wave = cropMenuWave;
  cropMenu?.remove();
  cropMenuWave?.querySelector(".wave-context-marker")?.remove();
  cropMenu = null;
  cropMenuWave = null;
  if (restoreFocus && wave?.isConnected) wave.focus({ preventScroll: true });
}
document.addEventListener("contextmenu", (e) => {
  const wave = e.target.closest("[data-seek-index]");
  closeCropMenu();
  if (!wave) return;
  e.preventDefault();
  const seq = current(),
    cue = seq?.cues[Number(wave.dataset.seekIndex)],
    m = cue && media(cue.mediaId);
  if (!cue || !m) return;
  const rect = wave.getBoundingClientRect(),
    position = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const time = Math.round(position * m.duration * 100) / 100,
    seqId = seq.id,
    cueId = cue.id;
  const menu = document.createElement("div");
  menu.className = "wave-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Set crop point");
  menu.innerHTML = `<div class="wave-context-time">${fmt(time)}</div><button role="menuitem" data-crop-point="start" ${time >= cue.end ? "disabled" : ""}>${icon("trim")} Set crop In here</button><button role="menuitem" data-crop-point="end" ${time <= cue.start ? "disabled" : ""}>${icon("trim")} Set crop Out here</button>`;
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-crop-point]");
    if (!button || button.disabled) return;
    const key = button.dataset.cropPoint;
    closeCropMenu();
    try {
      if (current()?.id !== seqId)
        throw new Error("The active sequence has changed.");
      setCropPoint(cueId, key, time);
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.body.append(menu);
  cropMenu = menu;
  cropMenuWave = wave;
  const marker = document.createElement("div");
  marker.className = "wave-context-marker";
  marker.style.left = `${position * 100}%`;
  wave.append(marker);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - bounds.height - 8))}px`;
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
});
document.addEventListener("pointerdown", (e) => {
  if (cropMenu && !cropMenu.contains(e.target)) closeCropMenu();
});
window.addEventListener("resize", () => closeCropMenu());
document.addEventListener("scroll", () => closeCropMenu(), true);
function waveformRatio(wave, clientX) {
  const r = wave.getBoundingClientRect(),
    c = current()?.cues[Number(wave.dataset.seekIndex)],
    m = c && media(c.mediaId);
  if (!m) return 0;
  const sourceTime = ((clientX - r.left) / r.width) * m.duration;
  return Math.max(0, Math.min(1, (sourceTime - c.start) / (c.end - c.start)));
}
let scrubbing = null;
document.addEventListener("pointerdown", async (e) => {
  const wave = e.target.closest("[data-seek-index]");
  if (!wave || e.button !== 0) return;
  e.preventDefault();
  const r = wave.getBoundingClientRect(),
    op = {
      wave,
      index: Number(wave.dataset.seekIndex),
      ratio: waveformRatio(wave, e.clientX),
    };
  scrubbing = op;
  wave.setPointerCapture(e.pointerId);
  if (engine.index !== op.index || engine.loading)
    await engine.select(op.index);
  if (engine.index === op.index) engine.seek(op.ratio);
});
document.addEventListener("pointermove", (e) => {
  if (!scrubbing) return;
  const r = scrubbing.wave.getBoundingClientRect();
  scrubbing.ratio = waveformRatio(scrubbing.wave, e.clientX);
  if (engine.index === scrubbing.index && !engine.loading)
    engine.seek(scrubbing.ratio);
});
document.addEventListener("pointerup", () => {
  scrubbing = null;
});
document.addEventListener("keydown", async (e) => {
  const wave = e.target.closest("[data-seek-index]");
  if (!wave || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
    return;
  e.preventDefault();
  const index = Number(wave.dataset.seekIndex);
  if (index !== engine.index) await engine.select(index);
  if (e.key === "Home") engine.seek(0);
  else if (e.key === "End") engine.seek(0.999);
  else
    engine.seek(
      (engine.elapsed + (e.key === "ArrowRight" ? 5 : -5)) / engine.duration,
    );
});
let resizing = null;
document.addEventListener("pointerdown", (e) => {
  const handle = e.target.closest("[data-resize],[data-column-resize]");
  if (!handle) return;
  e.preventDefault();
  const kind = handle.dataset.resize || "column",
    container =
      kind === "editor"
        ? $(".editor-layout")
        : kind === "output"
          ? $(".player-layout")
          : kind === "library"
            ? $(".sidebar")
            : $(".media-table");
  resizing = {
    kind,
    handle,
    rect: container.getBoundingClientRect(),
    startX: e.clientX,
    startY: e.clientY,
    index: Number(handle.dataset.columnResize),
    width: handle.closest("th")?.getBoundingClientRect().width,
  };
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
});
document.addEventListener("pointermove", (e) => {
  if (!resizing) return;
  const r = resizing,
    { rect } = r;
  state.prefs.panelLayout ||= {};
  const layout = state.prefs.panelLayout;
  if (r.kind === "editor")
    layout.editorWidth = Math.max(
      14,
      Math.min(50, ((e.clientX - rect.left) / rect.width) * 100),
    );
  if (r.kind === "output")
    layout.outputWidth = Math.max(
      10,
      Math.min(45, ((rect.right - e.clientX) / rect.width) * 100),
    );
  if (r.kind === "library")
    layout.libraryHeight = Math.max(
      90,
      Math.min(rect.height - 170, e.clientY - rect.top),
    );
  if (r.kind === "column") {
    layout.columns ||= {};
    layout.columns[r.index] = Math.max(60, r.width + e.clientX - r.startX);
  }
  applyPanelLayout();
  positionVideo();
});
document.addEventListener("pointerup", () => {
  if (!resizing) return;
  resizing = null;
  document.body.classList.remove("resizing");
  prefs();
  drawWaves();
});
document.addEventListener("keydown", (e) => {
  const h = e.target.closest("[data-resize]");
  if (
    !h ||
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
  )
    return;
  e.preventDefault();
  state.prefs.panelLayout ||= {};
  const l = state.prefs.panelLayout;
  if (h.dataset.resize === "editor")
    l.editorWidth = Math.max(
      14,
      Math.min(50, (l.editorWidth || 20) + (e.key === "ArrowRight" ? 2 : -2)),
    );
  if (h.dataset.resize === "output")
    l.outputWidth = Math.max(
      10,
      Math.min(45, (l.outputWidth || 15) + (e.key === "ArrowLeft" ? 2 : -2)),
    );
  if (h.dataset.resize === "library")
    l.libraryHeight = Math.max(
      90,
      (l.libraryHeight || 200) + (e.key === "ArrowDown" ? 20 : -20),
    );
  applyPanelLayout();
  prefs();
  drawWaves();
});
window.addEventListener("resize", () => {
  clearTimeout(waveResize);
  waveResize = setTimeout(() => {
    drawWaves();
    positionVideo();
  }, 150);
});
window.addEventListener("scroll", positionVideo, true);
window.addEventListener("offline", () => {
  networkController.abort();
  networkController = new AbortController();
  markOffline();
});
window.addEventListener("online", () => {
  if (!state.manualOffline) {
    endpointMissing = false;
    probeConnection();
  } else updateConnectivity();
});
window.addEventListener("beforeunload", (event) => {
  if (localSaves.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("#save-status").dataset.action = "sync-details";
$("#save-status").style.cursor = "pointer";
function showLogin() {
  engine.halt(true);
  $("#login-screen").classList.remove("hidden");
  $("#login-form button").disabled = false;
  const wave = $(".login-wave");
  if (!wave.children.length)
    wave.innerHTML = Array.from(
      { length: 65 },
      (_, i) =>
        `<i style="height:${8 + Math.abs(Math.sin(i * 0.34) * Math.cos(i * 0.09)) * 75}px"></i>`,
    ).join("");
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    state.user = await api("/api/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(e.target)),
    });
    state.verifiedUser = state.user.username;
    state.authExpired = false;
    await loadWorkspace();
    await syncPending();
    $("#login-screen").classList.add("hidden");
  } catch (err) {
    $("#login-error").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
async function loadWorkspace(cached = null) {
  const data = cached || (await api("/api/workspace")),
    previous = await cacheGet("meta", "workspace");
  if (data.user) state.user = data.user;
  state.media = data.media || [];
  state.sequences = data.sequences || [];
  state.database = data.database || "redis";
  state.uploads = data.uploads || "unconfigured";
  await refreshPending();
  for (const old of previous?.sequences || [])
    if (
      state.cached.has(`sequence:${old.id}`) &&
      !state.sequences.some((s) => s.id === old.id)
    )
      state.sequences.push(old);
  let pendingPrefs = null;
  for (const entry of state.pending) {
    if (entry.kind === "sequence") {
      const index = state.sequences.findIndex((s) => s.id === entry.id);
      if (entry.operation === "delete") {
        if (index >= 0) state.sequences.splice(index, 1);
      } else if (index >= 0)
        state.sequences[index] = structuredClone(entry.data);
      else state.sequences.push(structuredClone(entry.data));
    } else if (entry.kind === "media") {
      const m = media(entry.id);
      if (m) Object.assign(m, entry.data);
    } else pendingPrefs = entry.data;
  }
  let localPrefs = {};
  try {
    localPrefs = JSON.parse(localStorage.getItem("simplecue-prefs") || "{}");
  } catch {}
  state.prefs = {
    ...state.prefs,
    ...localPrefs,
    ...data.preferences,
    ...pendingPrefs,
    keybinds: {
      ...defaults,
      ...(pendingPrefs?.keybinds ||
        data.preferences?.keybinds ||
        localPrefs.keybinds),
    },
  };
  state.activeId =
    state.sequences.find((s) => s.id === state.prefs.activeId)?.id ||
    state.sequences[0]?.id;
  setAccent(state.prefs.accent);
  setTheme(state.prefs.mode || "light");
  await refreshCache();
  updateConnectivity();
  render();
  if (current()?.cues.length) await engine.select(0);
  await persistWorkspace();
}
async function boot() {
  hydrateIcons();
  await detectOutputs();
  navigator.mediaDevices?.addEventListener("devicechange", detectOutputs);
  try {
    await refreshCache();
    updateConnectivity();
    const cached = await cacheGet("meta", "workspace");
    if (isOffline()) {
      if (cached?.user) {
        await loadWorkspace(cached);
        $("#login-screen").classList.add("hidden");
        return;
      }
      showLogin();
      $("#login-error").textContent = "Connect to sign in for the first time.";
      return;
    }
    try {
      state.user = await api("/api/session");
      state.verifiedUser = state.user.username;
      state.authExpired = false;
      await loadWorkspace();
      await syncPending();
    } catch (error) {
      if (error.offline && cached?.user) {
        await loadWorkspace(cached);
        $("#login-screen").classList.add("hidden");
      } else {
        showLogin();
        if (error.status !== 401) $("#login-error").textContent = error.message;
      }
    }
  } catch (error) {
    showLogin();
    $("#login-error").textContent = error.message;
  } finally {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => navigator.serviceWorker.ready)
        .then(() =>
          navigator.serviceWorker.controller?.postMessage({
            type: "NETWORK_MODE",
            offline: isOffline(),
          }),
        )
        .catch(() => {});
  }
}
boot();
