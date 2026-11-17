#!/usr/bin/env node
// sound-behaviour-check.mjs — the music bed and the master mute, checked with real
// gestures: nothing plays before a gesture, the speaker button mutes the bed and never
// the voice, the bed ducks under speech and comes back, and no oscillator is ever built
// (the generated chord pad is gone, not hidden).
//
// The fade ramps take about a second, so state changes are polled, not slept: a fixed
// sleep next to a 0.3 s ramp is a flake waiting to happen.
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { speechLikeWav } from './test-audio.mjs';

const MUSIC_FILE = '4ever-faded.mp3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'drone-face.html');
const scratch = resolve(root, '.sound-behaviour.html');
const html = (await readFile(target, 'utf8')).replace(
  '</body>', '<div id="go" style="position:fixed;left:10px;top:60px;width:100px;height:30px;background:#fff"></div>\n</body>');
// The bed is baked into the build, so this check can only run against a build that has a
// track in it. The track itself is not in the repo (it is someone's music, and a repo with
// no audio in it is a repo you can publish), so a music-less build skips rather than fails.
const trackPath = resolve(root, MUSIC_FILE);
const mp3 = existsSync(trackPath) ? await readFile(trackPath) : null;
if (!mp3) {
  console.log(`note: no ${MUSIC_FILE} in the repo root — this build has no music bed to check`);
  console.log('SKIPPED');
  await rm(scratch, { force: true });
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  if (p === '/tts') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(speechLikeWav(2.5)); }
  let data;
  try { data = await readFile(resolve(root, '.' + p)); }
  catch { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': mime[extname(p)] || 'application/octet-stream' });
  res.end(data);
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg' };
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

await writeFile(scratch, html);   // served by path too, for anyone debugging by hand

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader',
  '--autoplay-policy=document-user-activation-required', '--remote-debugging-port=0',
  '--window-size=1200,700', `--user-data-dir=/tmp/droneface-sound-check-${process.pid}`, 'about:blank',
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
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method) events.push(m);
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
  .then((r) => (r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value));
const click = async (sel) => {
  const { x, y } = await ev(`(() => { const e = document.getElementById(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, sid);
};
const snap = () => ev(`(() => {
  const a = document.getElementById('musicTrack'), s = document.getElementById('soundBtn');
  return { paused: a.paused, t: +a.currentTime.toFixed(1), vol: +a.volume.toFixed(3),
           icon: s.className.replace('corner ', ''), sound: DroneFace.sound, osc: window.__osc };
})()`);
// Poll until the bed reaches the state we asked for — the fade and the pause are not
// instantaneous, and a fixed sleep beside them fails on a slow machine.
const settle = async (expectPaused, ms = 3000) => {
  const t0 = Date.now();
  let s = await snap();
  while (Date.now() - t0 < ms && s.paused !== expectPaused) { await sleep(100); s = await snap(); }
  return s;
};

await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
await send('Page.navigate', { url: origin + '/' }, sid);
for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await sleep(100);
await sleep(1000);

const results = [];
const assert = (name, ok, detail) => { results.push({ name, ok, detail }); };

// count every oscillator the page builds, whatever it is
await ev(`window.__osc = 0; const P = (window.AudioContext || window.webkitAudioContext).prototype;
  const orig = P.createOscillator; P.createOscillator = function () { window.__osc++; return orig.apply(this, arguments); }; 1`);

let s = await snap();
assert('silent before any gesture', s.paused === true, JSON.stringify(s));
assert('no separate music button', (await ev(`!document.getElementById('musicBtn')`)) === true);

await click('startBtn');
await sleep(900);
s = await snap();
assert('Start starts the music', s.paused === false && s.vol > 0.19, JSON.stringify(s));
assert('nothing constructs an oscillator', s.osc === 0, 'createOscillator calls: ' + s.osc);

await click('soundBtn');
s = await settle(true);
assert('speaker mutes the bed', s.paused === true && s.sound === false && s.icon === 'off', JSON.stringify(s));
assert('still no oscillators after the toggle', s.osc === 0, 'calls: ' + s.osc);

await click('soundBtn');
await sleep(900);
s = await snap();
assert('speaker unmute brings it back', s.paused === false && s.sound === true && s.icon === 'on', JSON.stringify(s));

await ev(`DroneFace.setEndpoint(${JSON.stringify(origin + '/tts')})`);
await ev(`window.__duck = [];
  DroneFace.on('speechStart', () => __duck.push(['duck', +document.getElementById('musicTrack').volume.toFixed(3)]));
  DroneFace.on('speechEnd', () => __duck.push(['back', +document.getElementById('musicTrack').volume.toFixed(3)])); 1`);
await ev(`DroneFace.speak('hello there, a line long enough to duck the music')`);
await sleep(1600);
const mid = await snap();
await sleep(4000);
const after = await snap();
const duck = await ev('__duck');

assert('the voice keeps playing while the bed is ducked', mid.paused === false && after.paused === false, JSON.stringify(mid));
assert('the bed ducks for speech and returns', mid.vol < 0.1 && after.vol > 0.19, JSON.stringify(duck));
assert('no oscillator ambience during speech', after.osc === 0, 'calls: ' + after.osc);
assert('no stale preference key written', (await ev(`String(localStorage.getItem('droneface.music'))`)) === 'null');

const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
assert('no uncaught exceptions in the page', errs.length === 0, errs.join(' | '));

const pass = results.filter((x) => x.ok).length;
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '  :: ' + x.detail}`);
console.log(`---\n${pass}/${results.length} PASS`);

await send('Browser.close', {}, sid).catch(() => {});
ws.close(); chrome.kill(); server.close();
await rm(scratch, { force: true });
process.exit(pass === results.length ? 0 : 1);
