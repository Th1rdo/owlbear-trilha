import { test } from "node:test";
import assert from "node:assert/strict";
import { isLink, parseLink } from "./link-parse.ts";

test("YouTube links in their usual shapes", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  ]) assert.equal(parseLink(url)?.src, "yt:dQw4w9WgXcQ", url);
  assert.equal(parseLink("https://www.youtube.com/watch?v=short"), null);
});

test("direct, Dropbox and Drive links", () => {
  assert.deepEqual(parseLink("https://example.com/music/Battle%20Theme.mp3"), { src: "https://example.com/music/Battle%20Theme.mp3", name: "Battle Theme" });
  assert.equal(parseLink("https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&dl=0")?.src, "https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&raw=1");
  assert.equal(parseLink("https://drive.google.com/file/d/ABC123/view?usp=sharing")?.src, "https://drive.google.com/uc?export=download&id=ABC123");
  assert.equal(parseLink("not a link"), null);
  assert.equal(parseLink("ftp://x/y.mp3"), null);
});

test("which sources are links", () => {
  assert.ok(isLink("yt:dQw4w9WgXcQ"));
  assert.ok(isLink("https://x/y.mp3"));
  assert.ok(!isLink("local:1234"));
});
