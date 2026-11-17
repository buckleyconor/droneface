#!/usr/bin/env node
// tools/inject-music.mjs — add (or refresh) the background-music bed in an
// already-built HTML file, using src/index.html as the single source of truth for
// the markup, styles and glue script.
//
//   node tools/inject-music.mjs drone-face-cl2.html     # patch in place
//   node tools/inject-music.mjs --check <file>          # report, write nothing
//
// Use this when the file you are editing was not produced by `npm run build`
// (e.g. a hand-tuned drone-face-cl2.html). For built files, build.js already
// embeds the track.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'src/index.html');
const MUSIC_FILE = '4ever-faded.mp3';

const args = process.argv.slice(2);
const check = args.includes('--check');
const target = resolve(root, args.find((a) => a !== '--check') ?? 'drone-face.html');

/** Region between two marker comments in `text` (markers kept). */
function region(text, startMarker, endMarker, label) {
  const s = text.indexOf(startMarker);
  const e = text.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error(`src/index.html: ${label} markers not found`);
  return text.slice(s, e + endMarker.length);
}

/** Replace a region in `text` between markers, or insert it before `anchor`. */
function upsert(text, block, startMarker, endMarker, anchors) {
  const s = text.indexOf(startMarker);
  if (s >= 0) {
    const e = text.indexOf(endMarker, s);
    if (e < 0) throw new Error(`${startMarker} found without ${endMarker}`);
    return text.slice(0, s) + block + text.slice(e + endMarker.length);
  }
  for (const anchor of anchors) {
    const i = text.indexOf(anchor);
    if (i >= 0) return text.slice(0, i) + block + '\n\n' + text.slice(i);
  }
  throw new Error(`no insertion anchor found (tried: ${anchors.join(', ')})`);
}

const srcHtml = readFileSync(SRC, 'utf8');
const css = region(srcHtml, '/* music-bed:start */', '/* music-bed:end */', 'css');
const markup = region(srcHtml, '<!-- music-bed:start -->', '<!-- music-bed:end -->', 'markup');
const script = region(srcHtml, '<!-- music-bed-script:start -->', '<!-- music-bed-script:end -->', 'script');

const mp3 = resolve(root, MUSIC_FILE);
const mp3Buf = existsSync(mp3) ? readFileSync(mp3) : null;
if (!mp3Buf) console.warn(`warning: ${MUSIC_FILE} not found — music will be inert`);
const dataUri = mp3Buf ? 'data:audio/mpeg;base64,' + mp3Buf.toString('base64') : '';
const baked = (block) => block.replace(`src="../${MUSIC_FILE}"`, () => `src="${dataUri}"`);

let out = readFileSync(target, 'utf8');
const before = out;
out = upsert(out, css, '/* music-bed:start */', '/* music-bed:end */', ['</style>']);
out = upsert(out, baked(markup), '<!-- music-bed:start -->', '<!-- music-bed:end -->',
  ['<div id="voiceBar">', '<div id="fallback"', '</canvas>']);
out = upsert(out, script, '<!-- music-bed-script:start -->', '<!-- music-bed-script:end -->',
  ['</body>']);

const changed = out !== before;
console.log(`${target}`);
console.log(`  music bed: ${/id="musicTrack"/.test(before) ? 'present -> refreshed' : 'inserted'}`);
console.log(`  track: ${mp3Buf ? `${(mp3Buf.length / 1024).toFixed(0)} KB embedded` : 'missing'}`);
console.log(`  size: ${(Buffer.byteLength(before) / 1024).toFixed(0)} KB -> ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);

if (check) {
  console.log(changed ? '  --check: needs the injection above' : '  --check: up to date');
} else if (changed) {
  writeFileSync(target, out);
  console.log('  written');
} else {
  console.log('  up to date');
}
