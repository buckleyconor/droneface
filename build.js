#!/usr/bin/env node
// build.js — bundle src/main.js (three.js tree-shaken) and inline it into a
// single offline HTML file. `node build.js` builds the deliverable
// (drone-face.html); `node build.js dev` writes an unminified bundle for
// development (open src/index.html).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dev = process.argv[2] === 'dev';

async function run() {
  const outfile = resolve(root, dev ? 'dist/bundle.js' : 'dist/bundle.min.js');

  const result = await build({
    entryPoints: [resolve(root, 'src/main.js')],
    bundle: true,
    minify: !dev,
    format: 'iife',
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'info',
    outfile,
  });

  if (dev) {
    console.log('dev bundle -> dist/bundle.js  (open src/index.html)');
    return;
  }

  const js = readFileSync(outfile, 'utf8');
  const html = readFileSync(resolve(root, 'src/index.html'), 'utf8');
  const needle = '<script src="../dist/bundle.js"></script>';
  if (!html.includes(needle)) {
    throw new Error('src/index.html is missing the bundle <script> tag');
  }
  // function replacement: avoids $& / $1 expansion in the bundled JS
  const inlined = html.replace(needle, () => '<script>\n' + js + '\n</script>');

  const out = resolve(root, 'drone-face.html');
  writeFileSync(out, inlined);
  const kb = statSync(out).size / 1024;
  console.log(`drone-face.html written: ${kb.toFixed(1)} KB (js ${(js.length / 1024).toFixed(1)} KB)`);
}

mkdirSync(resolve(root, 'dist'), { recursive: true });
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
