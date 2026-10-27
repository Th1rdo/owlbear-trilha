import OBR from "@owlbear-rodeo/sdk";
import { Engine, Instance, sliderToGain } from "./engine.ts";
import { act, emptyPlayback, isActive, isExpired, refreshVoices, type Action, type Library, type Playback, type Voice } from "./logic.ts";
import { isLink, LinkPlayer, linkVoicesFrom } from "./links.ts";
import { Receiver, Station } from "./rtc.ts";
import { localChannel, NOW_KEY, readMyVolume, readSavedPlayback, savePlayback, VOICES_KEY, type LocalMessage, type NowPlaying } from "./shared.ts";
import { loadLibrary } from "./store.ts";

/**
 * Runs for as long as the room is open, in every browser (the popover comes and goes).
 * Everyone: receive the GMs' streamed music, and play their link tracks, at this person's volume.
 * GMs: also play the playlists from this browser's library and stream the files' mix to the table.
 */
OBR.onReady(async () => {
  const me = await OBR.player.getConnectionId();
  const receiver = new Receiver(me);
  const links = new LinkPlayer(me);
  let conductor: Conductor | null = null;
  let volume = readMyVolume();
  receiver.setVolume(sliderToGain(volume));
  links.setVolume(sliderToGain(volume));

  // Link tracks: follow what every GM in the room publishes.
  let metadata = await OBR.room.getMetadata();
  let present = new Set([me, ...(await OBR.party.getPlayers()).map(p => p.connectionId)]);
  const followLinks = () => links.follow(linkVoicesFrom(metadata, present));
  OBR.room.onMetadataChange(md => {
    metadata = md;
    followLinks();
  });
  OBR.party.onChange(players => {
    present = new Set([me, ...players.map(p => p.connectionId)]);
    followLinks();
  });
  links.onEnded = (gm, id, v) => {
    if (gm === me) conductor?.apply({ action: "ended", pl: v.pl, tr: id, t0: v.t0 });
  };
  const reported = new Set<string>();
  links.onError = (gm, name, msg) => {
    if (gm !== me || reported.has(`${name}|${msg}`)) return;
    reported.add(`${name}|${msg}`);
    OBR.notification.show(`Trilha — ${name}: ${msg}`, "WARNING");
  };

  const post = localChannel(m => {
    if (m.type === "volume") {
      volume = m.value;
      receiver.setVolume(sliderToGain(volume));
      links.setVolume(sliderToGain(volume));
      conductor?.engine.setVolume(volume);
    } else if (m.type === "retry") {
      receiver.retry();
      links.retry();
      conductor?.engine.resume();
    } else if (m.type === "hello") {
      reportReceiver();
      conductor?.report();
    } else if (m.type === "act") conductor?.apply(m.action);
    else if (m.type === "library-changed") conductor?.reloadLibrary();
  });

  const reportReceiver = () => {
    post({ type: "receiver", connected: receiver.connected, blocked: receiver.blocked || links.blocked });
    updateBadge();
  };
  receiver.onChange = reportReceiver;
  // Links report being blocked by polling; keep the window and the badge up to date.
  let linksBlocked = false;
  setInterval(() => {
    if (links.blocked !== linksBlocked) {
      linksBlocked = links.blocked;
      reportReceiver();
    }
  }, 1000);

  const updateBadge = () => {
    const blocked = receiver.blocked || links.blocked || !!conductor?.engine.blocked;
    OBR.action.setBadgeText(blocked ? "!" : undefined).catch(() => undefined);
  };

  const becomeGM = async () => {
    if (conductor) return;
    conductor = new Conductor(me, post, volume, updateBadge, () => links.progress());
    await conductor.start();
  };
  // For debugging from the console of the background frame.
  Object.assign(globalThis, { trilha: { receiver, links, get conductor() { return conductor; } } });
  followLinks();
  if ((await OBR.player.getRole()) === "GM") await becomeGM();
  OBR.player.onChange(p => {
    if (p.role === "GM") becomeGM();
  });
});

/** The GM side: plays the library's files and streams them; publishes its link tracks for every browser. */
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
  #lastVoices = "";
  #linkProgress: () => Record<string, { time: number; duration: number }>;

  constructor(me: string, post: (m: LocalMessage) => void, volume: number, onBlocked: () => void,
    linkProgress: () => Record<string, { time: number; duration: number }>) {
    this.#me = me;
    this.#post = post;
    this.#onBlocked = onBlocked;
    this.#linkProgress = linkProgress;
    this.engine = new Engine(volume);
  }

  async start(): Promise<void> {
    await this.engine.resume();
    this.engine.ctx.addEventListener("statechange", () => this.#onBlocked());
    this.#onBlocked();
    // Until the GM has clicked somewhere in Owlbear, Chrome keeps the audio suspended: keep asking.
    setInterval(() => {
      if (this.engine.blocked) this.engine.resume();
    }, 1500);
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
      if (v.paused !== undefined || v.stop !== undefined || isExpired(v, now) || isLink(v.src)) continue;
      const fresh = new Instance(this.engine, v);
      fresh.onEnded = () => this.apply({ action: "ended", pl: v.pl, tr: id, t0: v.t0 });
      this.#instances.set(id, fresh);
    }
    this.report();
    this.#publishNowPlaying();
    this.#publishLinkVoices();
  }

  /** Link tracks are played by every browser: publish them (timing included) in the room. */
  #publishLinkVoices(): void {
    const voices: Record<string, Voice> = {};
    for (const [id, v] of Object.entries(this.#pb.voices)) if (isLink(v.src) && v.paused === undefined) voices[id] = v;
    const json = JSON.stringify(voices);
    if (json === this.#lastVoices) return;
    this.#lastVoices = json;
    OBR.room.setMetadata({ [`${VOICES_KEY}/${this.#me}`]: Object.keys(voices).length ? voices : undefined }).catch(() => undefined);
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
    } else if (this.#instances.size || Object.keys(this.#pb.voices).length) this.report();
  }

  /** Tell this browser's popover what is playing and where. */
  report(): void {
    const progress: Record<string, { time: number; duration: number }> = this.#linkProgress();
    for (const [id, inst] of this.#instances) progress[id] = { time: inst.currentTime(), duration: inst.duration };
    this.#post({
      type: "state", playback: this.#pb, progress,
      listeners: this.#station?.listeners ?? 0, blocked: this.engine.blocked,
    });
  }

  /** Entries of GMs no longer here (a reload gets a new connection id). */
  async #clearStaleNowPlaying(): Promise<void> {
    const here = new Set((await OBR.party.getPlayers()).map(p => p.connectionId));
    here.add(this.#me);
    const stale = Object.keys(await OBR.room.getMetadata()).filter(k => {
      const prefix = [NOW_KEY, VOICES_KEY].find(p => k.startsWith(`${p}/`));
      return prefix && !here.has(k.slice(prefix.length + 1));
    });
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
