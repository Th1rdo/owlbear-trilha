import { loopRegion, position, type Voice } from "./logic.ts";
import { urlFor } from "./store.ts";

/**
 * The GM's sound: one AudioContext, one Instance per voice, all summed into `mix`. The mix goes two
 * ways — to the GM's speakers through `local` (the GM's own volume) and, at full level, to `stream`,
 * which WebRTC sends to the players (each sets their own volume on their side).
 * Repeating tracks are decoded into a buffer so the loop is gapless and an intro + loop region is
 * sample-exact; everything else streams from an <audio> element.
 */

/** Sliders are perceptual: position p plays at p^1.5 (the quiet end gets more travel). */
export const sliderToGain = (p: number) => Math.pow(Math.min(1, Math.max(0, p)), 1.5);
export const gainToSlider = (g: number) => Math.pow(Math.min(1, Math.max(0, g)), 1 / 1.5);

/** An S-curve from `from` to `to` (sounds smoother than linear or logarithmic fades). */
function sCurve(from: number, to: number, n = 64): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = from + (to - from) * (1 - Math.cos((Math.PI * i) / (n - 1))) / 2;
  return c;
}

export class Engine {
  readonly ctx = new AudioContext();
  readonly mix = this.ctx.createGain();
  readonly local = this.ctx.createGain();
  readonly stream = this.ctx.createMediaStreamDestination();
  #buffers = new Map<string, Promise<AudioBuffer>>();

  constructor(volume: number) {
    this.mix.connect(this.local).connect(this.ctx.destination);
    this.mix.connect(this.stream);
    this.setVolume(volume);
  }

  get blocked(): boolean {
    return this.ctx.state !== "running";
  }

  resume(): Promise<void> {
    return this.ctx.resume().catch(() => undefined);
  }

  /** Context time at which clock time `t` (ms, Date.now) happens. */
  ctxTimeAt(t: number): number {
    return this.ctx.currentTime + (t - Date.now()) / 1000;
  }

  /** The GM's own speakers only; the stream to the players is unaffected. */
  setVolume(slider: number): void {
    this.local.gain.setTargetAtTime(sliderToGain(slider), this.ctx.currentTime, 0.05);
  }

  /** Decoded buffers, a few kept (the current tracks and the one before). */
  buffer(url: string): Promise<AudioBuffer> {
    let p = this.#buffers.get(url);
    if (!p) {
      p = fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      }).then(b => this.ctx.decodeAudioData(b));
      p.catch(() => this.#buffers.delete(url));
      this.#buffers.set(url, p);
      while (this.#buffers.size > 4) this.#buffers.delete(this.#buffers.keys().next().value!);
    }
    return p;
  }

  /** Ramp a gain to `to` over `ms`, beginning at context time `at` (default now). */
  fade(g: AudioParam, to: number, ms: number, at = this.ctx.currentTime): void {
    const t = Math.max(at, this.ctx.currentTime);
    g.cancelScheduledValues(t);
    const from = g.value;
    g.setValueAtTime(from, t);
    if (ms < 20 || Math.abs(from - to) < 1e-4) g.setValueAtTime(to, t + 0.001);
    else g.setValueCurveAtTime(sCurve(from, to), t + 0.001, ms / 1000);
  }
}

/** One voice sounding in this browser. */
export class Instance {
  /** Identifies the playback: a restart (new t0/offset/file) is a new instance. */
  readonly key: string;
  readonly gain: GainNode;
  duration = NaN;
  #engine: Engine;
  #voice: Voice;
  #el: HTMLAudioElement | null = null;
  #node: AudioBufferSourceNode | MediaElementAudioSourceNode | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #startedCtx = 0;
  #startedPos = 0;
  #fadingOut = false;
  disposed = false;
  /** A non-repeating file reached its end (the playlist may move on). */
  onEnded: (() => void) | null = null;

  static keyOf(v: Voice): string {
    return `${v.src}|${v.t0}|${v.off}`;
  }

  constructor(engine: Engine, voice: Voice) {
    this.#engine = engine;
    this.#voice = voice;
    this.key = Instance.keyOf(voice);
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(engine.mix);
    this.#start().catch(e => console.warn("[Trilha]", voice.name, e));
  }

  async #start(): Promise<void> {
    const e = this.#engine;
    const v = this.#voice;
    const url = await urlFor(v.src);
    if (this.disposed) return;
    if (v.repeat) {
      const buf = await e.buffer(url);
      if (this.disposed) return;
      this.duration = buf.duration;
      const pos = position(v, Date.now(), buf.duration);
      if (pos === null) return;
      const src = e.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const region = loopRegion(v, buf.duration);
      if (region) [src.loopStart, src.loopEnd] = region;
      src.connect(this.gain);
      // Not started yet (a hand-over): schedule it on the context clock, from its own offset.
      const when = pos < 0 ? e.ctxTimeAt(v.t0) : e.ctx.currentTime;
      const from = pos < 0 ? v.off : pos;
      src.start(when, from);
      this.#node = src;
      this.#startedCtx = when;
      this.#startedPos = from;
      this.#fadeIn(when);
      return;
    }
    const el = new Audio();
    el.crossOrigin = "anonymous"; // links to other sites must allow it, or the Web Audio graph stays silent
    el.preload = "auto";
    el.addEventListener("ended", () => this.onEnded?.());
    el.src = url;
    this.#el = el;
    this.duration = await new Promise<number>(resolve => {
      el.addEventListener("loadedmetadata", () => resolve(el.duration), { once: true });
      el.addEventListener("error", () => resolve(NaN), { once: true });
    });
    if (this.disposed) return;
    if (el.error) throw new Error(`cannot load ${url}`);
    this.#node = e.ctx.createMediaElementSource(el);
    this.#node.connect(this.gain);
    const begin = () => {
      if (this.disposed) return;
      const pos = position(v, Date.now(), this.duration);
      if (pos === null) return this.onEnded?.();
      el.currentTime = Math.max(v.off, pos);
      el.play().catch(err => console.warn("[Trilha] play blocked", err));
      this.#fadeIn(e.ctx.currentTime);
      this.#scheduleEndFade();
    };
    const wait = v.t0 - Date.now(); // ms until the start (a hand-over)
    if (wait > 0) this.#timers.push(setTimeout(begin, wait));
    else begin();
  }

  /** Fade in from the start; a late joiner gets the rest of the fade (or a short one). */
  #fadeIn(at: number): void {
    const v = this.#voice;
    const intoFade = Math.max(0, Date.now() - v.t0);
    const left = Math.max(400, v.fade - intoFade);
    this.gain.gain.setValueAtTime(0, at);
    this.#engine.fade(this.gain.gain, v.vol, left, at);
  }

  /** A non-repeating track fades out over its last `fade` ms (as Foundry does). */
  #scheduleEndFade(): void {
    const v = this.#voice;
    const el = this.#el;
    if (!el || v.repeat || !v.fade || !Number.isFinite(this.duration)) return;
    const left = (this.duration - el.currentTime) * 1000 - v.fade;
    this.#timers.push(setTimeout(() => this.fadeOut(v.fade), Math.max(0, left)));
  }

  /** The voice's settings changed without restarting it (volume, or a fade-out began). */
  update(voice: Voice): void {
    const prev = this.#voice;
    this.#voice = voice;
    if (voice.stop !== undefined && !this.#fadingOut) {
      const left = voice.stop + voice.fade - Date.now();
      this.fadeOut(Math.max(0, left));
      return;
    }
    if (!this.#fadingOut && voice.vol !== prev.vol) this.#engine.fade(this.gain.gain, voice.vol, 300);
    if (this.#node instanceof AudioBufferSourceNode && (voice.ls !== prev.ls || voice.le !== prev.le)) {
      const region = loopRegion(voice, this.duration);
      if (region) [this.#node.loopStart, this.#node.loopEnd] = region;
      else [this.#node.loopStart, this.#node.loopEnd] = [0, 0];
    }
  }

  fadeOut(ms: number): void {
    if (this.disposed) return;
    this.#fadingOut = true;
    this.#engine.fade(this.gain.gain, 0, ms);
    this.#timers.push(setTimeout(() => this.dispose(), ms + 100));
  }

  /** Where this browser is in the file (seconds), for the progress bar. */
  currentTime(): number {
    if (this.#el) return this.#el.currentTime;
    if (this.#node instanceof AudioBufferSourceNode) {
      const t = this.#startedPos + Math.max(0, this.#engine.ctx.currentTime - this.#startedCtx);
      const region = loopRegion(this.#voice, this.duration);
      if (region) return t < region[1] ? t : region[0] + ((t - region[0]) % (region[1] - region[0]));
      return Number.isFinite(this.duration) && this.duration > 0 ? t % this.duration : t;
    }
    return 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.#timers) clearTimeout(t);
    try {
      if (this.#node instanceof AudioBufferSourceNode) this.#node.stop();
    } catch {
      // Never started.
    }
    if (this.#el) {
      this.#el.pause();
      this.#el.removeAttribute("src");
      this.#el.load();
    }
    this.#node?.disconnect();
    this.gain.disconnect();
  }
}
