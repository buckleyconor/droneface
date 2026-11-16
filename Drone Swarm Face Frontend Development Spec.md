# Drone Swarm Face: Frontend Development Spec

Version 0.3 (draft) | 16 November 2026

## 1. Overview

A single, standalone HTML page that renders a face made of a swarm of glowing turquoise drones against a dark sky. On load the drones drift randomly. When the user presses **Start**, the drones fly into formation as a 3D face. The user can turn the face by dragging. The page is the frontend for a planned application in which a text-to-speech (TTS) LLM provides the voice and the face's mouth moves in sync with the audio.

The visual reference (see `reference_image.png` in this directory) is a night-time drone-show face: a dense surface of small lights, brightest at the silhouette edges, with sparser drones forming the hair band.

## 2. Goals and non-goals

**Goals**

- Visually convincing drone-swarm look (individual points of light, not a solid surface).
- Smooth idle-to-formation transition triggered by a Start button, and a disperse action that returns the swarm to free flight so it can re-form repeatedly.
- Mouse (and touch) drag to turn the face, limited to the front of the face.
- Amplitude- and brightness-driven mouth movement (jaw drop plus lip width) that can be connected to any audio source.
- One self-contained `.html` file that works offline.

**Non-goals (v1)**

- Full 360° head rotation.
- Phoneme/viseme-accurate lip sync.
- The TTS/LLM backend service itself (the frontend's client call to it is in scope; see section 11).
- Facial expressions beyond mouth open/close and blinking (listed as future work).

## 3. Decisions confirmed

| Topic | Decision |
| --- | --- |
| Face data source | Procedural/parametric face generated in code (no external mesh) |
| Packaging | Fully offline: three.js inlined in the HTML file |
| Lip sync | Audio amplitude only: simple jaw/mouth open-close |
| Renderer | three.js (WebGL) |
| Colour | Face turquoise; hair band bottle green; dark background |
| Face look | Generic, neutral face; not modelled on a specific person |
| Swarm lifecycle | Can disperse back to free flight and re-form, repeatedly |
| Ambient sound | Included, with a control to turn it off and on |
| Audio delivery | Undecided (complete files or streaming); the frontend supports both through one interface |
| TTS call | Frontend POSTs text to a configurable qwen3-tts style endpoint; offline fallback to the browser's `speechSynthesis` |

## 4. Technical direction

**Rendering: three.js with `THREE.Points` and a custom shader.** Each drone is one point. A `ShaderMaterial` draws each point as a soft round glow with additive blending. This handles 8,000 to 15,000 drones at 60 fps on typical hardware, because positions are animated on the GPU rather than in JavaScript.

**Why not alternatives**

- *Plain Canvas 2D*: no real depth, and slow at this point count.
- *Mesh per drone*: far too many draw calls; `Points` or `InstancedMesh` is needed anyway.
- *Raw WebGL*: more code with no benefit for this project.

**Packaging note (offline, single file).** Current three.js releases ship as ES modules, so a plain `<script src>` of a minified build is no longer available. Recommended approach:

1. Develop with `index.html` plus `main.js` importing `three`.
2. Use a bundler (esbuild is the simplest) to produce one minified script.
3. Use a small build script to inline that script into the final `drone-face.html`.

Only the parts of three.js that are needed (renderer, scene, camera, `Points`, `BufferGeometry`, `ShaderMaterial`, `Color`) should be imported so the file stays small (roughly 150 to 250 KB after minification).

## 5. User experience and states

The application is a simple state machine.

| State | Description | Exit condition |
| --- | --- | --- |
| `IDLE` | Drones fly slowly at random. Centred **Start** button visible (labelled **Reform** after a dispersal). Pointer drag does nothing. | Start or Reform pressed |
| `FORMING` | Each drone travels from its free-flight position to its assigned face position. Centred button fades out. | Transition complete (about 4 s) |
| `ACTIVE` | Face formed. Drag to turn. Subtle shimmer and breathing. Small Disperse control visible. | Speech begins, or Disperse pressed |
| `SPEAKING` | As `ACTIVE`, plus the mouth drones move with audio amplitude. Disperse is unavailable. | Speech ends |
| `DISPERSING` | Drones leave the face and rejoin the random drift; face orientation eases back to centre. | Transition complete (about 3 s), then `IDLE` |

The flow is a loop: `DISPERSING` returns to `IDLE`, and Start (shown as Reform) forms the face again. No page reload is needed, and the cycle can repeat any number of times.

**Layout**

- Full-viewport canvas, dark background.
- The face occupies roughly 75 to 85% of the viewport height, centred.
- Start button: centred, minimal, turquoise outline with subtle glow; hover and focus states required; keyboard accessible.
- Disperse control: a small, unobtrusive text button in a corner, visible only in `ACTIVE`; keyboard accessible. After dispersal the centred button returns, labelled Reform.
- Sound toggle: a small speaker icon button in the opposite corner, visible in every state; keyboard accessible, with an accessible label ("Sound on" or "Sound off") and a clear on/off icon state.
- Voice control: a text box (bottom centre) and a **Generate voice** button. Typing text and pressing the button forms the face (if needed) and speaks the words using the browser's `speechSynthesis` as the demo voice, with the mouth moving to a synthetic speech envelope until a real TTS endpoint is wired in.

## 6. Visual design

- **Background:** near-black blue, `#02060d`, optionally with a very faint vertical gradient.
- **Face drone colour (turquoise):** `#19e6d3`. Per-drone variation: shift hue slightly toward cyan `#2ad0ff` and lightness by ±10% to give a shimmering surface.
- **Hair drone colour (bottle green):** base `#18c990`, with the same ±10% lightness variation — brightened so the hair band reads clearly against the dark background; the value is a tunable constant judged by eye.
- **Edge emphasis:** drones on silhouette edges (where the surface normal is perpendicular to the view direction) render brighter and slightly larger, tinted toward cyan-white `#7ff5ea`. This reproduces the bright rim in `reference_image.png`.
- **Depth cue:** points farther from the camera are slightly dimmer and smaller.
- **Relief shading:** protruding areas (nose bridge/tip, cheekbones, brow edge) are brighter and recessed areas (eye sockets, nostrils, under the brow and lower lip, sides of the nose) are dimmer — the reference shades by dot brightness and density, not by lighting.
- **Point look:** soft circular sprite generated in the fragment shader (bright core, quick falloff), additive blending, depth write off.
- **Twinkle:** per-drone sine flicker, 2 to 4% brightness amplitude, random phase.
- **Point size:** scales with viewport height and device pixel ratio so the look is the same on any screen. Capped to avoid overdraw.

## 7. Procedural face generation

The face is generated once at page load (target under 300 ms) as a set of 3D target positions plus a per-point attribute set.

**Look: generic.** The face is neutral and gender-neutral, with no resemblance to a real person: moderate brow and cheekbone relief, an average-width straight nose, medium lips, a rounded chin, and a hair outline with no specific hairstyle. Each feature is a named parameter group at the top of the file (for example `noseLength`, `lipFullness`, `jawWidth`) so the look can be tuned without changing the generator logic.

**Method (recommended): signed-distance or height-field head.**

1. Define a base head as a face-shaped outline: a vertical half-height of 1.0 (hair crest y +1, chin y -1) and a depth of 0.55, with a half-width profile that is widest at the cheekbones (0.60) and narrows toward the forehead (0.52) and jaw/chin (down to 0.24) — so it is not a symmetric egg. Feature positions, measured from `reference_image.png` and expressed as a fraction of head height from the hair crest (0%) to the chin (100%): hairline 16%, eye line 49%, nose tip 68%, mouth line 82%; eye width 23% of face width, eye-centre separation 57%, nose width 26%, mouth width 39%. See `reference-image-notes.md` for the full measurement set.
2. Add facial relief using smooth Gaussian bumps and dips:
   - brow ridge, eye sockets, nose bridge, nose tip and nostrils, cheekbones, upper and lower lip, chin, jaw line.
3. Sample points on the front surface using a jittered grid, then thin them by a density field that is denser on protruding features (nose bridge/tip, lips, cheekbones, jaw rim) and sparser in recesses (eye sockets, nostrils, mouth line) — shading by dot density, as in the reference, rather than drawn-on lines.
4. Add secondary groups:
   - **Hair:** wavy bottle-green strands flowing over the crown (see section 6), named `hair` in the attributes.
   - **Eyes:** a small dense cluster of drones tracing the eyelid rim around each eye socket. These are the blink group: a blink moves them toward the socket centre (with a slight dim), then back.
5. Each point stores attributes: `target` (vec3), `group` (`face`, `hair`, `mouth`, `eye`), `mouthWeight` (0 to 1), `blinkWeight` (0 to 1, nonzero on eyelid drones), `reserve` (0 or 1; reserve drones are hidden while dispersed), `seed` (random), `edgeFactor`.

**Mouth region.** Points within an elliptical region around the lips get `mouthWeight` greater than 0. Weight is 1 at the lower lip and jaw, falling smoothly to 0 at the mouth boundary. Upper lip has a small weight so the mouth opens mostly by jaw drop.

**Drone counts (defaults)**

| Group | Count |
| --- | --- |
| Face surface (density-shaded) | 2,240 |
| Hair strands | 490 |
| Eyes | 140 |
| Total | about 2,870 |

About 28.5% of drones are marked `reserve` and stay hidden while dispersed, so the start screen shows ~50% and the formed face ~70% of the previous density. The total is a constant at the top of the file. A quality setting should scale it down on weak GPUs (see section 11).

**Design risk.** A procedural face can look generic or uncanny. Mitigation: build a small debug view (flat lit, no animation) early, and tune the relief parameters against `reference_image.png`. If the result is not good enough, the data source can be swapped for a mesh-sampled point set without changing anything else, because the rest of the system only consumes the `target` array.

## 8. Animation

All motion is computed in the vertex shader from uniforms, so JavaScript only updates a handful of values per frame.

**Idle flight**

- Each drone has a random start position inside a volume about the size of the viewport (and a depth range of about ±1.5 units).
- Motion: slow drift using the per-drone `seed` (independent per-drone frequencies); speed roughly 0.02 to 0.08 units per second.
- Some depth variation so the swarm reads as 3D.

**Formation (`FORMING`)**

- Uniform `uForm` goes from 0 to 1 over about 6 seconds.
- Each drone starts at a staggered delay (0 to 1.2 s, derived from `seed` and optionally distance from the face centre, so the face assembles from the middle outward or randomly; to be chosen visually).
- Position = `mix(freePosition, target, easeInOutCubic(t))`.
- Add a small curved offset (perpendicular wobble) during travel so paths are not straight lines.
- On arrival, drones settle with a small overshoot damped over about 0.5 s.

**Active shimmer**

- Each drone jitters by a tiny amplitude (about 0.002 units) to look like real drones holding position.
- Slow global "breathing" scale of about 0.5%.

**Blink (eyelid drones)**

- While the face is formed (`ACTIVE` and `SPEAKING`), eyelid drones blink every 3 to 6 seconds (randomised): they move from their open position toward the eye-socket centre and back over about 0.15 to 0.25 s, with a slight dim.

**Dispersal (`DISPERSING`)**

- Triggered by the Disperse control or `DroneFace.disperse()`; not available while `SPEAKING`.
- `uForm` goes from 1 to 0 over about 4 seconds with a per-drone stagger (0 to 0.8 s). Position = `mix(target, driftPosition(time), easeInOutCubic(t))`.
- The idle drift position is a pure function of time and each drone's `seed`, so drones leave the face and join the drift with no position jump. Re-forming uses the same blend in the other direction, starting from wherever each drone currently is.
- Face orientation (yaw and pitch) eases back to 0 during the first second, and `mouthOpen` is forced to 0.
- Repeated cycles must not accumulate offsets, stuck drones or memory growth.

## 9. Interaction: head orientation

- Input: pointer drag (mouse and touch) on the canvas. Pointer events are used so one code path covers both.
- Mapping: horizontal drag changes yaw, vertical drag changes pitch.
- **Limits (defaults):** yaw ±35°, pitch ±25°. These are constants. The limits keep the back of the head (which is not modelled) from ever being visible.
- Soft limits: movement slows as it approaches the limit (rubber-band effect) rather than hard-stopping.
- Smoothing: current orientation follows the target with exponential damping (about 0.1 s time constant).
- Behaviour on release: orientation holds, then optionally eases back to centre after 3 s of no input (configurable; default on).
- The rotation is applied as a model rotation in the shader or on the `Points` object, with the camera fixed. Dragging is disabled until the state is `ACTIVE`.
- Drag does not select text or trigger browser gestures (`touch-action: none` on the canvas).

## 10. Lip sync (amplitude-driven)

**Approach.** Analyse the audio in real time and map it to two values between 0 and 1: `mouthOpen` (loudness) and `lipWidth` (spectral brightness). The vertex shader displaces mouth drones by `mouthWeight * mouthOpen` and lip-corner drones by `lipWidth`.

**Audio pipeline**

1. Audio source: an `HTMLAudioElement`, a `MediaStream`, or an `AudioBuffer` (all supported by the Web Audio API).
2. Connect source to an `AnalyserNode` (`fftSize` 1024, `smoothingTimeConstant` 0.3), then to `AudioContext.destination`.
3. Each frame, read time-domain data and compute RMS.
4. Map RMS to `mouthOpen` using a noise-floor threshold and an adaptive gain, then clamp to 0 to 1. The adaptive gain tracks a running peak with slow decay, so a quiet voice still gets the full gape range (verified down to about 4% of original level).
5. Compute a second signal, `lipWidth`, from the ratio of high-frequency energy (about 2–8 kHz) to low/mid energy (about 180 Hz–2 kHz), read from frequency-domain data. Sibilants widen the lips; this stops amplitude-only sync looking like a metronome.
6. Smooth `mouthOpen` with different attack and release times (attack about 40 ms, release about 120 ms) so the mouth snaps open and relaxes naturally; smooth `lipWidth` similarly.

**Mouth displacement**

- Lower-lip and jaw drones move down (and slightly back) by up to about 0.08 units at `mouthOpen` = 1.
- Upper-lip drones move up by up to about 0.01 units.
- Lip-corner drones move apart along the mouth line by an amount proportional to `lipWidth` (0 to 1).
- Drones in the mouth interior (optional extra group, hidden when closed) fade in as the mouth opens, giving a dark-gap look.
- Cheek drones next to the mouth move a little to avoid a visible tear in the surface.

**Browser requirement.** The `AudioContext` must be created or resumed from a user gesture. The Start button press satisfies this, so the audio context is created in the Start handler.

**Known limitation.** Amplitude-plus-brightness sync gives a plausible "talking" feel but does not match specific sounds (for example, closed lips on "m" or "b", or tongue position on vowels). Viseme support is a future upgrade; the `setMouth` interface below is designed so a viseme driver can replace it later.

**Ambient sound.** A quiet, looping ambient soundscape (a low hum with a soft shimmer, suggesting a drone swarm) plays after the first press of Start, and the user can turn it off and on at any time.

- **Source:** generated in the page with the Web Audio API — a soft, morphing two-chord pad of detuned oscillators with a slow filter sweep (no noise). No audio file is embedded, so the page stays offline and small. A short embedded loop is the fallback if the generated sound is not good enough.
- **Start:** begins on the Start press (browsers require a user gesture) and fades in over about 2 seconds. It keeps playing through all states, with a gentle swell during `FORMING` and `DISPERSING`.
- **Control:** the sound toggle (section 5) switches it off and on. Muting and unmuting use a gain ramp of about 0.3 seconds to avoid clicks. The default is on, and the choice is remembered between visits where the browser allows storage (guarded with try/catch).
- **Ducking:** while `SPEAKING`, the ambient level drops by about 6 dB so speech stays clear, and returns over about 0.5 seconds after speech ends.
- **Routing:** the ambient sound has its own gain node and does not pass through the lip-sync analyser, so it can never move the mouth.
- **API:** `DroneFace.setAmbient(on)` and `DroneFace.ambient` (current state).

## 11. Frontend integration API

The page exposes a small global object so the future application code (or a developer console) can drive it.

```js
window.DroneFace = {
  start(),                      // IDLE -> FORMING (same as pressing Start or Reform)
  disperse(),                   // ACTIVE -> DISPERSING -> IDLE
  state,                        // 'idle' | 'forming' | 'active' | 'speaking' | 'dispersing'
  attachAudio(source),          // HTMLAudioElement | MediaStream | AudioBuffer
  speakFromUrl(url),            // complete audio file: fetch, decode, play with lip sync
  speak(text),                  // TTS: POST text to the endpoint, decode, play with lip sync
  setEndpoint(url),             // TTS endpoint (qwen3-tts style); persisted in localStorage
  setVoice(name),               // TTS voice name
  attachStream(),               // streaming hook: returns { push(chunk), end() } (stub in v1)
  setMouth(open, width),        // manual override, 0..1 each (width optional; for testing or other drivers)
  setAmbient(on),               // ambient sound on/off (same as the sound toggle)
  ambient,                      // current ambient state (boolean)
  setOrientationLimits({yaw, pitch}),
  on(event, handler)            // 'stateChange', 'speechStart', 'speechEnd'
}
```

**TTS backend contract (implemented in v1).**

- `speak(text)` POSTs text to a configurable qwen3-tts style endpoint: `POST <endpoint> {"text":"…","voice":"…","response_format":"wav"}`. The request shape is centralised in one function (`requestTTS`) so it is the only place to change if the server wants a different body or path.
- The response is accepted as an audio body (`audio/wav|mpeg|ogg`) or as JSON with a base64/`audio`/`data` field, decoded with `decodeAudioData`. If the call fails for any reason, the page falls back to the browser's `speechSynthesis` so it stays demoable offline.
- The service may also return audio as a stream (for example, chunks over a WebSocket). This choice is not made yet. The frontend accepts both through one interface: files go through `attachAudio`, `speakFromUrl` or `speak`, streams through `attachStream`. All feed the same analyser, so the lip-sync code does not change.
- v1 builds and tests complete-file playback. Streaming playback (an `AudioWorklet` fed with PCM chunks is the suggested method) is a follow-up task once the backend choice is made.

**v1 test harness.** The **Generate voice** button and `DroneFace.setMouth(open, width)` let the mouth be tested without a backend. A file-picker button (shown only with `?debug=1` in the URL) for loading a local audio file is recommended.

## 12. Performance and compatibility

| Item | Target |
| --- | --- |
| Frame rate | 60 fps on a mid-range laptop with integrated graphics; 30 fps minimum on a recent phone |
| Drone count | About 2,870 default; auto-reduce to about 1,450 if the first 60 frames average under 40 fps |
| Device pixel ratio | Capped at 2 |
| Browsers | Current Chrome, Edge, Firefox, Safari (WebGL2) |
| File size | Under about 500 KB total |
| Startup | Interactive Start button within 1 s of load; face data generation under 300 ms |

Other requirements:

- Handle window resize and orientation change; the face re-centres and rescales.
- If WebGL is unavailable, show a clear message instead of a blank page.
- Respect `prefers-reduced-motion`: reduce idle drift speed and shorten the formation transition.
- Pause rendering when the tab is hidden.
- Handle WebGL context loss and restore without leaving the page blank.

## 13. File structure (single output file)

The delivered `drone-face.html` is organised as:

1. `<style>`: layout, Start button, canvas, fonts (system font stack only; no external fonts).
2. `<canvas>` and Start button markup.
3. `<script>`: inlined, minified three.js subset.
4. `<script>`: application code in clear sections:
   - constants and config
   - face generator
   - shaders (vertex and fragment as template strings)
   - state machine
   - input handling
   - audio and lip sync
   - TTS client (`requestTTS`)
   - public `DroneFace` API
   - render loop

The repo lives in `droneface-spec/` (this directory), alongside this spec and `reference_image.png`. Development is a clean-room rebuild: the earlier `~/projects/droneface` (Canvas 2D) and `~/projects/droneface-ds` (three.js) prototypes are reference material only, not code to port from. Source lives in `src/` with a `build.js` that produces the single file. The built file is the deliverable.

**Testing.** A headless self-test (`tools/selftest.html`, loaded over a local HTTP server and run in headless Chromium) asserts the state machine, formation accuracy, face geometry (eye/nose/mouth centroids, blink squash, jaw drop), the TTS wire format against a fake `fetch`, and the lip-sync DSP against a synthetic speech envelope fed through a fake `AnalyserNode` — no audio device or TTS server needed.

## 14. Acceptance criteria

1. Opening the file offline in a browser shows drones drifting slowly on a dark background with a centred Start button.
2. Pressing Start moves every drone smoothly into a recognisable 3D face within about 5 seconds, with no visible jumps. The face is turquoise and the hair is bottle green.
3. The face fills most of the viewport height on desktop and on a phone in portrait.
4. Dragging turns the face left, right, up and down within the set limits, never showing the back of the head, and feels smooth.
5. The face looks like a swarm of points: individual drones are visible, with bright edges, a clearly defined nose, lips and cheekbones, and a sparser hair band.
6. Calling `DroneFace.attachAudio` with an audio element makes the mouth open and close in time with the loudness of the audio, with no more than about 100 ms of visible lag, and the lips widen on sibilants.
7. `DroneFace.setMouth(0..1, 0..1)` moves the mouth from closed to fully open and the lip width from relaxed to wide.
8. The file works with no network connection.
9. Resizing the window does not break the layout.
10. Pressing Disperse (when not speaking) returns the drones to slow random flight within about 4 seconds with no jumps, and Reform rebuilds the face. Ten consecutive cycles show no drift, stuck drones or frame-rate decline.
11. The face looks generic and neutral, not like a specific person.
12. A streaming entry point (`attachStream`) exists alongside the file path, so the later backend choice needs no change to the face code.
13. Ambient sound starts after Start, can be turned off and on with the toggle without clicks, ducks while speech plays, and never moves the mouth.
14. The headless self-test (`tools/selftest.html`) passes all assertions.
15. The eyes blink while the face is formed (`ACTIVE` and `SPEAKING`).
16. `DroneFace.speak(text)` POSTs to the configured endpoint, plays the returned audio with lip sync, and falls back to `speechSynthesis` when the call fails.

## 15. Suggested milestones

| # | Milestone | Output |
| --- | --- | --- |
| 1 | Scene skeleton | three.js setup, dark canvas, point cloud of random drifting drones, resize handling |
| 2 | Face generator | Generic procedural face point set (including the eye group) viewable as a static debug view; tune against `reference_image.png` |
| 3 | Shader and look | Glow sprite, turquoise face and bottle-green hair, edge brightening, twinkle |
| 4 | State machine and formation | Start button, idle-to-face transition, disperse and re-form loop, blink animation |
| 5 | Drag orientation | Clamped yaw and pitch with damping, touch support |
| 6 | Lip sync and sound | Audio analysis (adaptive gain, spectral brightness), mouth displacement, test harness, generated ambient sound with toggle and ducking |
| 7 | API and packaging | `DroneFace` API (including `speak`, `setEndpoint`, `setMouth`, `setAmbient` and the `attachStream` stub), TTS client, build script producing the single offline HTML |
| 8 | Polish and QA | Headless self-test, performance tuning, reduced-motion, WebGL fallback, cross-browser testing |

## 16. Assumptions (change any of these if wrong)

- Desktop browser is the primary target; mobile touch support is included but secondary.
- Single static face with a generic, neutral look (decided); the generator parameters are exposed as constants so the look can be tuned.
- The face looks forward by default, with no eye tracking of the mouse.
- All on-screen text is English: Start, Reform, Disperse and the sound toggle's label.
- Ambient sound starts on the Start press and is on by default; the sound toggle is available in every state.
- Disperse is offered through a small control while the face is active and is unavailable while speaking; the centred button reads Reform after a dispersal. Both can be changed.
- Only the hair band is bottle green; the face is turquoise. There is no neck/shoulders group (removed) and no separate ears.
- Mouth movement and eye blinks are the only animated facial features in v1 (blinks move/dim the eyelid drones every 3 to 6 seconds while the face is formed).
- The TTS request shape (`POST {"text","voice","response_format":"wav"}`) is a guess at a qwen3-tts style server and is isolated in `requestTTS`; the endpoint and voice are configurable at runtime and the page falls back to `speechSynthesis` offline.
- The **Generate voice** button speaks through the browser's `speechSynthesis` as a demo voice (mouth driven by a synthetic speech envelope); once a TTS endpoint is configured via `setEndpoint`, `speak` uses real audio and amplitude lip sync instead.

## 17. Decisions and open questions

**Settled:** the face has a generic, neutral look; the swarm can disperse and re-form; the face is turquoise and the hair bottle green; ambient sound is included, with an on/off control; the frontend calls a configurable qwen3-tts style endpoint with an offline `speechSynthesis` fallback; amplitude-and-brightness lip sync (adaptive gain plus sibilant-driven lip width); eye blinks are in v1.

**Still open:**

1. Will the backend deliver complete audio files or stream audio? The spec supports both; the answer decides whether the streaming follow-up task is needed.

## 18. Future work

- Viseme-based lip sync driven by phoneme timing from the TTS service.
- Streaming audio playback, if the backend streams.
- Eyebrow motion, emotional expressions, and head nods.
- Eye gaze following the mouse or a target.
- Alternative faces by sampling a mesh into the same point format.
- Background elements such as a faint horizon or crowd silhouette.
