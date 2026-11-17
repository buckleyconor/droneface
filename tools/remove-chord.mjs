#!/usr/bin/env node
// tools/remove-chord.mjs — silence the generated chord pad in an already-built HTML
// file by stubbing the function that builds it. Use this when the file did not come
// from `npm run build` (a hand-tuned drone-face-cl2.html, say); src/main.js has
// simply had the pad deleted.
//
//   node tools/remove-chord.mjs drone-face-cl2.html     # patch in place
//   node tools/remove-chord.mjs --check <file>          # report, write nothing
//
// The pad is the one function whose body builds four or more oscillators at once; the
// lip-sync analyser and the voice buffer source never create oscillators, so that
// signature is unambiguous. Its body is replaced with a comment, which also stops the
// oscillators from ever being constructed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const target = resolve(root, args.find((a) => a !== '--check') ?? 'drone-face.html');

const STUB = '{ /* generated chord pad removed: the embedded music track replaced it */ }';
const MARK = 'generated chord pad removed';

/** Index of the `}` that closes the block starting at `open`, or -1. */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

let html = readFileSync(target, 'utf8');
if (html.includes(MARK)) {
  console.log(`${target}\n  chord: already removed\n  --check: ${check ? 'up to date' : 'nothing to do'}`);
  process.exit(0);
}

const sig = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/g;
let m, found = null;
while ((m = sig.exec(html))) {
  const open = m.index + m[0].length - 1;
  const close = closeOf(html, open);
  if (close < 0) continue;
  const body = html.slice(open, close + 1);
  const oscillators = (body.match(/createOscillator/g) || []).length;
  if (oscillators >= 4) { found = { name: m[1], start: m.index, end: close + 1, body, oscillators }; break; }
}

if (!found) {
  // A build from current src/main.js has no pad at all, so this is the clean state.
  console.log(`${target}\n  chord: not present (nothing builds 4+ oscillators)\n  ${check ? '--check: ' : ''}nothing to do`);
  process.exit(0);
}

console.log(`${target}`);
console.log(`  chord: function ${found.name}() — ${found.oscillators} oscillators, ${found.body.length} bytes`);
if (check) { console.log('  --check: needs removing (nothing written)'); process.exit(0); }

const out = html.slice(0, found.start) + `function ${found.name}()` + STUB + html.slice(found.end);
writeFileSync(target, out);
console.log('  written: body stubbed, oscillators never constructed');
