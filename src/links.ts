import OBR from "@owlbear-rodeo/sdk";
import { isExpired, position, type Voice } from "./logic.ts";
import { CH_CLOCK, VOICES_KEY } from "./shared.ts";

/**
 * Link tracks — YouTube videos and direct audio links. A web page cannot read their sound, so the GM's
 * browser cannot stream them: instead every browser plays them itself (YouTube in a hidden player,
 * other links in an <audio> element), following the voices the GM publishes in the room metadata.
 * Starts are stamped with the GM's clock; each browser measures its offset to that clock and seeks
 * back into place whenever it drifts.
 */

export { isLink, parseLink } from "./link-parse.ts";

/** The video's title, when YouTube tells us. */
export async function youtubeTitle(id: string): Promise<string | null> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    return r.ok ? ((await r.json()) as { title?: string }).title ?? null : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Clock: every background answers pings with its own Date.now(); a listener keeps the best offset per GM.

type ClockMsg = { kind: "ping"; from: string; to: string; t: number } | { kind: "pong"; from: string; to: string; t: number; now: number };

class Clocks {
  #me: string;
  #offsets = new Map<string, { offset: number; rtt: number; at: number }>();

  constructor(me: string) {
    this.#me = me;
    OBR.broadcast.onMessage(CH_CLOCK, e => {
      const m = e.data as ClockMsg;
      if (m.to !== me) return;
      if (m.kind === "ping") {
        OBR.broadcast.sendMessage(CH_CLOCK, { kind: "pong", from: me, to: m.from, t: m.t, now: Date.now() } satisfies ClockMsg, { destination: "REMOTE" });
      } else {
        const back = Date.now();
        const rtt = back - m.t;
        const prev = this.#offsets.get(m.from);
        // Keep the sample with the shortest round trip (least noise), renewed every few minutes.
        if (!prev || rtt <= prev.rtt || back - prev.at > 300_000) {
          this.#offsets.set(m.from, { offset: m.now - (m.t + back) / 2, rtt, at: back });
        }
      }
    });
  }

  /** That GM's clock now, as best known (exact for ourselves). */
  now(gm: string): number {
    return Date.now() + (gm === this.#me ? 0 : this.#offsets.get(gm)?.offset ?? 0);
  }

  /** Measure the offset to `gm`: a few pings now, more over time. */
  watch(gm: string): void {
    if (gm === this.#me) return;
    const ping = () =>
      OBR.broadcast.sendMessage(CH_CLOCK, { kind: "ping", from: this.#me, to: gm, t: Date.now() } satisfies ClockMsg, { destination: "REMOTE" }).catch(() => undefined);
    if (!this.#offsets.has(gm)) for (const d of [0, 400, 1200, 3000]) setTimeout(ping, d);
    else ping();
  }
}

// ---------------------------------------------------------------------------

interface Sound {
  /** Volume 0–1 (before the listener's own volume). */
  setVolume(v: number): void;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  time(): number;
  duration(): number;
  dispose(): void;
  ready: Promise<void>;
  onEnded: (() => void) | null;
  onError: ((msg: string) => void) | null;
}

class FileSound implements Sound {
  readonly el = new Audio();
  ready: Promise<void>;
  onEnded: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  constructor(url: string, loop: boolean) {
    this.el.preload = "auto";
    this.el.loop = loop;
    this.el.src = url;
    this.el.addEventListener("ended", () => this.onEnded?.());
    this.ready = new Promise(resolve => {
      this.el.addEventListener("loadedmetadata", () => resolve(), { once: true });
      this.el.addEventListener("error", () => {
        this.onError?.("cannot load this link");
        resolve();
      }, { once: true });
    });
  }
  setVolume(v: number) { this.el.volume = Math.min(1, Math.max(0, v)); }
  play() { this.el.play().catch(() => this.onError?.("blocked")); }
  pause() { this.el.pause(); }
  seek(sec: number) { this.el.currentTime = sec; }
  time() { return this.el.currentTime; }
  duration() { return this.el.duration; }
  dispose() {
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
  }
}

/* The YouTube IFrame API, loaded once. */
interface YTPlayer {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, allowAhead: boolean): void; setVolume(v: number): void;
  getCurrentTime(): number; getDuration(): number; destroy(): void;
}
declare global {
  interface Window { YT?: { Player: new (el: HTMLElement, o: object) => YTPlayer }; onYouTubeIframeAPIReady?: () => void }
}
let ytApi: Promise<void> | null = null;
function loadYouTube(): Promise<void> {
  ytApi ??= new Promise(resolve => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytApi;
}

const YT_ERRORS: Record<number, string> = {
  2: "invalid video id", 5: "cannot play in this player", 100: "video not found or private",
  101: "the owner does not allow it to play outside YouTube", 150: "the owner does not allow it to play outside YouTube",
};

class YouTubeSound implements Sound {
  ready: Promise<void>;
  onEnded: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  #player: YTPlayer | null = null;
  #host = document.createElement("div");
  #loop: boolean;

  constructor(id: string, loop: boolean) {
    this.#loop = loop;
    document.body.appendChild(this.#host);
    const mount = document.createElement("div");
    this.#host.appendChild(mount);
    // Kept on the page (YouTube asks for a real-sized player) but out of sight.
    Object.assign(this.#host.style, { position: "fixed", left: "-10000px", top: "0", width: "320px", height: "180px" });
    this.ready = loadYouTube().then(() => new Promise<void>(resolve => {
      this.#player = new window.YT!.Player(mount, {
        videoId: id, width: 320, height: 180,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => resolve(),
          onStateChange: (e: { data: number }) => {
            if (e.data !== 0) return; // 0 = ended
            if (this.#loop) {
              this.#player?.seekTo(0, true);
              this.#player?.playVideo();
            } else this.onEnded?.();
          },
          onError: (e: { data: number }) => {
            this.onError?.(YT_ERRORS[e.data] ?? `YouTube error ${e.data}`);
            resolve();
          },
        },
      });
    }));
  }
  setVolume(v: number) { this.#player?.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)); }
  play() { this.#player?.playVideo(); }
  pause() { this.#player?.pauseVideo(); }
  seek(sec: number) { this.#player?.seekTo(sec, true); }
  time() { return this.#player?.getCurrentTime() ?? 0; }
  duration() { return this.#player?.getDuration() || NaN; }
  dispose() {
    this.#player?.destroy();
    this.#host.remove();
  }
}

// ---------------------------------------------------------------------------

/** One link voice playing in this browser. */
class LinkVoice {
  readonly key: string;
  #sound: Sound;
  #voice: Voice;
  #gain = 0;
  #fadeTimer: ReturnType<typeof setInterval> | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #now: () => number;
  #listener: () => number;
  #fadingOut = false;
  #started = false;
  disposed = false;
  onEnded: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  constructor(voice: Voice, now: () => number, listener: () => number) {
    this.#voice = voice;
    this.#now = now;
    this.#listener = listener;
    this.key = `${voice.src}|${voice.t0}|${voice.off}`;
    this.#sound = voice.src.startsWith("yt:") ? new YouTubeSound(voice.src.slice(3), voice.repeat) : new FileSound(voice.src, voice.repeat);
    this.#sound.onEnded = () => this.onEnded?.();
    this.#sound.onError = msg => this.onError?.(msg);
    this.#sound.setVolume(0);
    this.#sound.ready.then(() => this.#begin());
  }

  #begin(): void {
    if (this.disposed) return;
    const wait = this.#voice.t0 - this.#now();
    if (wait > 0) {
      this.#timers.push(setTimeout(() => this.#begin(), wait));
      return;
    }
    const pos = position(this.#voice, this.#now(), this.#sound.duration());
    if (pos === null) return this.onEnded?.();
    this.#sound.seek(Math.max(0, pos));
    this.#sound.play();
    this.#started = true;
    const elapsed = this.#now() - this.#voice.t0;
    this.#fade(this.#voice.vol, Math.max(400, this.#voice.fade - elapsed));
    // Stay in step: seek back when this browser drifts from where the GM's clock says the track is.
    this.#timers.push(setInterval(() => this.#resync(), 5000) as unknown as ReturnType<typeof setTimeout>);
    this.#scheduleEndFade();
  }

  #resync(): void {
    if (!this.#started || this.#fadingOut) return;
    const want = position(this.#voice, this.#now(), this.#sound.duration());
    if (want === null || want < 0) return;
    if (Math.abs(this.#sound.time() - want) > 0.5) this.#sound.seek(want);
  }

  /** A non-repeating track fades out over its last `fade` ms. */
  #scheduleEndFade(): void {
    const v = this.#voice;
    const d = this.#sound.duration();
    if (v.repeat || !v.fade || !Number.isFinite(d)) return;
    const left = (d - this.#sound.time()) * 1000 - v.fade;
    this.#timers.push(setTimeout(() => this.#fade(0, v.fade), Math.max(0, left)));
  }

  /** S-curve fade of the track volume (applied together with the listener's own volume). */
  #fade(to: number, ms: number): void {
    if (this.#fadeTimer) clearInterval(this.#fadeTimer);
    const from = this.#gain;
    const start = performance.now();
    const step = () => {
      const x = ms <= 0 ? 1 : Math.min(1, (performance.now() - start) / ms);
      this.#gain = from + (to - from) * (1 - Math.cos(Math.PI * x)) / 2;
      this.applyVolume();
      if (x >= 1 && this.#fadeTimer) {
        clearInterval(this.#fadeTimer);
        this.#fadeTimer = null;
      }
    };
    this.#fadeTimer = setInterval(step, 50);
    step();
  }

  applyVolume(): void {
    this.#sound.setVolume(this.#gain * this.#listener());
  }

  update(voice: Voice): void {
    const prev = this.#voice;
    this.#voice = voice;
    if (voice.stop !== undefined && !this.#fadingOut) {
      this.#fadingOut = true;
      const left = Math.max(0, voice.stop + voice.fade - this.#now());
      this.#fade(0, left);
      this.#timers.push(setTimeout(() => this.dispose(), left + 200));
    } else if (!this.#fadingOut && this.#started && voice.vol !== prev.vol) this.#fade(voice.vol, 300);
  }

  progress(): { time: number; duration: number } {
    return { time: this.#sound.time(), duration: this.#sound.duration() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.#timers) clearTimeout(t);
    if (this.#fadeTimer) clearInterval(this.#fadeTimer);
    this.#sound.dispose();
  }
}

/**
 * Plays every GM's link voices in this browser. `onEnded(gm, trackId, voice)` fires when a
 * non-repeating link reaches its end (the GM who owns it moves the playlist on).
 */
export class LinkPlayer {
  #me: string;
  #clocks: Clocks;
  #voices = new Map<string, LinkVoice>(); // `${gm}/${trackId}`
  #listener = 0.8;
  onEnded: ((gm: string, trackId: string, v: Voice) => void) | null = null;
  onError: ((gm: string, name: string, msg: string) => void) | null = null;

  constructor(me: string) {
    this.#me = me;
    this.#clocks = new Clocks(me);
  }

  /** The listener's own volume (gain 0–1). */
  setVolume(g: number): void {
    this.#listener = g;
    for (const v of this.#voices.values()) v.applyVolume();
  }

  /** Follow the room: `voices[gm][trackId]` for every GM present. */
  follow(all: Record<string, Record<string, Voice>>): void {
    const live = new Set<string>();
    for (const [gm, voices] of Object.entries(all)) {
      this.#clocks.watch(gm);
      const now = () => this.#clocks.now(gm);
      for (const [id, v] of Object.entries(voices)) {
        const key = `${gm}/${id}`;
        const cur = this.#voices.get(key);
        const sounding = v.paused === undefined && !isExpired(v, now());
        if (cur && !cur.disposed && cur.key === `${v.src}|${v.t0}|${v.off}` && sounding) {
          cur.update(v);
          live.add(key);
          continue;
        }
        cur?.dispose();
        this.#voices.delete(key);
        if (!sounding || v.stop !== undefined) continue;
        const lv = new LinkVoice(v, now, () => this.#listener);
        lv.onEnded = () => this.onEnded?.(gm, id, v);
        lv.onError = msg => this.onError?.(gm, v.name, msg);
        this.#voices.set(key, lv);
        live.add(key);
      }
    }
    for (const [key, lv] of this.#voices) {
      if (!live.has(key)) {
        lv.dispose();
        this.#voices.delete(key);
      }
    }
  }

  /** Every voice here and where it is, plus the GM-clock time (for debugging from the console). */
  snapshot(): Record<string, { time: number; duration: number; gmNow: number }> {
    const out: Record<string, { time: number; duration: number; gmNow: number }> = {};
    for (const [key, lv] of this.#voices) out[key] = { ...lv.progress(), gmNow: this.#clocks.now(key.split("/")[0]) };
    return out;
  }

  /** Progress of this browser's own voices (for the GM's window). */
  progress(): Record<string, { time: number; duration: number }> {
    const out: Record<string, { time: number; duration: number }> = {};
    for (const [key, lv] of this.#voices) if (key.startsWith(`${this.#me}/`)) out[key.slice(this.#me.length + 1)] = lv.progress();
    return out;
  }
}

/** All GMs' link voices from the room metadata, keeping only GMs who are here. */
export function linkVoicesFrom(metadata: Record<string, unknown>, present: Set<string>): Record<string, Record<string, Voice>> {
  const out: Record<string, Record<string, Voice>> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!k.startsWith(`${VOICES_KEY}/`)) continue;
    const gm = k.slice(VOICES_KEY.length + 1);
    if (present.has(gm) && v && typeof v === "object") out[gm] = v as Record<string, Voice>;
  }
  return out;
}
