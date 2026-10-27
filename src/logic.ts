/**
 * Pure playlist rules, shared by the GM's popover (which issues actions) and every background page
 * (which plays what the room says). Nothing here touches Owlbear or the Web Audio API.
 *
 * The model is the Mesa's: the GM is the "server". Each start is stamped with the GM's clock, and every
 * listener works out where the track is from that stamp, so late joiners hear the same point.
 * Switching tracks in a sequential/shuffle playlist is the Trilha's: the old track fades out whole and
 * the new one starts when the fade-out is `entrada`% done, so the tails touch without overlapping.
 */

/** Same values as Foundry's PLAYLIST_MODES. */
export const MODE = { MANUAL: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 } as const;
export type Mode = -1 | 0 | 1 | 2;

export interface Track {
  id: string;
  name: string;
  /** "sb:<object key>" for an uploaded file, or a full URL. */
  src: string;
  /** 0–1. */
  vol: number;
  repeat: boolean;
  /** Intro + loop: when both are set and `repeat` is on, only [loopStart, loopEnd] repeats (seconds). */
  loopStart?: number | null;
  loopEnd?: number | null;
}

export interface Playlist {
  id: string;
  name: string;
  mode: Mode;
  /** Fade in/out in ms. */
  fade: number;
  tracks: Track[];
}

export interface Library {
  v: 1;
  playlists: Playlist[];
  /** When the next track starts during a hand-over, as % of the old one's fade-out (Trilha's 75). */
  entrada: number;
}

/** One track sounding (or about to, or fading out, or paused) for the whole room. */
export interface Voice {
  pl: string;
  name: string;
  src: string;
  vol: number;
  repeat: boolean;
  ls: number | null;
  le: number | null;
  fade: number;
  /** GM clock (ms) when playback starts — may be in the future during a hand-over. */
  t0: number;
  /** Seconds into the file at `t0`. */
  off: number;
  /** GM clock (ms) when the fade-out began; the voice is gone `fade` ms later. */
  stop?: number;
  /** Seconds into the file where it was paused. */
  paused?: number;
}

export interface Playback {
  voices: Record<string, Voice>;
  /** Shuffle seed per playlist, re-rolled when the playlist starts. */
  seeds: Record<string, number>;
  /** Bumped whenever the library is saved, so other GM windows reload it. */
  lib: number;
}

export const emptyLibrary = (): Library => ({ v: 1, playlists: [], entrada: 75 });
export const emptyPlayback = (): Playback => ({ voices: {}, seeds: {}, lib: 0 });

export type Action =
  | { action: "playAll"; pl: string }
  | { action: "stopAll"; pl: string }
  | { action: "play"; pl: string; tr: string }
  | { action: "pause"; pl: string; tr: string }
  | { action: "stop"; pl: string; tr: string }
  | { action: "next" | "previous"; pl: string }
  | { action: "ended"; pl: string; tr: string; t0: number }
  | { action: "volume"; pl: string; tr: string; vol: number };

// ---------------------------------------------------------------------------
// Order

/** Small deterministic PRNG (mulberry32) so every window derives the same shuffle from a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Track ids in the order they play: list order, or a seeded shuffle of it. */
export function playbackOrder(playlist: Playlist, seed = 0): string[] {
  const ids = playlist.tracks.map(t => t.id);
  if (playlist.mode !== MODE.SHUFFLE) return ids;
  const rnd = seededRandom(seed);
  const keys = new Map(ids.map(id => [id, rnd()]));
  return ids.sort((a, b) => keys.get(a)! - keys.get(b)!);
}

/** The track after (1) or before (-1) `current`, wrapping around. */
export function adjacent(order: string[], current: string | null, direction: 1 | -1): string | null {
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  if (direction === 1) return order[(i + 1) % order.length];
  if (i === -1) return order[order.length - 1];
  return order[(i - 1 + order.length) % order.length];
}

// ---------------------------------------------------------------------------
// Time

/** Sounding: started (or scheduled) and neither paused nor fading out. */
export const isActive = (v: Voice) => v.paused === undefined && v.stop === undefined;

/** A voice whose fade-out has finished can be dropped. */
export const isExpired = (v: Voice, now: number) => v.stop !== undefined && now >= v.stop + v.fade;

/**
 * Where a voice is in its file at `now`, in seconds. Before `t0` it is negative: minus the seconds left
 * until it starts.
 * Loops wrap — the whole file, or only [ls, le] once the intro has played. A non-looping voice past
 * the end returns null (finished). `duration` may be unknown (NaN) until the file's metadata loads.
 */
export function position(v: Voice, now: number, duration = NaN): number | null {
  if (v.paused !== undefined) return v.paused;
  if (now < v.t0) return (now - v.t0) / 1000;
  const t = v.off + (now - v.t0) / 1000;
  const region = loopRegion(v, duration);
  if (region) {
    const [ls, le] = region;
    return t < le ? t : ls + ((t - ls) % (le - ls));
  }
  if (!Number.isFinite(duration)) return t;
  if (t < duration) return t;
  return v.repeat ? t % duration : null;
}

/** The loop region of an intro + loop voice, if it has a valid one. */
export function loopRegion(v: Pick<Voice, "repeat" | "ls" | "le">, duration = NaN): [number, number] | null {
  if (!v.repeat || v.ls == null || v.le == null) return null;
  const le = Number.isFinite(duration) ? Math.min(v.le, duration) : v.le;
  return le - v.ls > 0.05 ? [Math.max(0, v.ls), le] : null;
}

// ---------------------------------------------------------------------------
// Actions

const voiceFor = (p: Playlist, t: Track, t0: number, off: number): Voice => ({
  pl: p.id, name: t.name, src: t.src, vol: t.vol, repeat: t.repeat,
  ls: t.loopStart ?? null, le: t.loopEnd ?? null, fade: p.fade, t0, off,
});

/**
 * The room's playback after the GM (or the conductor, for "ended") does `a` at GM-clock `now`.
 * Returns a new object; the input is untouched.
 */
export function act(lib: Library, pb: Playback, a: Action, now: number): Playback {
  const out: Playback = { voices: {}, seeds: { ...pb.seeds }, lib: pb.lib };
  for (const [id, v] of Object.entries(pb.voices)) if (!isExpired(v, now)) out.voices[id] = { ...v };
  const playlist = lib.playlists.find(p => p.id === a.pl);
  if (!playlist) return out;
  const voices = out.voices;
  const mine = () => Object.entries(voices).filter(([, v]) => v.pl === playlist.id);
  const sequential = playlist.mode === MODE.SEQUENTIAL || playlist.mode === MODE.SHUFFLE;
  const track = "tr" in a ? playlist.tracks.find(t => t.id === a.tr) : undefined;

  const fadeOut = (id: string) => {
    const v = voices[id];
    if (!v) return;
    if (v.paused !== undefined || v.t0 > now) delete voices[id]; // nothing audible to fade
    else if (v.stop === undefined) v.stop = now;
  };

  /** Start `t` (resuming it if paused). In sequential modes, hand over from whatever this playlist plays. */
  const start = (t: Track, handOver: boolean) => {
    const prev = voices[t.id];
    const resumeAt = prev?.paused;
    let t0 = now;
    if (handOver) {
      // Start when the fade-out under way (or the one about to begin) is `entrada`% done.
      const share = clamp(lib.entrada ?? 75, 0, 100) / 100;
      for (const [id] of mine()) {
        if (id === t.id) continue;
        fadeOut(id);
        const v = voices[id];
        if (v?.stop !== undefined) t0 = Math.max(t0, v.stop + Math.round(v.fade * share));
      }
    }
    voices[t.id] = voiceFor(playlist, t, t0, resumeAt ?? 0);
  };

  switch (a.action) {
    case "playAll": {
      if (!playlist.tracks.length || playlist.mode === MODE.MANUAL) break;
      if (playlist.mode === MODE.SIMULTANEOUS) {
        for (const t of playlist.tracks) if (!voices[t.id] || !isActive(voices[t.id])) start(t, false);
        break;
      }
      if (mine().some(([, v]) => isActive(v))) break;
      // A fresh shuffle each time the playlist starts; a paused track resumes where it was.
      const seed = Math.floor(Math.random() * 1_000_000);
      out.seeds[playlist.id] = seed;
      const paused = mine().find(([, v]) => v.paused !== undefined)?.[0];
      const first = paused ?? playbackOrder(playlist, seed)[0];
      start(playlist.tracks.find(t => t.id === first)!, true);
      break;
    }
    case "stopAll":
      for (const [id] of mine()) fadeOut(id);
      break;
    case "play":
      if (track) start(track, sequential);
      break;
    case "pause": {
      const v = voices[a.tr];
      if (!v || !isActive(v)) break;
      const p = position(v, now);
      if (p === null || p < 0) delete voices[a.tr];
      else voices[a.tr] = { ...v, paused: p };
      break;
    }
    case "stop":
      fadeOut(a.tr);
      break;
    case "next":
    case "previous": {
      if (!sequential) break;
      const current = mine().find(([, v]) => isActive(v))?.[0] ?? null;
      if (!current) break;
      const id = adjacent(playbackOrder(playlist, out.seeds[playlist.id]), current, a.action === "next" ? 1 : -1);
      const t = playlist.tracks.find(x => x.id === id);
      if (t && t.id !== current) start(t, true);
      break;
    }
    case "ended": {
      // Every conductor window may report the end; only the report for this exact playback counts.
      const v = voices[a.tr];
      if (!v || !isActive(v) || v.t0 !== a.t0 || v.repeat) break;
      delete voices[a.tr];
      if (!sequential) break;
      const id = adjacent(playbackOrder(playlist, out.seeds[playlist.id]), a.tr, 1);
      const t = playlist.tracks.find(x => x.id === id);
      if (t) start(t, false);
      break;
    }
    case "volume": {
      const v = voices[a.tr];
      if (v) v.vol = clamp(a.vol, 0, 1);
      break;
    }
  }
  return out;
}

/** Re-applies a track's edited settings to its voice (name, volume, loop), keeping its timing. */
export function refreshVoices(lib: Library, pb: Playback): Playback {
  const voices: Record<string, Voice> = {};
  for (const [id, v] of Object.entries(pb.voices)) {
    const p = lib.playlists.find(x => x.id === v.pl);
    const t = p?.tracks.find(x => x.id === id);
    if (!p || !t) continue; // deleted while playing
    voices[id] = { ...v, name: t.name, vol: t.vol, repeat: t.repeat, ls: t.loopStart ?? null, le: t.loopEnd ?? null, fade: p.fade };
  }
  return { ...pb, voices };
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** "1:05.250" ⇄ 65.25. Accepts "65.25", "1:05", "01:05.250". */
export function parseTime(s: string): number | null {
  const str = s.trim().replace(",", ".");
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0) || parts.length > 3) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function formatTime(sec: number | null | undefined, ms = true): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${(ms ? s.toFixed(3) : Math.floor(s).toString()).padStart(ms ? 6 : 2, "0")}`;
}
