import { test } from "node:test";
import assert from "node:assert/strict";
import { act, emptyPlayback, formatTime, MODE, parseTime, playbackOrder, position, type Library, type Playback } from "./logic.ts";

const lib = (mode: -1 | 0 | 1 | 2 = MODE.SEQUENTIAL, fade = 4000): Library => ({
  v: 1, entrada: 75,
  playlists: [{
    id: "p", name: "P", mode, fade,
    tracks: ["a", "b", "c"].map(id => ({ id, name: id.toUpperCase(), src: `sb:${id}.mp3`, vol: 0.5, repeat: false })),
  }],
});

test("playAll starts the first track now", () => {
  const pb = act(lib(), emptyPlayback(), { action: "playAll", pl: "p" }, 1000);
  assert.deepEqual(Object.keys(pb.voices), ["a"]);
  assert.equal(pb.voices.a.t0, 1000);
});

test("Trilha hand-over: old fades out, new starts at 75% of the fade", () => {
  let pb = act(lib(), emptyPlayback(), { action: "play", pl: "p", tr: "a" }, 0);
  pb = act(lib(), pb, { action: "play", pl: "p", tr: "b" }, 10_000);
  assert.equal(pb.voices.a.stop, 10_000);
  assert.equal(pb.voices.b.t0, 13_000);
  // After the fade, the old voice is dropped on the next action.
  pb = act(lib(), pb, { action: "volume", pl: "p", tr: "b", vol: 0.3 }, 14_001);
  assert.deepEqual(Object.keys(pb.voices), ["b"]);
});

test("switching during a pending start replaces it without waiting again", () => {
  let pb = act(lib(), emptyPlayback(), { action: "play", pl: "p", tr: "a" }, 0);
  pb = act(lib(), pb, { action: "play", pl: "p", tr: "b" }, 10_000); // b scheduled at 13 000
  pb = act(lib(), pb, { action: "play", pl: "p", tr: "c" }, 11_000);
  assert.equal(pb.voices.b, undefined); // never sounded: removed
  assert.equal(pb.voices.a.stop, 10_000); // keeps its original fade-out
  assert.equal(pb.voices.c.t0, 13_000); // waits for the fade-out already running
});

test("manual mode adds tracks on top of each other", () => {
  let pb = act(lib(MODE.MANUAL), emptyPlayback(), { action: "play", pl: "p", tr: "a" }, 0);
  pb = act(lib(MODE.MANUAL), pb, { action: "play", pl: "p", tr: "b" }, 500);
  assert.equal(pb.voices.a.stop, undefined);
  assert.equal(pb.voices.b.t0, 500);
});

test("pause keeps the position; play resumes from it", () => {
  let pb = act(lib(), emptyPlayback(), { action: "play", pl: "p", tr: "a" }, 0);
  pb = act(lib(), pb, { action: "pause", pl: "p", tr: "a" }, 12_500);
  assert.equal(pb.voices.a.paused, 12.5);
  pb = act(lib(), pb, { action: "playAll", pl: "p" }, 20_000);
  assert.equal(pb.voices.a.off, 12.5);
  assert.equal(pb.voices.a.paused, undefined);
});

test("ended advances once, and only for the matching playback", () => {
  let pb = act(lib(), emptyPlayback(), { action: "play", pl: "p", tr: "c" }, 0);
  const stale = act(lib(), pb, { action: "ended", pl: "p", tr: "c", t0: 999 }, 5000);
  assert.deepEqual(Object.keys(stale.voices), ["c"]);
  pb = act(lib(), pb, { action: "ended", pl: "p", tr: "c", t0: 0 }, 5000);
  assert.deepEqual(Object.keys(pb.voices), ["a"]); // wraps around
  assert.equal(pb.voices.a.t0, 5000);
});

test("simultaneous plays everything; stopAll fades all", () => {
  let pb: Playback = act(lib(MODE.SIMULTANEOUS), emptyPlayback(), { action: "playAll", pl: "p" }, 0);
  assert.equal(Object.keys(pb.voices).length, 3);
  pb = act(lib(MODE.SIMULTANEOUS), pb, { action: "stopAll", pl: "p" }, 100);
  assert.ok(Object.values(pb.voices).every(v => v.stop === 100));
});

test("shuffle order is the same for the same seed", () => {
  const p = lib(MODE.SHUFFLE).playlists[0];
  assert.deepEqual(playbackOrder(p, 42), playbackOrder(p, 42));
  assert.deepEqual([...playbackOrder(p, 42)].sort(), ["a", "b", "c"]);
});

test("intro + loop position wraps only the loop region", () => {
  const v = { pl: "p", name: "", src: "", vol: 1, repeat: true, ls: 10, le: 30, fade: 0, t0: 0, off: 0 };
  assert.equal(position(v, 5_000, 60), 5);
  assert.equal(position(v, 35_000, 60), 15); // 35 → 10 + (25 % 20)
  assert.equal(position({ ...v, repeat: false }, 70_000, 60), null);
  assert.equal(position({ ...v, ls: null, le: null }, 70_000, 60), 10);
  assert.ok(position(v, -1000, 60)! < 0);
});

test("time parsing", () => {
  assert.equal(parseTime("1:11.213"), 71.213);
  assert.equal(parseTime("0:06,25"), 6.25);
  assert.equal(parseTime("40"), 40);
  assert.equal(parseTime("x"), null);
  assert.equal(formatTime(71.213), "1:11.213");
});
