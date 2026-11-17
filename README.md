# Drone Swarm Face

A single offline HTML file that renders a talking-head face made of ~3,920
glowing turquoise drones (three.js / WebGL). Drones drift when idle; press
**Start** and they fly into a 3D face you can turn by dragging. The face is
shaded by dot density (denser on the nose, lips, cheekbones and jaw rim, sparser
in the sockets), sampled on a hexagonal lattice over a profile-curve head, with
wavy lavender hair strands following the silhouette. The mouth
moves with audio amplitude and spectral brightness (or a synthetic demo voice),
over a looping music bed. Includes a text box + **Generate voice** button that
speaks via the browser's `speechSynthesis` until a real TTS endpoint is wired in
(qwen3-tts style).

- Spec: `Drone Swarm Face Frontend Development Spec.md` (v0.3)
- Reference image: `reference_image.png` (+ text notes in `reference-image-notes.md`)

## Build

    npm install          # once
    npm run build        # -> drone-face.html (the deliverable, single file)
    npm run dev          # -> dist/bundle.js; open src/index.html (or serve)

## Run

Open `drone-face.html` directly in a browser (no network needed), or:

    python3 -m http.server 8080     # then open http://localhost:8080/drone-face.html

## Test

    npm test             # headless Chromium self-test (53 assertions)
    npm run check:voice  # every voice path, against real rendering
    npm run check:sound  # music bed, master mute, ducking, real gestures

`npm test` covers the state machine, face geometry (eye/nose/mouth centroids, blink
squash, jaw drop), drag orientation limits, sound toggle, lip-sync DSP (adaptive gain +
sibilant-driven lip width), the TTS wire format against a fake `fetch`, the voice
fallback, and 10 consecutive disperse/reform cycles.

`npm run check:voice` serves the repo plus fake TTS endpoints (legacy body, OpenAI body,
SSE stream, 404) and drives the built page over CDP, asserting that every way the face can
talk actually moves the mouth and reports what it did. If the lab's qwen3-tts box answers on
port 8091 it is tested too, against the real model. It is separate from `npm test` because
it needs real timing and a real audio decode — under `--dump-dom` the audio clock never
advances.

Two of its assertions look at the rendered page rather than at JavaScript values: the mouth
shader uniforms are read back, and a pair of screenshots taken across the mouth opening is
compared against two same-state pairs, so the test fails if the animation variables move but
the swarm on screen does not. A build once passed every JS-level lip-sync assertion while the
face sat motionless, because `mouthOpen` was computed correctly and never assigned to the
uniform that drives it.

`npm run check:sound` drives the built page with real mouse clicks: nothing plays before a
gesture, the speaker button mutes the music bed and nothing else, the bed ducks under speech
and comes back, and no oscillator is ever constructed (the generated chord pad is gone, not
hidden).

## Layout

    src/main.js            application code (ordered per spec §13)
    src/index.html         markup + styles + music bed; template for the built file
    4ever-faded.mp3        background music track (embedded by build.js)
    build.js               esbuild bundle + inline into drone-face.html
    tools/selftest.html    self-test harness
    tools/run-selftest.mjs node runner (serves the repo, drives Chromium)
    tools/inject-music.mjs add/refresh the music bed in a built HTML file
    tools/remove-chord.mjs strip the retired chord pad from a built HTML file
    tools/voice-paths-check.mjs  end-to-end voice/lip-sync check (npm run check:voice)
    tools/sound-behaviour-check.mjs  music bed and master mute check (npm run check:sound)

## JS API (`window.DroneFace`)

    start()  disperse()  state  attachAudio(src)  speakFromUrl(url)  speak(text)  stop()
    setEndpoint(url)  setVoice(name)  setModel(name)  voiceStatus()  attachStream(rate)
    setMouth(open, width)
    setSound(on)  sound  setOrientationLimits({yaw, pitch})  on(event, cb)

`setAmbient(on)` and `ambient` still work as deprecated aliases for `setSound` and
`sound`; they are the sound toggle's state, which mutes the music and never the
voice.

`attachStream(sampleRate)` returns `{ push(chunk), end(), stop() }` — a working
playback sink for a backend that delivers audio in pieces. `speak()` uses it
internally for the SSE stream.

## Voice and lip sync

The mouth is driven by the audio, not by the text. Whatever makes the sound, the same
`AnalyserNode` measures it: RMS becomes `mouthOpen`, and the 2–8 kHz to 180 Hz–2 kHz
energy ratio becomes `lipWidth`, so sibilants widen the lips instead of the mouth
pulsing like a metronome.

Point the face at a TTS server with the **slider icon** left of the text box — endpoint
URL, model, voice, persisted, and seedable as `?endpoint=…&model=…&voice=…` so a room can
be configured without devtools — or with `DroneFace.setEndpoint(url)` in the console.
`speak(text)` then POSTs:

- to an OpenAI-compatible URL (anything matching `/audio/speech` or a bare `/v1`, which is
  how vLLM and most qwen3-tts deployments are served):
  `{"model":"…","input":"…","voice":"…","response_format":"wav"}`
- to anything else, the shape this project started with:
  `{"text":"…","voice":"…","response_format":"wav"}`

The response can be an audio body (`audio/wav|mpeg|ogg`) or JSON with a base64 field
(`output.audio`, `audio_base64`, `audio`, `data`, `b64`). The whole wire format lives in
`requestTTS()`.

Shipped defaults (`CONFIG.tts`), verified against the lab box — port 8091, vllm-omni
serving `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` as `qwen3-tts`, 24 kHz mono WAV, CORS wide
open so it works from `file://`.

**It streams by default.** Against an OpenAI-style URL the page asks for
`stream: true, response_format: "pcm"`, reads the `speech.audio.delta` SSE events and
schedules each chunk as it lands, so the mouth starts about **1 s** after the click instead
of 2 s. `attachStream()` exposes the same sink for any other transport (WebSocket, gRPC) —
push `Int16Array`/`Float32Array`/`ArrayBuffer` chunks, then `end()`. The status line reports
`first sound at N ms`; if the server won't stream, the page falls back to a complete file
without telling you.

**The voice list comes from the server** (`GET {origin}/v1/audio/voices`) when it answers, so
a redeployed model with different voices needs no change here; `CONFIG.tts.voices` is the
offline fallback, and the status line says how many voices it found and where from. Leaving
the endpoint field blank means "use the browser voice".

The panel also turns that list into **chips**: click one and the face says
*"A swarm of drones, holding formation in the dark."* in that voice, which is the only
practical way to compare nine of them.

**The mouth is never still.** If the endpoint is unreachable or unset the page falls back
to the browser's `speechSynthesis`; if that has no voice to give (the normal answer on a
Linux demo box — it accepts `speak()` and then says nothing forever), a synthetic envelope
moves the mouth for a duration estimated from the text, so the face keeps talking to the
room. The status line under the voice bar and `DroneFace.voiceStatus()` say which path ran
and why — `mode` is `tts`, `browser-tts`, `simulated` or `fallback`, with the failure
reason in `detail`. A silent fallback was the original bug: the TTS error was swallowed by
a `catch` and nothing moved. `DroneFace.stop()` cuts all three paths.

The music bed never enters the analyser, so it cannot move the mouth; the voice is never
muted by the speaker button.

## Background music

`4ever-faded.mp3` (28 s loop, 96 kbps, 330 KB) is the only sound the page makes on
its own. `build.js` embeds it as a base64 data URI, so the deliverable stays a single
file (~950 KB, of which ~440 KB is the track). It replaced the generated two-chord
pad, which is deleted rather than muted — nothing in the page creates an oscillator
any more.

- One control: the **speaker** button (bottom right) mutes the music. The voice is
  never muted, so "no music, face still talking" is just the normal state of the page.
  `DroneFace.setSound(false)` does the same thing; `setAmbient` is its old name.
- Browsers will not start audible audio without a user gesture, so the page tries to
  play on load and otherwise starts on the first click or key press — in practice the
  **Start** button. The icon shows the saved preference, not whether audio has
  started: if the very first click of a session lands on the speaker, it sets the
  preference to off rather than starting playback.
- The bed ducks to 35% while the face speaks (via the `speechStart`/`speechEnd`
  events) and returns afterwards; otherwise it plays at volume 0.20. The choice
  persists in `localStorage['droneface.ambient']`.
- To add or refresh the bed in an HTML file that did not come from `npm run build`
  (a hand-tuned `drone-face-cl2.html`, say): `node tools/inject-music.mjs <file>`.
  It reads the block from `src/index.html`, so there is one source of truth. Use
  `node tools/remove-chord.mjs <file>` on such a file too — the chord lives in the
  bundled app code, and that is the only way to reach it in a minified build.

## Tuning

Face shape lives in `FACE` and the generator (src/main.js §2): the `pchip`
profile curves for the half-width and the depth, the cranium dome, the nose
profile, the Gaussian relief list, and the density map that thins the lattice.
Counts are targets — the generator iterates the lattice spacing to hit them, so
`counts.face: 3640` emits about 3,030 surface drones. Colours are in `CONFIG`
(`colorFace` turquoise `#19e6d3`, `colorHair` lavender `#d9b8f0` — the accent
group: hair, brows, lid rims, lip peaks — `colorRim` cyan-white `#7ff5ea`).
`?accent=lavender|ice|warm` switches the accent at load, no rebuild. Point size
is `CONFIG.pointFraction` (fraction of viewport height). These came from the
measurements in `reference-image-notes.md`; visual tuning against
`reference_image.png` still needs a human eye — the automated tests verify
geometry, not aesthetics.

## Notes

- Bundle: ~492 KB minified JS (~126 KB gzipped), under the 500 KB spec cap.
  three.js's WebGL renderer pulls in env-map/PMREM code that cannot be cleanly
  tree-shaken from the flat module build, so it lands above the spec's optimistic
  150–250 KB estimate. The embedded music track is on top of that.
- Drag rotation is limited to yaw ±35° / pitch ±25° so the unmodelled back of the
  head is never visible.
- The mouth is amplitude + spectral-brightness driven (not viseme-accurate);
  visemes are a documented future upgrade behind the `setMouth` seam.
