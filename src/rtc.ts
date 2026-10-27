import OBR from "@owlbear-rodeo/sdk";
import { CH_SIGNAL } from "./shared.ts";

/**
 * Live music over WebRTC, with Owlbear's broadcast messages as the handshake.
 *
 * A **station** (a GM's background page) sends its mix to everyone. A **receiver** (every background
 * page, GMs' too) plays what each station sends. Receivers say "hello" when they load and whenever a
 * station announces itself, so a station that reloads, or a player who joins late, connects at once.
 */
type Signal =
  | { kind: "hello"; from: string; to?: string }
  | { kind: "station"; from: string }
  | { kind: "offer" | "answer"; from: string; to: string; sdp: string }
  | { kind: "bye"; from: string };

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }],
};
const BITRATE = 256_000;

const send = (s: Signal) => OBR.broadcast.sendMessage(CH_SIGNAL, s, { destination: "REMOTE" });

/**
 * Descriptions are sent whole, with every candidate in them (no trickle): a second slower to
 * connect, but no candidate can arrive before the offer it belongs to.
 */
function gathered(pc: RTCPeerConnection): Promise<string> {
  return new Promise(resolve => {
    const done = () => resolve(pc.localDescription!.sdp);
    if (pc.iceGatheringState === "complete") return done();
    const timer = setTimeout(done, 2500);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        done();
      }
    });
  });
}

/** Music, not voice: stereo, high bitrate (browsers default to mono ~32 kbps). */
function tuneOpus(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} (.*)`), (_, params: string) => {
    const kept = params.split(";").map(p => p.trim()).filter(p => p && !/^(stereo|sprop-stereo|maxaveragebitrate|cbr)=/.test(p));
    return `a=fmtp:${pt} ${[...kept, "stereo=1", "sprop-stereo=1", `maxaveragebitrate=${BITRATE}`].join(";")}`;
  });
}

/**
 * Someone left the room. Only people seen in the party before count: a newcomer's hello can arrive
 * before Owlbear lists them, and they must not be dropped for that.
 */
function onLeave(fn: (id: string) => void): void {
  const known = new Set<string>();
  OBR.party.onChange(players => {
    const here = new Set(players.map(p => p.connectionId));
    for (const id of known) if (!here.has(id)) fn(id);
    known.clear();
    for (const id of here) known.add(id);
  });
}

function onSignal(me: string, fn: (s: Signal) => void): () => void {
  return OBR.broadcast.onMessage(CH_SIGNAL, e => {
    const s = e.data as Signal;
    if (!s || s.from === me || ("to" in s && s.to && s.to !== me)) return;
    fn(s);
  });
}

// ---------------------------------------------------------------------------

export class Station {
  #me: string;
  #track: MediaStreamTrack;
  #peers = new Map<string, RTCPeerConnection>();
  onChange: (() => void) | null = null;

  constructor(me: string, stream: MediaStream) {
    this.#me = me;
    this.#track = stream.getAudioTracks()[0];
    onSignal(me, s => this.#on(s));
    onLeave(id => this.#close(id));
    window.addEventListener("pagehide", () => send({ kind: "bye", from: me }));
    send({ kind: "station", from: me });
  }

  /** Players currently connected. */
  get listeners(): number {
    return [...this.#peers.values()].filter(pc => pc.connectionState === "connected").length;
  }

  async #on(s: Signal): Promise<void> {
    if (s.kind === "hello") return this.#offer(s.from);
    const pc = this.#peers.get(s.from);
    if (!pc) return;
    if (s.kind === "answer") await pc.setRemoteDescription({ type: "answer", sdp: s.sdp }).catch(e => console.warn("[Trilha]", e));
    else if (s.kind === "bye") this.#close(s.from);
  }

  async #offer(to: string): Promise<void> {
    this.#close(to);
    const pc = new RTCPeerConnection(ICE);
    this.#peers.set(to, pc);
    const sender = pc.addTrack(this.#track, new MediaStream([this.#track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.#close(to);
      this.onChange?.();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: tuneOpus(offer.sdp ?? "") });
    const params = sender.getParameters();
    if (params.encodings?.length) {
      params.encodings[0].maxBitrate = BITRATE;
      await sender.setParameters(params).catch(() => undefined);
    }
    send({ kind: "offer", from: this.#me, to, sdp: await gathered(pc) });
  }

  #close(id: string): void {
    this.#peers.get(id)?.close();
    this.#peers.delete(id);
    this.onChange?.();
  }
}

// ---------------------------------------------------------------------------

export class Receiver {
  #me: string;
  #peers = new Map<string, { pc: RTCPeerConnection; el: HTMLAudioElement }>();
  #volume = 1;
  blocked = false;
  onChange: (() => void) | null = null;

  constructor(me: string) {
    this.#me = me;
    onSignal(me, s => this.#on(s));
    onLeave(id => this.#close(id));
    send({ kind: "hello", from: me });
    // Hellos can cross a station that is still starting (everyone reloading at once): while nothing
    // is connected or on its way, ask again.
    setInterval(() => {
      if (this.connected || Date.now() - this.#lastOffer < 10_000) return;
      send({ kind: "hello", from: me });
    }, 5000);
  }

  #lastOffer = 0;

  /** Stations currently heard. */
  get connected(): number {
    return [...this.#peers.values()].filter(p => p.pc.connectionState === "connected").length;
  }

  setVolume(gain: number): void {
    this.#volume = gain;
    for (const { el } of this.#peers.values()) el.volume = gain;
  }

  /** Try again to start sound the browser blocked. */
  retry(): void {
    for (const { el } of this.#peers.values()) this.#play(el);
  }

  async #on(s: Signal): Promise<void> {
    if (s.kind === "station") return void send({ kind: "hello", from: this.#me, to: s.from });
    if (s.kind === "bye") return this.#close(s.from);
    if (s.kind === "offer") return this.#answer(s.from, s.sdp);
  }

  async #answer(station: string, sdp: string): Promise<void> {
    this.#lastOffer = Date.now();
    this.#close(station);
    const pc = new RTCPeerConnection(ICE);
    const el = new Audio();
    el.autoplay = true;
    el.volume = this.#volume;
    this.#peers.set(station, { pc, el });
    pc.ontrack = e => {
      el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      this.#play(el);
    };
    pc.onconnectionstatechange = () => {
      this.onChange?.();
      if (pc.connectionState === "failed") {
        // Ask again in a moment (network change, the station's computer slept…).
        this.#close(station);
        setTimeout(() => send({ kind: "hello", from: this.#me, to: station }), 3000);
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: "answer", sdp: tuneOpus(answer.sdp ?? "") });
    send({ kind: "answer", from: this.#me, to: station, sdp: await gathered(pc) });
  }

  #play(el: HTMLAudioElement): void {
    el.play().then(() => {
      if (this.blocked) {
        this.blocked = false;
        this.onChange?.();
      }
    }).catch(() => {
      if (!this.blocked) {
        this.blocked = true;
        this.onChange?.();
      }
      // Chrome blocks sound until the person clicks somewhere in Owlbear; keep trying until then.
      setTimeout(() => {
        if (el.srcObject && el.paused) this.#play(el);
      }, 1500);
    });
  }

  #close(id: string): void {
    const p = this.#peers.get(id);
    if (!p) return;
    p.pc.close();
    p.el.srcObject = null;
    this.#peers.delete(id);
    this.onChange?.();
  }
}
