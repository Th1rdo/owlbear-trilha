# Trilha for Owlbear Rodeo

Playlists from your own MP3/WAV files, the way Foundry VTT does them — and the whole table hears them.

**Install:** in Owlbear Rodeo, open *Extensions → Add custom extension* and paste

```
https://th1rdo.github.io/owlbear-trilha/manifest.json
```

Then turn it on in your room. Accept the **autoplay** permission it asks for: that is what lets your
players hear the music without clicking anything.

## How it works

- **Your music stays on your computer.** Dropping files into a playlist copies them into this browser's
  storage (nothing is uploaded anywhere). The same library is there in every room you open in this
  browser. Another computer or browser starts empty.
- **Players hear it live through your browser.** Your browser plays the playlists and streams the mix
  straight to each player (WebRTC, stereo 256 kbps). Nothing to download on their side; someone who joins
  late hears the song from where it is.
- So **music plays while your Owlbear tab is open** — close it and the music stops for everyone.
- **Or paste a link** (the *Link* button): a YouTube video, or a link to an audio file (Dropbox and Google
  Drive share links work too). YouTube won't let a page take its sound, so these aren't streamed: each
  player's browser plays the link itself, kept at the same point as yours (clocks are matched to the GM's,
  and anyone drifting more than half a second is put back in place). Some YouTube videos are blocked
  from playing outside YouTube by their owner; Trilha tells you when that happens.

## Features (as in Foundry)

- Playlists with **Manual** (each track on its own), **Sequential**, **Shuffle** and **All at once** modes.
- Play / pause / stop per track; play, stop, next and previous per playlist; per-track volume; repeat.
- **Fade** per playlist. Switching tracks in a sequential or shuffle playlist fades the old one out
  completely and brings the new one in as it ends (no overlap; *Settings* sets when it comes in).
- Files and links can share a playlist; the hand-over works between them.
- **Intro + loop** (files only): with Repeat on, set *Loop start* and *Loop end* on a track — the intro plays once,
  then only that section repeats, gaplessly.
- Everyone has their own volume slider (in the extension's window). Players see what is playing.
- Portuguese or English, following the browser.

## Development

```
npm install
npm run dev        # http://localhost:5174/owlbear-trilha/manifest.json → add it to Owlbear
npm test           # playlist rules
```

`vite --config vite.harness.config.ts` runs the same app outside Owlbear, with `test/fake-obr.ts` standing
in for the SDK: open `http://localhost:5175/owlbear-trilha/test/harness.html?role=GM` and `?role=PLAYER`
in two tabs.

Pushing to `main` builds and publishes to GitHub Pages.
