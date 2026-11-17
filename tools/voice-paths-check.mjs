#!/usr/bin/env node
// voice-paths-check.mjs — end-to-end check of every way the face can talk.
//
// The self-test proves the lip-sync DSP; this proves the plumbing around it, which is
// what actually breaks in a demo room: an endpoint that is not set, an endpoint with a
// different wire format, an endpoint that 404s, a box with no system TTS voices. Each
// path must (a) move the mouth and (b) report honestly what it did.
//
// Serves the repo plus three fake TTS endpoints, drives the built page over CDP, and
// samples the mouth every frame. Usage: node tools/voice-paths-check.mjs [file.html]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'drone-face.html');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' };

import { speechLikeWav } from './test-audio.mjs';

// Audio for the fake endpoints is generated (tools/test-audio.mjs), not read from the repo:
// the checks need something speech-like to analyse, and a repo that ships no audio is a repo
// that can be published.
const audio = speechLikeWav(4);

// Does the lab's real qwen3-tts box answer? If so it gets tested too, because the
// whole point of this file is to catch the day it stops answering.
let live = null;
try {
  const res = await fetch('http://127.0.0.1:8091/v1/models', { signal: AbortSignal.timeout(1500) });
  const j = await res.json();
  const model = (j.data || []).map((m) => m.id)[0];
  if (res.ok && model) live = { origin: 'http://127.0.0.1:8091/v1/audio/speech', model };
} catch { /* not on this box today */ }

const served = [];
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let raw = '';
  req.on('data', (c) => (raw += c));
  await new Promise((r) => req.on('end', r));

  if (p === '/legacy') { served.push({ p, body: JSON.parse(raw || '{}') }); res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(audio); }
  if (p === '/openai/v1/audio/speech') { served.push({ p, body: JSON.parse(raw || '{}') }); res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(audio); }
  if (p === '/broken') { served.push({ p, body: raw.slice(0, 200) }); res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"model not found"}'); }
  if (p === '/stream/v1/audio/speech') {
    // SSE carrying raw PCM chunks, the way vllm-omni answers stream:true
    served.push({ p, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
    const pcm = (n) => { const bf = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) bf.writeInt16LE(Math.round(Math.sin(i / 7) * 11000), i * 2); return bf.toString('base64'); };
    for (let k = 0; k < 4; k++) {
      if (k) await new Promise((r) => setTimeout(r, 250));
      res.write(`event: speech.audio.delta\ndata: {"type":"speech.audio.delta","audio":"${pcm(7200)}","response_format":"pcm"}\n\n`);
    }
    res.write('event: speech.audio.done\ndata: {"type":"speech.audio.done","usage":{"total_tokens":1}}\n\n');
    return res.end();
  }
  if (p.endsWith('/audio/voices')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ voices: ['aiden', 'default', 'dylan', 'server-only-voice'], uploaded_voices: [] }));
  }
  if (p === '/slow') {
    await new Promise((r) => setTimeout(r, 800));      // a server that takes a moment to synthesise
    served.push({ p, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(audio);
  }

  if (p === '/speech.wav') {        // an ordinary audio file, for speakFromUrl
    res.writeHead(200, { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' });
    return res.end(audio);
  }

  const file = resolve(root, '.' + (p === '/' ? '/' + target.slice(root.length + 1) : p));
  let data;
  try { data = await readFile(file); }
  catch { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
  res.end(data);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- minimal CDP driver -----------------------------------------------------
const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0',
  '--user-data-dir=/tmp/droneface-voice-check-' + process.pid, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let wsUrl = '';
await new Promise((res, rej) => {
  chrome.stderr.on('data', (d) => { const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/); if (m) { wsUrl = m[1]; res(); } });
  setTimeout(() => rej(new Error('chromium did not open a devtools socket')), 25000);
});
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0;
const pending = new Map();
const exceptions = [];
const warnings = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    warnings.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++nextId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, sessionId, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targetId = (await send('Target.createTarget', { url: 'about:blank' })).targetId;
const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
const ev = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)
  .then((r) => {
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  });

await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
await send('Page.navigate', { url: origin + '/' }, sid);
for (let i = 0; i < 120 && !(await ev('!!window.DroneFace && window.__DF')); i++) await sleep(100);

// Wait for true silence *and* for the adaptive gain to forget the last utterance.
// Without the second half, a loud line earlier in the run makes a quiet one later
// read as a nearly closed mouth, and the failure looks like a lip-sync bug.
const settle = (ms = 8000) => ev(`(async () => {
  DroneFace.stop();
  const t = performance.now();
  while (performance.now() - t < ${ms}) {
    const m = __DF.getAudioMeter();
    if (__DF.getMouth().open < 0.05 && !DroneFace.voiceStatus().audioActive && m.peak < 0.02) return true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return false;
})()`);

// Run a function in the page with real arguments (keeps screenshot bytes out of the
// expression string).
let windowOid = null;
const call = async (functionDeclaration, args) => {
  if (!windowOid) windowOid = (await send('Runtime.evaluate', { expression: 'window', objectGroup: 'check' }, sid)).result.objectId;
  return send('Runtime.callFunctionOn', {
    functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    objectId: windowOid,
  }, sid).then((r) => {
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  });
};
const shot = (clip) => send('Page.captureScreenshot', { format: 'png', clip }, sid).then((r) => r.data);

// DevTools refuses a single message over a few hundred KB, so base64 goes in slices
// and the page assembles it.
async function stash(name, b64) {
  await call('(n) => { window[n] = ""; }', [name]);
  const CH = 48 * 1024;
  for (let i = 0; i < b64.length; i += CH) await call('(n, part) => { window[n] += part; }', [name, b64.slice(i, i + CH)]);
}

// Frames, not numbers: a mouth value of 0.94 that never reaches the shader looks, to a
// human, exactly like no mouth at all. That is the bug this check was blind to.
// Frames, not numbers. Drones shimmer constantly, so a single closed/open pair proves
// nothing — time passing changes pixels too. What is meaningful is the mouth pair
// differing MORE than an equal-spaced same-condition pair, in the band where the mouth is.
async function mouthOpensOnScreen() {
  const vp = await ev('({ w: innerWidth, h: innerHeight })');
  const clip = { x: Math.round(vp.w * 0.25), y: Math.round(vp.h * 0.6), width: Math.round(vp.w * 0.5), height: Math.round(vp.h * 0.3), scale: 1 };
  // Every pair is 250 ms apart, so drift contributes the same amount to each:
  // C1,C2 closed | C2,O1 across the change | O1,O2 open.
  const seq = [[0, 400], [0, 250], [1, 250], [1, 250]];
  for (let i = 0; i < seq.length; i++) {
    await ev(`DroneFace.setMouth(${seq[i][0]}, ${seq[i][0] ? 0.55 : 0})`);
    await sleep(seq[i][1]);
    await stash(`__shot${i}`, await shot(clip));
  }
  await ev('DroneFace.setMouth(0, 0)');      // leave no manual override behind
  return call(`async (names) => {
    const load = async (k) => createImageBitmap(new Blob([Uint8Array.from(atob(window[k]), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const imgs = [];
    for (const n of names) imgs.push(await load(n));
    const c = new OffscreenCanvas(imgs[0].width, imgs[0].height);
    const g = c.getContext('2d', { willReadFrequently: true });
    const grab = (img) => { g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const data = imgs.map(grab);
    const diff = (a, b) => {
      let sum = 0, n = 0;
      for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++;
      }
      return +(sum / n).toFixed(2);
    };
    return {
      cross: diff(data[1], data[2]),                    // the pair that spans the change
      same: [diff(data[0], data[1]), diff(data[2], data[3])],   // same mouth, same spacing
      size: c.width + 'x' + c.height,
    };
  }`, [['__shot0', '__shot1', '__shot2', '__shot3']]);
}

// Where the lit mass sits on screen, as a fraction of the frame. A yaw rotation changes the
// silhouette's shape more than its position, so an alignment search finds nothing; the
// centroid is the first moment and it does move. Pixels from the screen — evidence that the
// model matrix reached the GPU, in the same spirit as reading uMouthOpen back for the mouth.
async function litCentroid(key) {
  return call(`async (k) => {
    const img = await createImageBitmap(new Blob([Uint8Array.from(atob(window[k]), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let w = 0, sx = 0, sy = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4, lum = d[i] + d[i + 1] + d[i + 2];
      w += lum; sx += lum * x; sy += lum * y;
    }
    return { cx: +(sx / w / c.width).toFixed(5), cy: +(sy / w / c.height).toFixed(5) };
  }`, [key]);
}

// wait for the idle machine to reach a pose, so the check is about the cycle and not about
// wall-clock luck
async function untilIdle(pred, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const g = await ev('__DF.getIdle()');
    if (pred(g)) return g;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what + ', last pose ' + JSON.stringify(g));
    await sleep(200);
  }
}

// sample the mouth once per frame for ms milliseconds
await ev(`window.__sample = (ms) => new Promise((done) => {
  const out = [], t0 = performance.now();
  const step = () => {
    const m = __DF.getMouth();
    out.push([m.open, m.width, DroneFace.state]);
    if (performance.now() - t0 < ms) requestAnimationFrame(step); else done(out);
  };
  requestAnimationFrame(step);
});
window.__motion = (out) => ({
  peakOpen: +Math.max(...out.map((o) => o[0])).toFixed(3),
  moving: out.filter((o, i) => i && Math.abs(o[0] - out[i - 1][0]) > 0.01).length,
  spoke: out.some((o) => o[2] === 'speaking'),
  // what matters after a stop() is where the mouth ends up, not how wide it was when the
  // cut landed — the release ramp has to come down through the window either way
  lastOpen: +out[out.length - 1][0].toFixed(3),
  settled: out.slice(-Math.ceil(out.length * 0.4)).every((o, i, a) => !i || Math.abs(o[0] - a[i - 1][0]) < 0.005),
});`);

await ev('DroneFace.start()');
for (let i = 0; i < 100 && (await ev('__DF.getState()')) !== 'active'; i++) await sleep(100);

// --- assertions -------------------------------------------------------------
const results = [];
let r;
const assert = (name, ok, detail) => { results.push({ name, ok, detail }); };

async function speakAndWatch(setup, say, ms) {
  if (setup) await ev(setup);
  await settle();
  const sample = await ev(`(async () => {
    DroneFace.speak(${JSON.stringify(say)});
    return __motion(await __sample(${ms}));
  })()`);
  return { sample, status: await ev('DroneFace.voiceStatus()') };
}

// --- the settings the page ships with, then the live server if it is up -----------
// the shader must be receiving what the analysis computed
await ev('DroneFace.setIdleMotion(false)');   // the pixel checks below need a still head
const uniformCheck = await ev(`(async () => {
  DroneFace.setMouth(1, 0.6);
  await new Promise((r) => setTimeout(r, 400));
  const hi = __DF.getUniforms();
  DroneFace.setMouth(0, 0);
  await new Promise((r) => setTimeout(r, 400));
  return { hi, lo: __DF.getUniforms() };
})()`);
assert('the mouth uniforms track the computed mouth', uniformCheck.hi.mouthOpen > 0.8 && uniformCheck.lo.mouthOpen < 0.1, JSON.stringify(uniformCheck));
const px = await mouthOpensOnScreen();
const baseline = (px.same[0] + px.same[1]) / 2;
console.log(`   mouth pixel evidence: across the change ${px.cross} vs same-state drift ${px.same.join('/')} (${px.size})`);
assert('the mouth visibly opens on screen, not just in the numbers',
  px.cross > 3 && px.cross > 1.5 * baseline, JSON.stringify(px));

const seeded = await ev('DroneFace.voiceStatus()');
assert('first load seeds the lab TTS endpoint', /:8091\/v1\/audio\/speech$/.test(seeded.endpoint) && seeded.model === 'qwen3-tts', JSON.stringify(seeded));

if (live) {
  // One live utterance, measured from silence: the page asks for a stream, so this is
  // the number that matters on stage — click to first mouth movement. Measuring from
  // silence matters, or the previous utterance is still open and it reads 0 ms.
  const liveRun = await ev(`(async () => {
    DroneFace.setEndpoint(${JSON.stringify(live.origin)});
    DroneFace.setModel(${JSON.stringify(live.model)});
    DroneFace.stop();
    const quiet = async (ms) => {
      const t = performance.now();
      while (performance.now() - t < ms) {
        if (__DF.getMouth().open < 0.05 && !DroneFace.voiceStatus().audioActive) return true;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return false;
    };
    if (!await quiet(6000)) return { settled: false };
    const t0 = performance.now();
    let first = null;
    DroneFace.speak('Counting the drones, one two three four five.');
    await new Promise((done) => {
      const step = () => {
        if (first === null && __DF.getMouth().open > 0.15) first = Math.round(performance.now() - t0);
        if (first !== null || performance.now() - t0 > 6000) return done();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const motion = __motion(await __sample(2600));
    const out = DroneFace.voiceStatus();
    return { settled: true, first, motion, mode: out.mode, detail: out.detail };
  })()`);
  assert('live qwen3-tts streams and lip-syncs',
    liveRun.mode === 'tts-stream' && liveRun.motion && liveRun.motion.peakOpen > 0.3 && liveRun.motion.moving > 5, JSON.stringify(liveRun));
  if (liveRun.first != null) console.log(`note: mouth started ${liveRun.first} ms after the click (was ~2000 ms buffered) — ${liveRun.detail}`);
  else console.log('note: live latency not measured', JSON.stringify(liveRun));

  // the panel's voice suggestions should have come from the server, not from CONFIG
  const liveVoices = await ev(`(() => {
    const dl = document.getElementById('ttsVoiceList');
    return { n: dl.options.length, has: [...dl.options].some((o) => o.value === 'aiden'), line: document.getElementById('ttsStatus').textContent };
  })()`);
  assert('live server supplies the voice list', liveVoices.has && liveVoices.n >= 5 && /\d+ voices \(server\)/.test(liveVoices.line), JSON.stringify(liveVoices));

  // the adaptive gain remembers how loud that was; give it time to forget or the
  // quieter fake payloads below read as a nearly closed mouth
  await sleep(4000);
} else {
  console.log('note: no qwen3-tts box on 127.0.0.1:8091 — live check skipped');
}

await settle();
r = await ev(`(async () => {
  DroneFace.speakFromUrl(${JSON.stringify(origin + '/speech.wav')});
  return __motion(await __sample(2500));
})()`);
assert('audio file through the analyser moves the mouth', r.peakOpen > 0.4 && r.moving > 10, JSON.stringify(r));
await sleep(1000);

r = await speakAndWatch(`DroneFace.setEndpoint(${JSON.stringify(origin + '/legacy')})`, 'legacy shape check', 2500);
assert('configured endpoint plays and lip-syncs', r.sample.peakOpen > 0.4 && r.sample.moving > 10 && r.status.mode === 'tts', JSON.stringify(r));
assert('legacy endpoint gets {text,voice}', served.at(-1)?.body.text === 'legacy shape check', JSON.stringify(served.at(-1)));
await sleep(1000);

r = await speakAndWatch(`DroneFace.setEndpoint(${JSON.stringify(origin + '/openai/v1/audio/speech')});DroneFace.setModel('qwen3-tts');DroneFace.setVoice('fresh')`, 'openai shape check', 2500);
assert('OpenAI-style endpoint plays and lip-syncs', r.sample.peakOpen > 0.4 && r.sample.moving > 10 && r.status.model === 'qwen3-tts', JSON.stringify(r));
assert('OpenAI endpoint gets {model,input,voice}', served.at(-1)?.body.input === 'openai shape check' && !('text' in served.at(-1).body), JSON.stringify(served.at(-1)));
await sleep(1000);

r = await speakAndWatch(`DroneFace.setEndpoint(${JSON.stringify(origin + '/broken')})`, 'this endpoint 404s', 2200);
assert('404 endpoint still moves the mouth', r.sample.peakOpen > 0.3 && r.sample.moving > 10, JSON.stringify(r.sample));
assert('404 endpoint says why it fell back', r.status.mode === 'simulated' && /404/.test(r.status.detail), r.status.detail);
await sleep(1500);

r = await speakAndWatch(`DroneFace.setEndpoint('')`, 'no endpoint configured at all, hello there friend', 2600);
assert('no endpoint still moves the mouth', r.sample.peakOpen > 0.3 && r.sample.moving > 10, JSON.stringify(r.sample));
assert('no endpoint reports the reason', /no TTS endpoint configured/.test(r.status.detail), r.status.detail);
const lineAfterFallback = await ev(`(document.getElementById('ttsStatus') || {}).textContent || ''`);
assert('status line names the mode and the reason', /simulated/.test(lineAfterFallback) && /endpoint/.test(lineAfterFallback), lineAfterFallback);

r = await speakAndWatch(`DroneFace.setEndpoint(${JSON.stringify(origin + '/stream/v1/audio/speech')})`, 'streamed chunks should start the mouth almost at once', 1900);
assert('streamed PCM plays and lip-syncs', r.sample.peakOpen > 0.3 && r.sample.moving > 5 && r.status.mode === 'tts-stream', JSON.stringify(r));
assert('stream reports first-sound latency', /first sound at \d+ ms/.test(r.status.detail), r.status.detail);


// the panel must offer the voices the server actually has, not a hardcoded list
await ev(`document.getElementById('ttsEndpoint').value = ${JSON.stringify(origin + '/stream/v1/audio/speech')};
  document.getElementById('ttsEndpoint').dispatchEvent(new Event('input'));  // the refresh is debounced`);
await sleep(900);
const voices = await ev(`(() => {
  const dl = document.getElementById('ttsVoiceList');
  return { n: dl.options.length, has: [...dl.options].some((o) => o.value === 'server-only-voice'), line: document.getElementById('ttsStatus').textContent };
})()`);
assert('voice suggestions come from the server', voices.has && voices.n >= 4, JSON.stringify(voices));
assert('status line counts the voices', /\d+ voices \(server\)/.test(voices.line), voices.line);

// one click per voice: pick it and say the sample line
const chips = await ev(`(() => {
  const box = document.getElementById('ttsVoices');
  return { n: box.querySelectorAll('button[data-voice]').length, hidden: box.hidden };
})()`);
assert('each voice gets a one-click audition chip', chips.n >= 4 && chips.hidden === false, JSON.stringify(chips));
const audition = await ev(`(async () => {
  document.querySelector('#ttsVoices button[data-voice="server-only-voice"]').click();
  await new Promise((r) => setTimeout(r, 900));
  return { voice: DroneFace.voiceStatus().voice, pressed: document.querySelector('#ttsVoices button[aria-pressed="true"]').dataset.voice, mode: DroneFace.voiceStatus().mode };
})()`);
assert('clicking a chip selects the voice and speaks', audition.voice === 'server-only-voice' && audition.pressed === 'server-only-voice' && /tts/.test(audition.mode), JSON.stringify(audition));
await sleep(1200);
await sleep(600);

const btnState = await ev(`(async () => {
  const btn = document.getElementById('voiceBtn');
  DroneFace.setEndpoint(${JSON.stringify(origin + '/slow')});
  DroneFace.speak('the server is taking a moment here');
  await new Promise((r) => setTimeout(r, 200));
  const during = btn.textContent;
  await new Promise((r) => setTimeout(r, 1400));
  return { during, after: btn.textContent, mode: DroneFace.voiceStatus().mode };
})()`);
assert('button says so while the server synthesises', /Synthesising/.test(btnState.during) && /Generate voice/.test(btnState.after) && btnState.mode === 'tts', JSON.stringify(btnState));

const ui = await ev(`({
  line: (document.getElementById('ttsStatus') || {}).textContent || '',
  panelHidden: (document.getElementById('ttsPanel') || { hidden: true }).hidden,
  toggles: !!document.getElementById('ttsBtn'),
})`);
assert('voice settings panel exists and starts collapsed', ui.toggles && ui.panelHidden, JSON.stringify(ui));


// open it and check it is a usable control: three inputs showing what is stored
const want = { endpoint: origin + '/legacy', model: 'qwen3-tts', voice: 'fresh' };
await ev(`DroneFace.setEndpoint(${JSON.stringify(want.endpoint)}); DroneFace.setModel(${JSON.stringify(want.model)}); DroneFace.setVoice(${JSON.stringify(want.voice)})`);
const panel = await ev(`(() => {
  document.getElementById('ttsBtn').click();
  const p = document.getElementById('ttsPanel').getBoundingClientRect();
  const bar = document.getElementById('voiceBar').getBoundingClientRect();
  return {
    hidden: document.getElementById('ttsPanel').hidden,
    inputs: [...document.querySelectorAll('#ttsPanel input')].map((i) => ({ id: i.id, value: i.value })),
    onScreen: p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth,
    aboveBar: p.bottom <= bar.top + 2,
    expanded: document.getElementById('ttsBtn').getAttribute('aria-expanded'),
  };
})()`);
assert('panel opens with endpoint, model and voice fields', panel.hidden === false && panel.expanded === 'true' && panel.inputs.length === 3, JSON.stringify(panel.inputs));
assert('panel fields mirror the stored settings',
  panel.inputs.find((i) => i.id === 'ttsEndpoint').value === want.endpoint &&
  panel.inputs.find((i) => i.id === 'ttsModel').value === want.model &&
  panel.inputs.find((i) => i.id === 'ttsVoice').value === want.voice, JSON.stringify(panel.inputs));
assert('panel sits on screen, above the voice bar', panel.onScreen && panel.aboveBar, JSON.stringify(panel));

// stop() must cut a playing TTS utterance, not just the simulation
await ev(`DroneFace.setEndpoint(${JSON.stringify(origin + '/legacy')}); DroneFace.speak('a sentence long enough to still be playing when we cut it off')`);
await sleep(600);
r = await ev(`(async () => { DroneFace.stop(); return __motion(await __sample(1200)); })()`);
assert('stop() cuts the voice mid-utterance',
  r.lastOpen < 0.12 && r.settled && (await ev('DroneFace.voiceStatus().audioActive')) === false, JSON.stringify(r));

// --- idle motion (spec §9.2): the head has to move on screen, not just in the numbers ---
// The tilt is deliberately only 3.5 degrees, below what a pixel estimate can call with
// confidence, so the screen evidence here is the 12 degree glance: big enough to measure,
// small enough to still read as a glance. The tilt is pinned by the deterministic cycle in
// the self-test.
await ev('DroneFace.stop(); DroneFace.setIdleMotion(true)');
// away from the corners: the UI is bright, stationary, and dilutes the centroid
const vp = await ev('({ w: innerWidth, h: innerHeight })');
const headClip = { x: Math.round(vp.w * 0.12), y: Math.round(vp.h * 0.1), width: Math.round(vp.w * 0.76), height: Math.round(vp.h * 0.72), scale: 1 };
await sleep(1500);
await stash('__idleA', await shot(headClip));
const glancePose = await untilIdle((g) => g.phase === 'hold' && Math.abs(g.yaw) > 10, 45000, 'a glance to hold');
await stash('__idleB', await shot(headClip));
await untilIdle((g) => g.phase === 'wait' && g.t > 1.5 && Math.abs(g.yaw) < 0.05 && Math.abs(g.roll) < 0.05,
  45000, 'the head back at centre');
await stash('__idleC', await shot(headClip));
const centre = await litCentroid('__idleA'), glance = await litCentroid('__idleB'), back = await litCentroid('__idleC');
const dxGlance = +((glance.cx - centre.cx) * 1000).toFixed(2), dxBack = +((back.cx - centre.cx) * 1000).toFixed(2);
console.log(`   idle evidence on screen: the glance slid the lit mass ${dxGlance} px per 1000 px wide, the return ${dxBack} px, pose ${JSON.stringify(glancePose)}`);
// the return frame is the noise floor for the same estimator on the same head, so the
// glance is judged against it rather than against a number invented here
assert('a glance actually turns the head on screen',
  Math.abs(dxGlance) >= 4 && Math.abs(dxGlance) > 8 * Math.max(0.1, Math.abs(dxBack)),
  JSON.stringify({ centre, glance, dxGlance, dxBack }));
assert('and the head returns to where it started', Math.abs(dxBack) <= 1.5, JSON.stringify({ centre, back, dxBack }));

await ev('DroneFace.setIdleMotion(false)');

assert('no uncaught exceptions in the page', exceptions.length === 0, exceptions.join(' | '));
assert('failures are warned on the console', warnings.some((w) => /TTS failed/.test(w)), warnings.join(' | '));

const pass = results.filter((x) => x.ok).length;
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '  :: ' + x.detail}`);
console.log(`---\n${pass}/${results.length} PASS`);

await send('Browser.close', {}, sid).catch(() => {});
ws.close(); chrome.kill(); server.close();
process.exit(pass === results.length ? 0 : 1);
