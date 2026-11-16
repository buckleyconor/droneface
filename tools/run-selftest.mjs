#!/usr/bin/env node
// run-selftest.mjs — serve the repo over HTTP, run tools/selftest.html in
// headless Chromium, and report the N/N PASS result.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain',
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/tools/selftest.html';
  const file = resolve(root, '.' + p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/tools/selftest.html`;

const proc = spawn('chromium', [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--virtual-time-budget=15000',
  '--dump-dom',
  url,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '', err = '';
proc.stdout.on('data', (d) => (out += d));
proc.stderr.on('data', (d) => (err += d));
const code = await new Promise((r) => proc.on('close', r));
server.close();

// extract the <pre id="out"> content and the title
const pre = (out.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
console.log('--- self-test output ---');
console.log((pre || title || '').replace(/<[^>]+>/g, '').trim());
console.log('---');

const m = (pre + ' ' + title).match(/(\d+)\/(\d+) PASS/);
if (m && m[1] === m[2]) {
  console.log(`SELFTEST PASS ${m[1]}/${m[2]}`);
  process.exit(0);
}
console.log('SELFTEST FAILED' + (m ? ` (${m[1]}/${m[2]})` : ' (no result)'));
if (err) console.log('\nchromium stderr tail:\n' + err.slice(-1500));
process.exit(1);
