import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import "./style.css";
import { gainToSlider, sliderToGain } from "./engine.ts";
import { t } from "./i18n.ts";
import { icon } from "./icons.ts";
import {
  clamp, emptyPlayback, formatTime, isActive, MODE, parseTime,
  type Action, type Library, type Mode, type Playback, type Playlist, type Track,
} from "./logic.ts";
import { localChannel, NOW_KEY, readMyVolume, saveMyVolume, type LocalMessage, type NowPlaying } from "./shared.ts";
import { ACCEPT, addFile, deleteFile, isAudio, loadLibrary, saveLibrary, storageInfo } from "./store.ts";

/**
 * The extension's window. GMs get the playlists (as in Foundry's sidebar); players get what is
 * playing and their own volume. It only asks: the background page plays and streams.
 */
const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const uid = () => crypto.randomUUID().slice(0, 8);

let gm = false;
let lib: Library = { v: 1, playlists: [], entrada: 75 };
let pb: Playback = emptyPlayback();
let progress: Record<string, { time: number; duration: number }> = {};
let listeners = 0;
let gmBlocked = false;
let receiver = { connected: 0, blocked: false };
let nowPlaying: NowPlaying[] = [];
let roomMetadata: Record<string, unknown> = {};
/** Connection ids of the others in the room: a GM who reloaded gets a new one. */
let present = new Set<string>();
let storageNote = "";

const COLLAPSED_KEY = "pt.th1rdo.trilha/collapsed";
const collapsed = new Set<string>(readJson(COLLAPSED_KEY, []));
const editing = new Set<string>();
/** Playlist whose name is being edited in place. */
let renaming: string | null = null;
/** A delete button clicked once: the second click within 3 s confirms. */
let armed: string | null = null;
let armedTimer: ReturnType<typeof setTimeout> | null = null;
let pointerDown = false;
let pendingRender = false;
let lastShape = "";

const post = localChannel(onLocal);

function onLocal(m: LocalMessage): void {
  if (m.type === "state") {
    pb = m.playback;
    progress = m.progress;
    listeners = m.listeners;
    gmBlocked = m.blocked;
    renderIfShapeChanged();
    updateProgress();
  } else if (m.type === "receiver") {
    receiver = { connected: m.connected, blocked: m.blocked };
    if (!gm) render();
    else renderIfShapeChanged();
  }
}

OBR.onReady(async () => {
  applyTheme(await OBR.theme.getTheme());
  OBR.theme.onChange(applyTheme);
  gm = (await OBR.player.getRole()) === "GM";
  OBR.player.onChange(async p => {
    const now = p.role === "GM";
    if (now !== gm) {
      gm = now;
      if (gm) lib = await loadLibrary();
      render();
    }
  });
  present = new Set((await OBR.party.getPlayers()).map(p => p.connectionId));
  roomMetadata = await OBR.room.getMetadata();
  nowPlaying = collectNowPlaying();
  OBR.room.onMetadataChange(md => {
    roomMetadata = md;
    nowPlaying = collectNowPlaying();
    if (!gm) render();
  });
  OBR.party.onChange(players => {
    present = new Set(players.map(p => p.connectionId));
    nowPlaying = collectNowPlaying();
    if (!gm) render();
  });
  if (gm) {
    lib = await loadLibrary();
    refreshStorage();
  }
  render();
  post({ type: "hello" });
});

/** What every GM in the room is playing (entries left by GMs who reloaded or left are skipped). */
function collectNowPlaying(): NowPlaying[] {
  return Object.entries(roomMetadata)
    .filter(([k]) => k.startsWith(`${NOW_KEY}/`) && present.has(k.slice(NOW_KEY.length + 1)))
    .flatMap(([, v]) => (Array.isArray(v) ? (v as NowPlaying[]) : []));
}

// ---------------------------------------------------------------------------
// Rendering

/** Re-render when something other than progress changed (keeps sliders and inputs alive). */
function renderIfShapeChanged(): void {
  const shape = JSON.stringify([pb.voices, listeners, gmBlocked, receiver]);
  if (shape !== lastShape) render();
}

function render(): void {
  if (pointerDown) {
    pendingRender = true;
    return;
  }
  lastShape = JSON.stringify([pb.voices, listeners, gmBlocked, receiver]);
  const scroll = app.scrollTop;
  const focus = focusedField();
  app.innerHTML = gm ? gmView() : playerView();
  app.scrollTop = scroll;
  focus?.();
  updateProgress();
}

/** Remembers which text field has the focus, so a re-render can give it back (with the caret). */
function focusedField(): (() => void) | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || el.type !== "text" || !app.contains(el)) return null;
  const host = el.closest<HTMLElement>("[data-tr]") ?? el.closest<HTMLElement>("[data-pl]");
  const scope = host?.dataset.tr ? `[data-tr="${host.dataset.tr}"]` : `[data-pl="${host?.dataset.pl}"]`;
  const sel = `${scope} [data-act="${el.dataset.act}"]`;
  const { value, selectionStart, selectionEnd } = el;
  return () => {
    const again = app.querySelector<HTMLInputElement>(sel);
    if (!again) return;
    again.value = value;
    again.focus();
    again.setSelectionRange(selectionStart, selectionEnd);
  };
}

function header(extra = ""): string {
  const vol = readMyVolume();
  return `
    <header>
      <h1>${t.title}</h1>
      ${extra}
      <label class="myvol" title="${t.myVolume}">${icon("volume")}
        <input type="range" min="0" max="1" step="0.01" value="${vol}" data-act="my-volume" aria-label="${t.myVolume}">
      </label>
    </header>`;
}

function blockedBanner(): string {
  if (!gmBlocked && !receiver.blocked) return "";
  return `<div class="banner"><strong>${t.blocked}</strong> ${t.blockedHint}
    <button data-act="retry">${t.retry}</button></div>`;
}

function playerView(): string {
  const status = receiver.connected ? t.connected : t.waiting;
  const list = nowPlaying.length
    ? `<ul class="now">${nowPlaying.map(n => `<li>${icon("mode--1")}<span><b>${esc(n.name)}</b>${n.playlist ? `<small>${esc(n.playlist)}</small>` : ""}</span></li>`).join("")}</ul>`
    : `<p class="muted">${t.nothing}</p>`;
  return `${header()}${blockedBanner()}
    <section class="player"><h2>${t.nowPlaying}</h2>${list}<p class="status ${receiver.connected ? "ok" : ""}">${status}</p></section>`;
}

function gmView(): string {
  const playlists = lib.playlists.map(playlistView).join("") || `<p class="muted pad">${t.empty}</p>`;
  return `${header(`<span class="listeners">${t.listeners(listeners)}</span>`)}${blockedBanner()}
    <main>${playlists}</main>
    <footer>
      <button class="primary" data-act="new-playlist">${icon("plus")} ${t.newPlaylist}</button>
      <details class="settings"><summary>${icon("settings")} ${t.settings}</summary>
        <label>${t.entrada}: <b>${lib.entrada}%</b>
          <input type="range" min="0" max="100" step="5" value="${lib.entrada}" data-act="entrada"></label>
        <p class="muted">${t.localNote}${storageNote ? ` ${storageNote}` : ""}</p>
      </details>
    </footer>
    <input type="file" id="files" multiple accept="${ACCEPT}" hidden>`;
}

function playlistView(p: Playlist): string {
  const open = !collapsed.has(p.id);
  const playing = Object.values(pb.voices).some(v => v.pl === p.id && isActive(v));
  const sequential = p.mode === MODE.SEQUENTIAL || p.mode === MODE.SHUFFLE;
  const canPlayAll = p.mode !== MODE.MANUAL && p.tracks.length > 0;
  return `
  <section class="playlist ${playing ? "playing" : ""}" data-pl="${p.id}">
    <div class="pl-head">
      <button class="icon chevron ${open ? "open" : ""}" data-act="toggle" title="${esc(p.name)}">${icon("chevron")}</button>
      ${renaming === p.id
        ? `<input class="pl-rename" type="text" value="${esc(p.name)}" data-act="pl-name" aria-label="${t.playlistName}">`
        : `<span class="pl-name" data-act="toggle">${esc(p.name)}</span>`}
      <button class="icon" data-act="cycle-mode" title="${t.modes[String(p.mode) as "0"]}">${icon(`mode-${p.mode}`)}</button>
      ${sequential && playing ? `<button class="icon" data-act="previous" title="${t.previous}">${icon("previous")}</button>` : ""}
      ${playing
        ? `<button class="icon" data-act="stop-all" title="${t.stopAll}">${icon("stop")}</button>`
        : canPlayAll ? `<button class="icon" data-act="play-all" title="${t.playAll}">${icon("play")}</button>` : ""}
      ${sequential && playing ? `<button class="icon" data-act="next" title="${t.next}">${icon("next")}</button>` : ""}
    </div>
    ${open ? `
    <div class="pl-body">
      <ol class="tracks">${p.tracks.map((tr, i) => trackView(p, tr, i)).join("") || `<li class="muted pad drop-hint">${t.emptyPlaylist}</li>`}</ol>
      <div class="pl-tools">
        <button data-act="add">${icon("plus")} ${t.addTracks}</button>
        <label class="fade" title="${t.fade}">${t.fade}
          <input type="number" min="0" max="30" step="0.5" value="${p.fade / 1000}" data-act="fade"></label>
        <button class="icon" data-act="sort" title="${t.sortAZ}">${icon("sort")}</button>
        <button class="icon" data-act="rename" title="${t.rename}">${icon("edit")}</button>
        ${deleteButton(`pl:${p.id}`, "delete-playlist")}
      </div>
    </div>` : ""}
  </section>`;
}

function trackView(p: Playlist, tr: Track, i: number): string {
  const v = pb.voices[tr.id];
  const active = !!v && isActive(v);
  const paused = v?.paused !== undefined;
  const loop = tr.loopStart != null && tr.loopEnd != null;
  return `
  <li class="track ${active ? "active" : ""} ${paused ? "paused" : ""}" data-tr="${tr.id}">
    <div class="tr-row">
      ${active
        ? `<button class="icon" data-act="pause" title="${t.pause}">${icon("pause")}</button>`
        : `<button class="icon" data-act="play" title="${t.play}">${icon("play")}</button>`}
      <span class="tr-name" title="${esc(tr.name)}">${esc(tr.name)}${loop ? ` <small class="tag">loop</small>` : ""}</span>
      ${active || paused ? `<button class="icon" data-act="stop" title="${t.stop}">${icon("stop")}</button>` : ""}
      <button class="icon toggle ${tr.repeat ? "on" : ""}" data-act="repeat" title="${t.repeat}">${icon("repeat")}</button>
      <input class="tr-vol" type="range" min="0" max="1" step="0.01" value="${gainToSlider(tr.vol)}" data-act="track-volume" title="${t.volume}">
      <button class="icon" data-act="edit" title="${t.edit}">${icon("edit")}</button>
    </div>
    ${active || paused ? `<div class="progress"><div class="bar"></div><span class="time"></span></div>` : ""}
    ${editing.has(tr.id) ? `
    <div class="tr-edit">
      <label>${t.name}<input type="text" value="${esc(tr.name)}" data-act="track-name"></label>
      <div class="loop">
        <label>${t.loopStart}<input type="text" placeholder="0:40.000" value="${formatTime(tr.loopStart)}" data-act="loop-start"></label>
        <label>${t.loopEnd}<input type="text" placeholder="1:11.213" value="${formatTime(tr.loopEnd)}" data-act="loop-end"></label>
      </div>
      <p class="muted">${t.loopHint}</p>
      <div class="tr-edit-tools">
        <button class="icon" data-act="up" title="${t.up}" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
        <button class="icon" data-act="down" title="${t.down}" ${i === p.tracks.length - 1 ? "disabled" : ""}>${icon("down")}</button>
        ${deleteButton(`tr:${tr.id}`, "delete-track")}
      </div>
    </div>` : ""}
  </li>`;
}

function deleteButton(key: string, act: string): string {
  return armed === key
    ? `<button class="danger confirm" data-act="${act}">${t.confirm}</button>`
    : `<button class="icon danger" data-act="${act}" title="${t.remove}">${icon("trash")}</button>`;
}

/** First click arms the button; true when this click is the confirming second one. */
function confirmed(key: string): boolean {
  if (armedTimer) clearTimeout(armedTimer);
  if (armed === key) {
    armed = null;
    return true;
  }
  armed = key;
  armedTimer = setTimeout(() => {
    armed = null;
    render();
  }, 3000);
  render();
  return false;
}

function focusRename(): void {
  const input = app.querySelector<HTMLInputElement>(".pl-rename");
  input?.focus();
  input?.select();
}

function updateProgress(): void {
  for (const el of app.querySelectorAll<HTMLElement>(".track")) {
    const p = progress[el.dataset.tr!];
    const bar = el.querySelector<HTMLElement>(".bar");
    const time = el.querySelector<HTMLElement>(".time");
    if (!bar || !time) continue;
    const v = pb.voices[el.dataset.tr!];
    const cur = v?.paused ?? p?.time ?? 0;
    const dur = p?.duration ?? NaN;
    bar.style.width = Number.isFinite(dur) && dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    time.textContent = Number.isFinite(dur) ? `${formatTime(cur, false)} / ${formatTime(dur, false)}` : formatTime(cur, false);
  }
}

// ---------------------------------------------------------------------------
// Events

const playlistOf = (el: Element) => lib.playlists.find(p => p.id === el.closest<HTMLElement>("[data-pl]")?.dataset.pl);
const trackOf = (el: Element, p?: Playlist) => p?.tracks.find(x => x.id === el.closest<HTMLElement>("[data-tr]")?.dataset.tr);
const send = (action: Action) => post({ type: "act", action });

async function commit(rerender = true): Promise<void> {
  await saveLibrary(lib);
  post({ type: "library-changed" });
  if (rerender) render();
}

app.addEventListener("click", async e => {
  const el = (e.target as Element).closest<HTMLElement>("[data-act]");
  if (!el || el instanceof HTMLInputElement) return;
  const p = playlistOf(el);
  const tr = trackOf(el, p);
  switch (el.dataset.act) {
    case "retry": return post({ type: "retry" });
    case "new-playlist": {
      const fresh: Playlist = { id: uid(), name: t.newPlaylist, mode: MODE.SEQUENTIAL, fade: 3000, tracks: [] };
      lib.playlists.push(fresh);
      renaming = fresh.id;
      await commit();
      return focusRename();
    }
    case "toggle":
      if (!p) return;
      collapsed.has(p.id) ? collapsed.delete(p.id) : collapsed.add(p.id);
      writeJson(COLLAPSED_KEY, [...collapsed]);
      return render();
    case "cycle-mode": {
      if (!p) return;
      send({ action: "stopAll", pl: p.id });
      p.mode = (p.mode >= MODE.SIMULTANEOUS ? MODE.MANUAL : p.mode + 1) as Mode;
      return commit();
    }
    case "play-all": return p && send({ action: "playAll", pl: p.id });
    case "stop-all": return p && send({ action: "stopAll", pl: p.id });
    case "next": return p && send({ action: "next", pl: p.id });
    case "previous": return p && send({ action: "previous", pl: p.id });
    case "add":
      pickTarget = p ?? null;
      return document.getElementById("files")?.click();
    case "sort":
      if (!p) return;
      p.tracks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      return commit();
    case "rename":
      if (!p) return;
      renaming = p.id;
      render();
      return focusRename();
    case "delete-playlist":
      if (!p || !confirmed(`pl:${p.id}`)) return;
      send({ action: "stopAll", pl: p.id });
      lib.playlists = lib.playlists.filter(x => x !== p);
      await commit();
      for (const x of p.tracks) await deleteFile(x.src).catch(() => undefined);
      return refreshStorage();
    case "play": return p && tr && send({ action: "play", pl: p.id, tr: tr.id });
    case "pause": return p && tr && send({ action: "pause", pl: p.id, tr: tr.id });
    case "stop": return p && tr && send({ action: "stop", pl: p.id, tr: tr.id });
    case "repeat":
      if (!tr) return;
      tr.repeat = !tr.repeat;
      return commit();
    case "edit":
      if (!tr) return;
      editing.has(tr.id) ? editing.delete(tr.id) : editing.add(tr.id);
      return render();
    case "up":
    case "down": {
      if (!p || !tr) return;
      const i = p.tracks.indexOf(tr);
      const j = el.dataset.act === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= p.tracks.length) return;
      [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
      return commit();
    }
    case "delete-track":
      if (!p || !tr || !confirmed(`tr:${tr.id}`)) return;
      send({ action: "stop", pl: p.id, tr: tr.id });
      p.tracks = p.tracks.filter(x => x !== tr);
      editing.delete(tr.id);
      await commit();
      await deleteFile(tr.src).catch(() => undefined);
      return refreshStorage();
  }
});

let volumeTimer: ReturnType<typeof setTimeout> | null = null;
app.addEventListener("input", e => {
  const el = e.target as HTMLInputElement;
  const p = playlistOf(el);
  const tr = trackOf(el, p);
  if (el.dataset.act === "my-volume") {
    saveMyVolume(Number(el.value));
    post({ type: "volume", value: Number(el.value) });
  } else if (el.dataset.act === "track-volume" && p && tr) {
    tr.vol = sliderToGain(Number(el.value));
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => send({ action: "volume", pl: p.id, tr: tr.id, vol: tr.vol }), 60);
  } else if (el.dataset.act === "entrada") {
    el.parentElement!.querySelector("b")!.textContent = `${el.value}%`;
  }
});

app.addEventListener("change", e => {
  const el = e.target as HTMLInputElement;
  const p = playlistOf(el);
  const tr = trackOf(el, p);
  switch (el.dataset.act) {
    case "track-volume": return commit(false);
    case "entrada":
      lib.entrada = clamp(Number(el.value), 0, 100);
      return commit(false);
    case "fade":
      if (!p) return;
      p.fade = Math.round(clamp(Number(el.value), 0, 30) * 1000);
      return commit(false);
    case "pl-name":
      if (!p) return;
      renaming = null;
      if (el.value.trim()) p.name = el.value.trim();
      return commit();
    case "track-name":
      if (!tr || !el.value.trim()) return;
      tr.name = el.value.trim();
      return commit(false);
    case "loop-start":
    case "loop-end": {
      if (!tr) return;
      const v = parseTime(el.value);
      if (el.value.trim() && v === null) {
        el.classList.add("invalid");
        return;
      }
      el.classList.remove("invalid");
      if (el.dataset.act === "loop-start") tr.loopStart = v;
      else tr.loopEnd = v;
      return commit(false);
    }
  }
});

app.addEventListener("keydown", e => {
  const el = e.target as HTMLInputElement;
  if (el.dataset?.act !== "pl-name") return;
  if (e.key === "Enter") el.blur();
  if (e.key === "Escape") {
    renaming = null;
    render();
  }
});

// Keep sliders alive while dragging: renders wait for the pointer to come up.
app.addEventListener("pointerdown", () => (pointerDown = true));
window.addEventListener("pointerup", () => {
  pointerDown = false;
  if (pendingRender) {
    pendingRender = false;
    render();
  }
});

// ---------------------------------------------------------------------------
// Adding files: the button, or dropping them on a playlist

let pickTarget: Playlist | null = null;
app.addEventListener("change", e => {
  const input = e.target as HTMLInputElement;
  if (input.id !== "files" || !input.files) return;
  const files = [...input.files];
  input.value = "";
  if (pickTarget) addFiles(pickTarget, files);
});

app.addEventListener("dragover", e => {
  if (!gm || !e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  const section = (e.target as Element).closest(".playlist");
  for (const s of app.querySelectorAll(".playlist.drop")) if (s !== section) s.classList.remove("drop");
  section?.classList.add("drop");
});
app.addEventListener("dragleave", e => {
  if (!(e.relatedTarget instanceof Node) || !app.contains(e.relatedTarget)) {
    for (const s of app.querySelectorAll(".playlist.drop")) s.classList.remove("drop");
  }
});
app.addEventListener("drop", e => {
  if (!gm || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  for (const s of app.querySelectorAll(".playlist.drop")) s.classList.remove("drop");
  const p = playlistOf(e.target as Element) ?? lib.playlists[lib.playlists.length - 1];
  const files = [...e.dataTransfer.files];
  if (p) addFiles(p, files);
  else {
    const fresh: Playlist = { id: uid(), name: t.newPlaylist, mode: MODE.SEQUENTIAL, fade: 3000, tracks: [] };
    lib.playlists.push(fresh);
    addFiles(fresh, files);
  }
});

async function addFiles(p: Playlist, files: File[]): Promise<void> {
  let added = 0;
  for (const f of files) {
    if (!isAudio(f)) {
      OBR.notification.show(t.notAudio(f.name), "WARNING");
      continue;
    }
    try {
      const src = await addFile(f);
      p.tracks.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, ""), src, vol: 0.5, repeat: false });
      added++;
    } catch (err) {
      OBR.notification.show(`${f.name}: ${(err as Error).message}`, "ERROR");
    }
  }
  collapsed.delete(p.id);
  await commit();
  if (added) OBR.notification.show(t.added(added), "SUCCESS");
  refreshStorage();
}

async function refreshStorage(): Promise<void> {
  const info = await storageInfo().catch(() => null);
  storageNote = info?.used ? t.storage(formatBytes(info.used)) : "";
  const note = app.querySelector(".settings .muted");
  if (note) note.textContent = `${t.localNote}${storageNote ? ` ${storageNote}` : ""}`;
}

// ---------------------------------------------------------------------------

function applyTheme(theme: Theme): void {
  const r = document.documentElement.style;
  document.documentElement.dataset.mode = theme.mode.toLowerCase();
  r.setProperty("--primary", theme.primary.main);
  r.setProperty("--primary-contrast", theme.primary.contrastText);
  r.setProperty("--paper", theme.background.paper);
  r.setProperty("--bg", theme.background.default);
  r.setProperty("--text", theme.text.primary);
  r.setProperty("--text-2", theme.text.secondary);
  r.setProperty("--text-3", theme.text.disabled);
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembered for this visit only.
  }
}
