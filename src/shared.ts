import type { Action, Playback } from "./logic.ts";

/**
 * Names and messages shared by the popover and the background page.
 *
 * The GM's music never leaves the GM's computer: the files sit in this browser (IndexedDB), the
 * background page plays them, and the mix is streamed live to every player over WebRTC. Owlbear's
 * broadcast messages carry only the WebRTC handshake; its room metadata carries only the names of
 * what is playing (for the players' window).
 */
export const ID = "pt.th1rdo.trilha";
/** OBR.broadcast channel for the WebRTC handshake. */
export const CH_SIGNAL = `${ID}/signal`;
/** Room metadata key prefix: `${NOW_KEY}/<connectionId>` → what that GM is playing. */
export const NOW_KEY = `${ID}/now`;

/** One entry of a GM's "now playing" list, as players see it. */
export interface NowPlaying {
  name: string;
  playlist: string;
}

/** Popover ⇄ background, inside one browser (same origin, so a BroadcastChannel reaches both). */
export type LocalMessage =
  | { type: "act"; action: Action }
  | { type: "library-changed" }
  | { type: "hello" }
  | { type: "volume"; value: number }
  | { type: "retry" }
  | {
      type: "state";
      playback: Playback;
      progress: Record<string, { time: number; duration: number }>;
      listeners: number;
      blocked: boolean;
    }
  | { type: "receiver"; connected: number; blocked: boolean };

export function localChannel(onMessage: (m: LocalMessage) => void): (m: LocalMessage) => void {
  const bc = new BroadcastChannel(ID);
  bc.onmessage = e => onMessage(e.data as LocalMessage);
  return m => bc.postMessage(m);
}

// ---------------------------------------------------------------------------
// Per-browser music volume (each person sets their own)

const VOLUME_KEY = `${ID}/volume`;
export function readMyVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    return raw === null ? 0.8 : Math.min(1, Math.max(0, Number(raw) || 0));
  } catch {
    return 0.8;
  }
}
export function saveMyVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    // Storage blocked: applies to this visit only.
  }
}

// ---------------------------------------------------------------------------
// Playback survives a reload of the GM's page: starts are stamped with this computer's clock.

const PLAYBACK_KEY = `${ID}/playback`;
export function readSavedPlayback(): Playback | null {
  try {
    const raw = localStorage.getItem(PLAYBACK_KEY);
    return raw ? (JSON.parse(raw) as Playback) : null;
  } catch {
    return null;
  }
}
export function savePlayback(pb: Playback): void {
  try {
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify(pb));
  } catch {
    // Not fatal: a reload just starts silent.
  }
}
