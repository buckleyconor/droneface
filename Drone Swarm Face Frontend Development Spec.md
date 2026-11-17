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
| Colour | Face turquoise; accent group (hair, brows, lid rims) lavender by default, switchable with `?accent=`; dark background |
| Face look | Generic, neutral face; not modelled on a specific person |
| Swarm lifecycle | Can disperse back to free flight and re-form, repeatedly |
| Background music | Included: an embedded looping track, muted by the sound toggle (the generated chord pad was removed in favour of it) |
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
- Sound toggle: a small speaker icon button in the bottom-right corner, visible in every state; keyboard accessible, with an accessible label ("Sound on" or "Sound off") and a clear on/off icon state. It is the single sound control: it mutes the background music and never the voice. There is no separate music control and no generated ambience — one button, one behaviour.
- Voice control: a text box (bottom centre) and a **Generate voice** button. Typing text and pressing the button forms the face (if needed) and speaks the words using the browser's `speechSynthesis` as the demo voice, with the mouth moving to a synthetic speech envelope until a real TTS endpoint is wired in.

## 6. Visual design

- **Background:** near-black blue, `#02060d`, optionally with a very faint vertical gradient.
- **Face drone colour (turquoise):** `#19e6d3`. Per-drone variation: shift hue slightly toward cyan `#2ad0ff` and lightness by ±10% to give a shimmering surface.
- **Accent drone colour (lavender by default):** `#d9b8f0`, with the same ±10% lightness variation. The accent group is everything that is not skin — hair strands, brows, eyelid rims, lip peaks — and it rims in its own brighter tone (`uColorHair * 1.8`) so the crown reads as a halo. `?accent=lavender|ice|warm` re-skins it at load without a rebuild (`ice` `#c4fbf4`, `warm` `#ffe2b0`).
- **Edge emphasis:** drones on silhouette edges (where the surface normal is perpendicular to the view direction) render brighter and slightly larger, tinted toward cyan-white `#7ff5ea`. This reproduces the bright rim in `reference_image.png`.
- **Depth cue:** points farther from the camera are slightly dimmer and smaller.
- **Relief shading:** protruding areas (nose bridge/tip, cheekbones, brow edge) are brighter and recessed areas (eye sockets, nostrils, under the brow and lower lip, sides of the nose) are dimmer — the reference shades by dot brightness and density, not by lighting.
- **Point look:** soft circular sprite generated in the fragment shader (bright core, quick falloff), additive blending, depth write off.
- **Twinkle:** per-drone sine flicker, 2 to 4% brightness amplitude, random phase.
- **Point size:** scales with viewport height and device pixel ratio so the look is the same on any screen. Capped to avoid overdraw.

## 7. Procedural face generation

The face is generated once at page load (target under 300 ms) as a set of 3D target positions plus a per-point attribute set.

**Look: generic.** The face is neutral and gender-neutral, with no resemblance to a real person: moderate brow and cheekbone relief, an average-width straight nose, medium lips, a rounded chin, and a hair outline with no specific hairstyle. Each feature is a named parameter group at the top of the file (for example `noseLength`, `lipFullness`, `jawWidth`) so the look can be tuned without changing the generator logic.

**Method: a height-field head sampled on a hexagonal lattice.**

1. **Profile.** The head is not an ellipsoid. Its half-width comes from a monotone cubic Hermite curve (`pchip`) through points traced on `reference_image.png` (the measured feature ratios are in `reference-image-notes.md`), stored as half-width *squared* so the jaw shoulder is smooth, and above `y = 0.62` a separate cranium dome (`a = 0.585`, `b = 0.38`) takes over — that is what gives the flat-ish crown instead of an egg. A second `pchip` gives how far forward the surface sits at each height. Monotone interpolation is deliberate: Catmull-Rom or a polynomial overshoots, and the profile bulges where it should not.
2. **Surface.** `surfaceZ(x, y)` = depth profile scaled across the row (`(1 - r^2.5)^0.4`, r = |x|/half-width) plus feature relief, cross-faded out over the last 22% of the row so features never poke through the outline. Relief is Gaussian bumps and dips (sockets, brow, cheekbones, lips, chin, jaw) plus a **nose profile** rather than bumps: a ridge from brow to tip that widens as it descends, with a Gaussian tip. The mouth line is a shallow smile curve with a thin crease.
3. **Sampling.** A hexagonal lattice: rows at `d*sqrt(3)/2`, alternate rows offset half a step, points placed by **arc length along the curved row** so spacing stays even where the face turns away, with slight jitter in row height and along the row. The spacing `d` is iterated (5 passes, `d *= sqrt(count/target)`) so the sample count lands on the target instead of being clipped or padded. Points are then dropped by a probability field — sparse in the sockets, nostrils, philtrum and hollows, dense on the features — and removed from the lip gap, the hair band and the last sliver inside the silhouette. That is how the reference shades by dot density without a single drawn line.
4. **Secondary groups**, each a small deliberate row builder rather than a scatter:
   - **Hair:** five arcs offset outward from the silhouette (`0.013 + k*0.026`) with a two-frequency wobble, each starting higher up so the outer strands sit above the crown. Face drones inside the band are removed so the hair does not double up.
   - **Ears:** two flattened rings per side, just outside the head, with the outward normal tilted.
   - **Eyes:** upper and lower lid curves (plus a brow-adjacent row), an outer arc, an iris ring and an inner ring clipped to the lid opening, and one bright catchlight. Lid points carry the blink vector toward the closed line, which is what the self-test measures.
   - **Brows:** two rows per side along a shallow arc. **Nose:** a bridge row, the tip, nostril rings and wings. **Lips:** six rows between the lip profiles, with the cupid's-bow peaks picked out brighter.
5. Each point stores attributes: `position`, `normal` (from the surface gradient), `group` (0 skin, 1 accent, 3 mouth; 2 and 4 are unused slots kept in the shader), `shade` (relief x density x per-drone variation), `aMouthOpen` / `aMouthWide` (per-point lip displacement at full open / full wide), `aBlink` (per-point lid displacement at full blink), `seed`, `reserve`.

**Mouth region.** Points within an elliptical region around the lips get `mouthWeight` greater than 0. Weight is 1 at the lower lip and jaw, falling smoothly to 0 at the mouth boundary. Upper lip has a small weight so the mouth opens mostly by jaw drop.

**Drone counts (defaults)**

| Group | Target | Emitted |
| --- | --- | --- |
| Face surface (lattice, density-thinned) | 3,640 | about 3,030 |
| Accent (hair arcs, ears, brows, lid rims) | 565 | about 710 |
| Mouth group (rides the lips; drawn from face + lip rows) | — | about 185 |
| Total | 4,205 targeted | **about 3,920** |

About 28.5% of drones are marked `reserve` and stay hidden while dispersed, so the start screen shows ~50% and the formed face ~70% of the previous density. `CONFIG.counts` holds the targets, `CONFIG.reducedCounts` the low-quality set (about 2,100), and the generator's spacing iteration is what actually decides the emitted count.

**Design risk.** A procedural face can look generic or uncanny. Mitigation: tune against `reference_image.png` (and `reference-image-notes.md` for the measured feature ratios the profile curves were fitted to), in a flat lit debug view before any animation. If the height field stops paying for itself, the data source can be swapped for a mesh-sampled point set without changing anything else, because the rest of the system only consumes the geometry's attribute arrays.

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

### 9.1 Drag

- Input: pointer drag (mouse and touch) on the canvas. Pointer events are used so one code path covers both.
- Mapping: horizontal drag changes yaw, vertical drag changes pitch.
- **Limits (defaults):** yaw ±35°, pitch ±25°. These are constants. The limits keep the back of the head (which is not modelled) from ever being visible.
- Soft limits: movement slows as it approaches the limit (rubber-band effect) rather than hard-stopping.
- Smoothing: current orientation follows the target with exponential damping (about 0.1 s time constant).
- Behaviour on release: orientation holds, then optionally eases back to centre after 3 s of no input (configurable; default on).
- The rotation is applied as a model rotation in the shader or on the `Points` object, with the camera fixed. Dragging is disabled until the state is `ACTIVE`.
- Drag does not select text or trigger browser gestures (`touch-action: none` on the canvas).

### 9.2 Idle motion — waiting, not parked

A formed face that holds perfectly still reads as a paused video. While it is formed and
silent it runs a slow cycle of small gestures, the way a person looks around while waiting
for the next instruction:

| step | gesture | peak | hold at peak |
|------|---------|------|--------------|
| 1 | tilt to one side (roll — ear toward shoulder) | 3.5° | 3 s |
| 2 | look off to one side (yaw) | 12° | 2 s |
| 3 | tilt to the other side (roll) | 3.5° | 3 s |
| 4 | look off to the other side (yaw) | 12° | 2 s |

then it starts again from step 1.

- **Ten seconds of nothing between every gesture**, timed from the moment the head is back at
  centre, not from the start of the previous move. The stillness is the point: a gesture every
  few seconds is a screensaver.
- Every move is eased in and out over about 1.5 s (smoothstep), and nothing is ever faster than
  that. Roll never exceeds 4°; the look is a third of the drag limit, so it is a glance, not a
  turn.
- The cycle runs only while the state is `ACTIVE` with no speech playing and no pointer drag.
  Speaking or being dragged interrupts it: the head eases back to centre and the ten-second
  wait restarts from the beginning when the interruption ends. A gesture in progress is never
  cut short — it returns along the same easing curve.
- Idle offsets are *added* to the drag orientation rather than replacing it:
  `RY(yaw + idleYaw) · RX(pitch) · RZ(idleRoll)`. Roll is applied innermost, so it is a tilt of
  the head's own axis whatever way the head is facing.
- `prefers-reduced-motion: reduce` disables the cycle, as does `DroneFace.setIdleMotion(false)`
  (for a screenshot, a recording, or a test that needs the head still). The cycle is not
  persisted; it defaults to on.

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

**Background sound.** A quiet music bed runs under the demo from the first interaction until the tab is closed, and the user can mute it at any time with the sound toggle. It replaced a generated two-chord pad: the pad's oscillators were the whole of the ambient code in `main.js`, and they are gone — nothing in the page creates an oscillator any more.

- **Source:** `4ever-faded.mp3` (28 s loop, 96 kbps, 330 KB), embedded in the delivered file as a base64 data URI so it stays a single offline file. It lives in an `<audio>` element in `src/index.html`, outside the bundle, because the bundle is the face and the bed is staging.
- **Start:** browsers require a user gesture for audible playback, so the page attempts it on load and otherwise starts on the first click or key press — in the demo flow, the Start press. Volume eases in over about 0.3 s.
- **Control:** the sound toggle is the master mute; it is one flag (`soundOn`), persisted, mirrored by the bed. Muting and unmuting use a level ramp of about 0.3 seconds to avoid clicks. Default on.
- **Ducking:** while `SPEAKING`, the bed drops to about 35% (`-9 dB`) on the `speechStart` event and returns on `speechEnd`, so speech stays clear.
- **Routing:** the bed is a plain media element and never enters the lip-sync analyser, so it cannot move the mouth. The voice path (TTS buffer or `speechSynthesis`) is untouched by the sound toggle.
- **API:** `DroneFace.setSound(on)` and `DroneFace.sound`. `setAmbient(on)` and `ambient` remain as deprecated aliases.

**Voice paths and fallback.** Anything that makes the face talk must move the mouth, and must be able to say which path it took (`DroneFace.voiceStatus()`). A silent failure is the worst thing a demo like this can do, and it was the original bug: the TTS error was swallowed by a `catch` and the fallback had no voice to speak.

1. `attachAudio`, `speakFromUrl`, or `speak` with a reachable endpoint → analyser-driven, i.e. the real lip sync described above.
2. `speak` with an unreachable or unconfigured endpoint → the browser's `speechSynthesis`. The utterance gets 400 ms to fire `onstart`: a browser with no installed voices accepts `speak()` and then says nothing forever, and waiting for it is what left the face frozen.
3. If it does not start → a synthetic envelope (the same driver the demo voice uses) runs for a duration estimated from the text length, so the face never stands still with its mouth shut. The status line and the console say in plain words that the movement is simulated and why.

Whichever path runs, `speechStart`/`speechEnd` are emitted, so the music ducks the same way. `DroneFace.stop()` cuts all three paths — the playing buffer source, `speechSynthesis`, and the envelope. Disperse is not available while speaking, so a transition never has to interrupt a voice; when one is added it should call `stop()`.

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
  stop(),                       // cut any voice: TTS playback, speechSynthesis, or the simulated envelope
  setEndpoint(url),             // TTS endpoint (qwen3-tts style); persisted in localStorage
  setVoice(name),               // TTS voice name
  setModel(name),               // served model name, for OpenAI-compatible endpoints
  attachStream(),               // streaming sink: { push(chunk), end(), stop() } — feeds the same analyser
  setMouth(open, width),        // manual override, 0..1 each (width optional; for testing or other drivers)
  setSound(on),                 // master sound on/off: the music bed (never the voice)
  sound,                        // current sound state (boolean)
  voiceStatus(),                // what the last speak() did: {mode, detail, endpoint, voice, model, open, width, audioActive, synthVoice}
  setAmbient(on),               // deprecated alias for setSound
  ambient,                      // deprecated alias for sound
  setOrientationLimits({yaw, pitch}),
  setIdleMotion(on),            // the waiting cycle in §9.2; off for screenshots or a test
  idleMotion,                   // read-only: on, and not suppressed by reduced motion
  on(event, handler)            // 'stateChange', 'speechStart', 'speechEnd'
}
```

**TTS backend contract (implemented in v1).**

- `speak(text)` POSTs to a configurable endpoint and the request shape is chosen from the URL, because two formats are in the wild and both turn up at Dell demos:
  - an OpenAI-compatible URL (matches `/audio/speech` or a bare `/v1`) gets `POST {"model":"…","input":"…","voice":"…","response_format":"wav"}` — what vLLM and the qwen3-tts deployments that speak that API expect;
  - any other URL gets the original shape, `POST {"text":"…","voice":"…","response_format":"wav"}`.
  Both are decided in one function (`requestTTS`), so it remains the only place to change.
- The response is accepted as an audio body (`audio/wav|mpeg|ogg`) or as JSON with a base64 field (`output.audio`, `audio_base64`, `audio`, `data`, `b64`), decoded with `decodeAudioData`.
- Failure is never silent: the reason is logged (`console.warn`) and carried in `voiceStatus().detail`, and the fallback chain in section 10 keeps the face talking. `decodeAudioData` detaches the buffer it is given, so the size is read before decoding.
- **Known-good deployment, verified from the lab box.** vllm-omni serving `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` as model `qwen3-tts` on port 8091 (`127.0.0.1`, `172.22.0.1`, `172.17.0.1`). `POST /v1/audio/speech {"model":"qwen3-tts","input":"…","voice":"…","response_format":"wav"}` returns 200 `audio/wav`, 24 kHz mono 16-bit, about 0.9 s for a short sentence, with `access-control-allow-origin: *` and a working `OPTIONS` preflight — so the page can call it from `file://` or any port. Voices the server accepts: `default`, `aiden`, `dylan`, `eric`, `ono_anna`, `ryan`, `serena`, `sohee`, `uncle_fu`, `vivian`; a wrong name gives 400 with that list, which the status line now shows verbatim. `CONFIG.tts` holds these values and seeds the endpoint on first load only, so the panel and `?endpoint=` always win.
- **Streaming playback (implemented, v1.1).** `speak(text)` against an OpenAI-compatible endpoint asks for `stream: true` with `response_format: "pcm"`, and the answer is `text/event-stream`:
  - `event: speech.audio.delta` / `data: {"type":"speech.audio.delta","audio":"<base64 s16le mono>","response_format":"pcm"}` — chunks of raw PCM, typically about a second of audio each.
  - `event: speech.audio.done` / `data: {"type":"speech.audio.done","usage":{…}}` — end of utterance.
  Chunks are decoded to `Float32Array`, wrapped in an `AudioBuffer` at 24 kHz mono (`CONFIG.tts.pcmRate`, verified against the same sentence requested as a WAV), and scheduled back-to-back on `BufferSourceNode`s connected to the same analyser, so lip sync sees the stream exactly as it sees a file. Scheduling uses a running cursor clamped to `max(cursor, currentTime + 5 ms)`: if a chunk lands late the next one starts now rather than in the past (a brief gap, no glitch, no drift). `speechStart` fires on the first chunk, `speechEnd` when the last scheduled node ends — so the mouth is moving about 120 ms after the click instead of 2 s, and the music ducks then too.
  The SSE parser is fed arbitrary byte chunks and must reassemble events split across them (an event boundary can land in the middle of a base64 payload), tolerating `data:` with or without a space and CRLF line endings. It is a pure function and is unit-tested on its own, because a parser that silently drops a chunk sounds like a broken speaker rather than a bug.
  `attachStream()` returns this same sink — `{ push(chunk), end(), stop() }`, accepting `Int16Array`, `Float32Array` or `ArrayBuffer` — so a WebSocket or gRPC backend can feed the face without touching the face code.
  If streaming is refused (not an event-stream, HTTP error, no `stream` support) the utterance is re-requested as a complete file, and the existing fallback chain follows. An explicit stop aborts the in-flight fetch and stops every scheduled node.
  Measured against the lab box, click to first mouth movement is **about 1.05 s**, down from about 2.0 s buffered. Where the time goes: the server flushes a first delta of only ~80 ms of audio at ~90 ms (near-silent onset), then holds roughly a second while it builds the next 2 s chunk — so the page is ready to talk and starving. Scheduling and analysis are not the bottleneck: a chunk pushed straight into the sink reaches the analyser within 20 ms. If the server can be made to send a 300 ms first chunk, this becomes ~0.2 s without touching the frontend.
- **Voice list from the server.** `GET {origin}/v1/audio/voices` returns `{"voices":[…],"uploaded_voices":[…]}`; the settings panel populates its suggestions from there when the endpoint answers (replacing a trailing `/audio/speech` with `/audio/voices`), and falls back to the list in `CONFIG.tts` when it does not. The status line says how many voices it found and where from.
- The service may also return audio as a stream over another transport (for example, chunks over a WebSocket). The frontend accepts both through one interface: files go through `attachAudio`, `speakFromUrl` or `speak`, streams through `attachStream`. All feed the same analyser, so the lip-sync code does not change.

**Voice settings control.** A slider control sits beside the text box and opens a panel with the endpoint URL, model name and voice name, persisted in `localStorage`, plus a status line naming the mode (`TTS endpoint`, `TTS stream`, `browser voice`, `simulated`) and the last result. The voices the endpoint reports are shown as chips; clicking one selects it and speaks a sample line, so auditioning nine voices is nine clicks. `?endpoint=…&model=…&voice=…` seeds all three from the URL, so a room can be configured without opening devtools.

**v1 test harness.** The **Generate voice** button and `DroneFace.setMouth(open, width)` let the mouth be tested without a backend. A file-picker button (shown only with `?debug=1` in the URL) for loading a local audio file is recommended. `tools/voice-paths-check.mjs` serves the repo plus three fake TTS endpoints (legacy shape, OpenAI shape, 404), drives the built page over CDP, and asserts that each path moves the mouth and reports itself honestly. It also asserts the §9.2 glance on screen — that the lit mass slides sideways and comes back — so idle motion is checked against rendered pixels, not only against the pose variables.

## 12. Performance and compatibility

| Item | Target |
| --- | --- |
| Frame rate | 60 fps on a mid-range laptop with integrated graphics; 30 fps minimum on a recent phone |
| Drone count | About 3,920 default (4,205 targeted); auto-reduce to about 2,100 if the first 60 frames average under 40 fps |
| Device pixel ratio | Capped at 2 |
| Browsers | Current Chrome, Edge, Firefox, Safari (WebGL2) |
| File size | Under about 500 KB of code, plus about 450 KB of base64 for the embedded music track (roughly 950 KB delivered) |
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
5. `<script>`: background music bed — an `<audio>` element with the track embedded as a base64 data URI, plus the level envelope, ducking and the mirror of the sound flag. It sits outside the bundle and talks to the app only through the public API and `on(event, cb)` seam, so it survives any rebuild of `src/main.js` and can be injected into an already-built file with `tools/inject-music.mjs` (and the retired chord stripped with `tools/remove-chord.mjs`).

The repo lives in `droneface-spec/` (this directory), alongside this spec and `reference_image.png`. Development is a clean-room rebuild: the earlier `~/projects/droneface` (Canvas 2D) and `~/projects/droneface-ds` (three.js) prototypes are reference material only, not code to port from. Source lives in `src/` with a `build.js` that produces the single file. The built file is the deliverable.

**Testing.** A headless self-test (`tools/selftest.html`, loaded over a local HTTP server and run in headless Chromium) asserts the state machine, formation accuracy, face geometry (eye/nose/mouth centroids, blink squash, jaw drop), the TTS wire format against a fake `fetch`, and the lip-sync DSP against a synthetic speech envelope fed through a fake `AnalyserNode` — no audio device or TTS server needed.

Two checks run against a real browser and a real renderer rather than a simulated analyser (`tools/voice-paths-check.mjs`, `npm run check:voice`; `tools/sound-behaviour-check.mjs`, `npm run check:sound`). They drive the built file with real mouse gestures over CDP and cover the paths a simulated analyser cannot: every voice fallback must move the mouth, an unreachable TTS server must not stop the mouth, and the music bed must duck without ever touching the voice.

Because the swarm shimmers constantly, a single before/after screenshot proves nothing — pixels change with or without the mouth moving. The mouth check therefore compares a closed-then-open pair against two same-state pairs captured at the same interval, and requires the transition to stand out from the drift. It also reads the shader uniform values directly. This exists because a build once passed every JavaScript-level lip-sync assertion while the face sat stone still on screen: the animation variables were computed correctly and never assigned to `uMouthOpen`/`uLipWidth`, so nothing reached the GPU. Numbers moving is not the same as the mouth moving.

## 14. Acceptance criteria

1. Opening the file offline in a browser shows drones drifting slowly on a dark background with a centred Start button.
2. Pressing Start moves every drone smoothly into a recognisable 3D face within about 5 seconds, with no visible jumps. The face is turquoise and the accent drones (hair, brows, lid rims) are lavender.
3. The face fills most of the viewport height on desktop and on a phone in portrait.
4. Dragging turns the face left, right, up and down within the set limits, never showing the back of the head, and feels smooth.
5. The face looks like a swarm of points: individual drones are visible, with bright edges, a clearly defined nose, lips, brows and cheekbones, and hair strands that follow the silhouette rather than a cap.
6. Calling `DroneFace.attachAudio` with an audio element makes the mouth open and close in time with the loudness of the audio, with no more than about 100 ms of visible lag, and the lips widen on sibilants.
7. `DroneFace.setMouth(0..1, 0..1)` moves the mouth from closed to fully open and the lip width from relaxed to wide, **visibly on screen** — measured against the shader uniform and by screenshot, not only by the JavaScript value behind it.
8. The file works with no network connection.
9. Resizing the window does not break the layout.
10. Pressing Disperse (when not speaking) returns the drones to slow random flight within about 4 seconds with no jumps, and Reform rebuilds the face. Ten consecutive cycles show no drift, stuck drones or frame-rate decline.
11. The face looks generic and neutral, not like a specific person.
12. Left alone once formed, the head runs the idle cycle from §9.2: a 3.5° tilt, a 12° look, the same to the other side, with about 10 seconds of stillness between gestures and no move faster than about 1.5 seconds. Starting speech stops it and brings the head back to centre.
12. A streaming entry point (`attachStream`) exists alongside the file path, so the later backend choice needs no change to the face code.
13. The sound toggle mutes and unmutes the background music without clicks or hum, ducks while speech plays, returns afterwards, and never moves the mouth. Nothing in the page constructs an oscillator.
14. The headless self-test (`tools/selftest.html`) passes all assertions.
15. The eyes blink while the face is formed (`ACTIVE` and `SPEAKING`).
16. `DroneFace.speak(text)` POSTs to the configured endpoint, plays the returned audio with lip sync, and never leaves the mouth still: an unreachable or unconfigured endpoint falls back to `speechSynthesis` and then to a simulated envelope, and `voiceStatus()` says which one ran.
17. The background track is audible from the first interaction after load, loops continuously, ducks while the face speaks, is silenced by the sound toggle, and never masks the voice.
18. `DroneFace.stop()` silences any voice path within one frame and the mouth closes; a 404 from the endpoint is reported in the status line and on the console.

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
- Sound starts on the first interaction (the Start press) and is on by default; the sound toggle is available in every state and is the only sound control.
- Disperse is offered through a small control while the face is active and is unavailable while speaking; the centred button reads Reform after a dispersal. Both can be changed.
- The accent group (hair, brows, lid rims, lip peaks) is lavender by default and the face is turquoise; `?accent=` switches the accent. There is no neck/shoulders group and no separate eye group: ears, brows and lid rims share the accent group.
- Mouth movement and eye blinks are the only animated facial features in v1 (blinks move/dim the eyelid drones every 3 to 6 seconds while the face is formed).
- The TTS request shape (`POST {"text","voice","response_format":"wav"}`) is a guess at a qwen3-tts style server and is isolated in `requestTTS`; the endpoint and voice are configurable at runtime and the page falls back to `speechSynthesis` offline.
- The **Generate voice** button speaks through the browser's `speechSynthesis` as a demo voice (mouth driven by a synthetic speech envelope); once a TTS endpoint is configured via `setEndpoint`, `speak` uses real audio and amplitude lip sync instead.
- Background music is `4ever-faded.mp3` (28 s, 96 kbps, ~330 KB), embedded in the delivered file as a data URI to keep the single-file property. Browsers will not start audible audio without a user gesture, so the page attempts playback on load and otherwise starts it on the first click or key press — in the demo flow that is the Start button.
- The generated chord pad is removed rather than muted: with a real music track under the voice, two ambient layers was one too many, and the pad made the sound toggle ambiguous. `setAmbient`/`ambient` stay as aliases so older callers and the self-test keep working.

## 17. Decisions and open questions

**Settled:** the face has a generic, neutral look; the swarm can disperse and re-form; the face is turquoise with a lavender accent; a looping music bed plays under the demo with one mute that leaves the voice alone; the generated chord pad is out; the frontend calls a configurable qwen3-tts style endpoint (OpenAI-compatible body when the URL looks like `/v1/audio/speech`) with an offline fallback chain that always moves the mouth; amplitude-and-brightness lip sync (adaptive gain plus sibilant-driven lip width); eye blinks are in v1.

**Still open:**

1. Will the backend deliver complete audio files or stream audio? The spec supports both; the answer decides whether the streaming follow-up task is needed.

## 18. Future work

- Viseme-based lip sync driven by phoneme timing from the TTS service.
- Eyebrow motion, emotional expressions, and head nods.
- Eye gaze following the mouse or a target.
- Alternative faces by sampling a mesh into the same point format.
- Background elements such as a faint horizon or crowd silhouette.
