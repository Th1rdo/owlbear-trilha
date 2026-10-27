import OBR from "@owlbear-rodeo/sdk";
import { Engine, Instance, sliderToGain } from "./engine.ts";
import { act, emptyPlayback, isActive, isExpired, refreshVoices, type Action, type Library, type Playback } from "./logic.ts";
import { Receiver, Station } from "./rtc.ts";
import { localChannel, NOW_KEY, readMyVolume, readSavedPlayback, savePlayback, type LocalMessage, type NowPlaying } from "./shared.ts";
import { loadLibrary } from "./store.ts";

/**
 * Runs for as long as the room is open, in every browser (the popover comes and goes).
 * Everyone: receive the GMs' music and play it at this person's volume.
 * GMs: also play the playlists from this browser's library and stream the mix to the table.
 */
OBR.onReady(async () => {
  const me = await OBR.player.getConnectionId();
  const receiver = new Receiver(me);
  let conductor: Conductor | null = null;
  let volume = readMyVolume();
  receiver.setVolume(sliderToGain(volume));

  const post = localChannel(m => {
    if (m.type === "volume") {
      volume = m.value;
      receiver.setVolume(sliderToGain(volume));
      conductor?.engine.setVolume(volume);
    } else if (m.type === "retry") {
      receiver.retry();
      conductor?.engine.resume();
    } else if (m.type === "hello") {
      reportReceiver();
      conductor?.report();
    } else if (m.type === "act") conductor?.apply(m.action);
    else if (m.type === "library-changed") conductor?.reloadLibrary();
  });

  const reportReceiver = () => {
    post({ type: "receiver", connected: receiver.connected, blocked: receiver.blocked });
    updateBadge();
  };
  receiver.onChange = reportReceiver;

  const updateBadge = () => {
    const blocked = receiver.blocked || !!conductor?.engine.blocked;
    OBR.action.setBadgeText(blocked ? "!" : undefined).catch(() => undefined);
  };

  const becomeGM = async () => {
    if (conductor) return;
    conductor = new Conductor(me, post, volume, updateBadge);
    await conductor.start();
  };
  // For debugging from the console of the background frame.
  Object.assign(globalThis, { trilha: { receiver, get conductor() { return conductor; } } });
  if ((await OBR.player.getRole()) === "GM") await becomeGM();
  OBR.player.onChange(p => {
    if (p.role === "GM") becomeGM();
  });
});

/** The GM side: plays the library and streams it. */
class Conductor {
  readonly engine: Engine;
  #me: string;
  #post: (m: LocalMessage) => void;
  #onBlocked: () => void;
  #lib: Library = { v: 1, playlists: [], entrada: 75 };
  #pb: Playback = emptyPlayback();
  #instances = new Map<string, Instance>();
  #station: Station | null = null;
  #lastNow = "";

  constructor(me: string, post: (m: LocalMessage) => void, volume: number, onBlocked: () => void) {
    this.#me = me;
    this.#post = post;
    this.#onBlocked = onBlocked;
    this.engine = new Engine(volume);
  }

  async start(): Promise<void> {
    await this.engine.resume();
    this.engine.ctx.addEventListener("statechange", () => this.#onBlocked());
    this.#onBlocked();
    this.#lib = await loadLibrary().catch(() => this.#lib);
    this.#pb = refreshVoices(this.#lib, readSavedPlayback() ?? emptyPlayback());
    await this.#clearStaleNowPlaying();
    this.#station = new Station(this.#me, this.engine.stream.stream);
    this.#station.onChange = () => this.report();
    this.#sync();
    setInterval(() => this.#tick(), 1000);
  }

  apply(a: Action): void {
    this.engine.resume();
    this.#pb = act(this.#lib, this.#pb, a, Date.now());
    savePlayback(this.#pb);
    this.#sync();
  }

  async reloadLibrary(): Promise<void> {
    this.#lib = await loadLibrary();
    this.#pb = refreshVoices(this.#lib, this.#pb);
    savePlayback(this.#pb);
    this.#sync();
  }

  /** Make the sound match the playback state. */
  #sync(): void {
    const now = Date.now();
    for (const [id, inst] of this.#instances) {
      const v = this.#pb.voices[id];
      if (v && Instance.keyOf(v) === inst.key && v.paused === undefined) continue;
      // Gone, paused, or restarted: a pause or removal cuts quickly; a restart replaces it.
      inst.fadeOut(300);
      this.#instances.delete(id);
    }
    for (const [id, v] of Object.entries(this.#pb.voices)) {
      const inst = this.#instances.get(id);
      if (inst) {
        inst.update(v);
        continue;
      }
      if (v.paused !== undefined || v.stop !== undefined || isExpired(v, now)) continue;
      const fresh = new Instance(this.engine, v);
      fresh.onEnded = () => this.apply({ action: "ended", pl: v.pl, tr: id, t0: v.t0 });
      this.#instances.set(id, fresh);
    }
    this.report();
    this.#publishNowPlaying();
  }

  #tick(): void {
    const now = Date.now();
    const expired = Object.entries(this.#pb.voices).filter(([, v]) => isExpired(v, now));
    if (expired.length) {
      const voices = { ...this.#pb.voices };
      for (const [id] of expired) delete voices[id];
      this.#pb = { ...this.#pb, voices };
      savePlayback(this.#pb);
      this.#sync();
    } else if (this.#instances.size) this.report();
  }

  /** Tell this browser's popover what is playing and where. */
  report(): void {
    const progress: Record<string, { time: number; duration: number }> = {};
    for (const [id, inst] of this.#instances) progress[id] = { time: inst.currentTime(), duration: inst.duration };
    this.#post({
      type: "state", playback: this.#pb, progress,
      listeners: this.#station?.listeners ?? 0, blocked: this.engine.blocked,
    });
  }

  /** "Now playing" entries of GMs no longer here (a reload gets a new connection id). */
  async #clearStaleNowPlaying(): Promise<void> {
    const here = new Set((await OBR.party.getPlayers()).map(p => p.connectionId));
    here.add(this.#me);
    const stale = Object.keys(await OBR.room.getMetadata())
      .filter(k => k.startsWith(`${NOW_KEY}/`) && !here.has(k.slice(NOW_KEY.length + 1)));
    if (stale.length) await OBR.room.setMetadata(Object.fromEntries(stale.map(k => [k, undefined]))).catch(() => undefined);
  }

  /** Players' windows show the names of what is playing (room metadata, per GM). */
  #publishNowPlaying(): void {
    const list: NowPlaying[] = Object.values(this.#pb.voices).filter(isActive).map(v => ({
      name: v.name,
      playlist: this.#lib.playlists.find(p => p.id === v.pl)?.name ?? "",
    }));
    const json = JSON.stringify(list);
    if (json === this.#lastNow) return;
    this.#lastNow = json;
    OBR.room.setMetadata({ [`${NOW_KEY}/${this.#me}`]: list.length ? list : undefined }).catch(() => undefined);
  }
}
