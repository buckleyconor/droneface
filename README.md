# Drone Swarm Face

A single offline HTML file that renders a talking-head face made of ~2,870
glowing turquoise drones (three.js / WebGL). Drones drift when idle; press
**Start** and they fly into a 3D face you can turn by dragging. The face is
shaded by dot density (denser on the nose, lips, cheekbones and jaw rim, sparser
in the sockets) with wavy bottle-green hair strands over the crown. The mouth
moves with audio amplitude and spectral brightness (or a synthetic demo voice),
over a morphing two-chord ambient pad. Includes a text box + **Generate voice**
button that speaks via the browser's `speechSynthesis` until a real TTS endpoint
is wired in (qwen3-tts style).

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

    npm test             # headless Chromium self-test (42 assertions)

Covers the state machine, face geometry (eye/nose/mouth centroids, blink squash,
jaw drop), drag orientation limits, ambient toggle, lip-sync DSP (adaptive gain +
sibilant-driven lip width), the TTS wire format against a fake `fetch`, and 10
consecutive disperse/reform cycles.

## Layout

    src/main.js            application code (ordered per spec §13)
    src/index.html         markup + styles; template for the built file
    build.js               esbuild bundle + inline into drone-face.html
    tools/selftest.html    self-test harness
    tools/run-selftest.mjs node runner (serves the repo, drives Chromium)

## JS API (`window.DroneFace`)

    start()  disperse()  state  attachAudio(src)  speakFromUrl(url)  speak(text)
    setEndpoint(url)  setVoice(name)  attachStream()  setMouth(open, width)
    setAmbient(on)  ambient  setOrientationLimits({yaw, pitch})  on(event, cb)

`attachStream()` is a v1 stub returning `{ push(chunk), end() }`; it exists so a
future streaming backend needs no change to the face code.

## TTS endpoint (the only external dependency)

`speak(text)` POSTs `{"text","voice","response_format":"wav"}` to the endpoint
configured with `DroneFace.setEndpoint(url)` (persisted in localStorage). The
response may be an audio body (`audio/wav|mpeg|ogg`) or JSON with an
`audio_base64`/`audio`/`data` field. If the call fails, the page falls back to the
browser's `speechSynthesis`. The wire format lives only in `requestTTS()`.

## Tuning

Face shape constants are in `FACE` (src/main.js): ellipsoid half-axes, feature
positions/sizes, and the Gaussian relief list. Colours are in `CONFIG`
(`colorFace` turquoise `#19e6d3`, `colorHair` bottle green `#0b7a56`, `colorRim`
cyan-white `#7ff5ea`). These were set from the measurements in
`reference-image-notes.md`; visual tuning against `reference_image.png` still
needs a human eye — the automated tests verify geometry, not aesthetics.

## Notes

- Bundle: ~485 KB minified JS (~126 KB gzipped), under the 500 KB spec cap.
  three.js's WebGL renderer pulls in env-map/PMREM code that cannot be cleanly
  tree-shaken from the flat module build, so it lands above the spec's optimistic
  150–250 KB estimate.
- Drag rotation is limited to yaw ±35° / pitch ±25° so the unmodelled back of the
  head is never visible.
- The mouth is amplitude + spectral-brightness driven (not viseme-accurate);
  visemes are a documented future upgrade behind the `setMouth` seam.
