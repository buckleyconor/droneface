// Drone Swarm Face — application code
// Sections follow the spec §13: constants/config, face generator, shaders,
// state machine, input, audio & lip sync, TTS client, public API, render loop.
import {
  WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, BufferAttribute,
  ShaderMaterial, Points, Color, Matrix4, AdditiveBlending,
} from 'three';

/* ============================================================================
 * 1. constants and config
 * ==========================================================================*/

const CONFIG = {
  // drone counts
  counts: {
    face: 3640,   // silhouette lattice, thinned by the density map
    hair: 420,    // five wavy strands offset from the silhouette
    eyes: 75,     // lid curves, iris rings and catchlight (the blink group)
    ears: 70,     // two flattened rings per side
  },
  reducedCounts: {
    face: 1820,
    hair: 210,
    eyes: 50,
    ears: 40,
  },
  reserveFraction: 0.285,  // share of drones hidden while dispersed (start screen)

  // head extents in normalised units (the profile itself lives in section 2)
  head: { rx: 0.60, ry: 1.0, rz: 0.55 },

  // colours
  colorFace: '#19e6d3',
  colorHair: '#d9b8f0',   // lavender accent; ?accent= below can switch it
  colorNeck: '#19e6d3',   // face turquoise, kept for the (unused) group-2 slot
  colorRim: '#7ff5ea',
  background: '#02060d',

  // formation / dispersal timing (seconds)
  formDuration: 6.0,
  disperseDuration: 4.0,
  formStagger: 0.25,      // fraction of duration a drone can lag (shader)

  // orientation limits (degrees) and feel
  yawLimit: 35,
  pitchLimit: 25,
  dragSensitivity: 0.25,  // degrees per px
  orientSmooth: 0.1,      // seconds time constant
  recentreDelay: 3.0,     // seconds of no input before easing back to centre
  recentreEnabled: true,

  // idle motion (spec §9.2): the slow gesture cycle a waiting face runs so it is not a statue
  idleMotion: {
    tiltDeg: 3.5,         // roll, ear toward shoulder. This is the maximum, ever
    holdTilt: 3.0,
    lookDeg: 12,          // a glance off to the side, about a third of the drag limit
    holdLook: 2.0,
    gap: 10.0,            // seconds of nothing between gestures
    moveIn: 1.6,          // seconds to reach a pose, eased
    moveOut: 1.4,         // seconds to return to centre
  },

  // camera
  fov: 35,
  faceFractionHeight: 0.80, // head (2 units) fills this fraction of viewport height
  faceFractionWidth: 0.90,

  // points
  pointFraction: 0.0078,    // point diameter as fraction of viewport height (device px)
  pointMax: 48.0,

  // lip sync
  analyserFFT: 1024,
  smoothing: 0.3,
  mouthAttack: 0.040,
  mouthRelease: 0.120,
  widthAttack: 0.080,
  widthRelease: 0.180,
  noiseFloor: 0.004,
  peakDecay: 1.5,           // adaptive gain peak decay (s)

  // voice backend (spec §11). The endpoint is seeded into localStorage on first load
  // only — the settings panel and ?endpoint= override it, and blank means "use the
  // browser voice", so this never silently wins over a deliberate choice. Model name is
  // what the server reports at /v1/models; the voice list is what its own 400 error
  // lists (verified against vllm-omni serving Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice).
  tts: {
    endpoint: 'http://127.0.0.1:8091/v1/audio/speech',
    model: 'qwen3-tts',
    voice: 'default',
    voices: ['default', 'aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian'],
    sample: 'A swarm of drones, holding formation in the dark.',   // what a voice chip says
    stream: true,        // ask for SSE PCM chunks; falls back to a complete file
    pcmRate: 24000,      // what the server's PCM arrives at (checked against the WAV)
  },

  // blink
  blinkMin: 3.0,
  blinkMax: 6.0,
  blinkDuration: 0.22,

  // performance
  dprCap: 2,
  fpsWarmupFrames: 60,
  fpsMin: 40,

  // sound: the speaker button is a master mute for the background music bed
  // (src/index.html). The generated chord pad that used to live here was removed in
  // favour of the embedded loop; its fade/duck constants went with it.
};

// Accent (hair) colour from the URL, so a demo can be re-skinned without a rebuild:
// ?accent=lavender|ice|warm, default lavender.
try {
  const accent = new URLSearchParams(location.search).get('accent');
  const palette = { lavender: '#d9b8f0', ice: '#c4fbf4', warm: '#ffe2b0' };
  CONFIG.colorHair = palette[accent] || palette.lavender;
} catch (_) {}

/* ============================================================================
 * 2. face generator
 * ==========================================================================*/

// Named, tunable feature parameters (spec §7). Head-local units: y is normalised
// head height (+1 = crown, -1 = chin), x is left/right in the same units, z is
// toward the viewer. Traced against reference_image.png.
const FACE = {
  mouthY: -0.595,
  mouthHalfW: 0.234,      // mouth width 39% of face width
  mouthHalfH: 0.14,
  eyeX: 0.342,            // eye centre x (separation 57% of face width)
  eyeY: 0.02,
  smile: 0.026,           // mouth line rises this much toward the corners

  // relief: Gaussian bumps/dips {cx, cy, sx, sy, amp} (amp + = toward the viewer).
  // The nose is a separate profile (noseZ), so it is not listed here.
  relief: [
    // eye sockets (deep), with a shallow ridge at the lid rim
    { cx: -0.342, cy: 0.02, sx: 0.095, sy: 0.048, amp: -0.16 },
    { cx:  0.342, cy: 0.02, sx: 0.095, sy: 0.048, amp: -0.16 },
    { cx: -0.342, cy: 0.02, sx: 0.07,  sy: 0.035, amp:  0.06 },
    { cx:  0.342, cy: 0.02, sx: 0.07,  sy: 0.035, amp:  0.06 },
    // brow shadow band above the eyes
    { cx: -0.342, cy: 0.13, sx: 0.13, sy: 0.05, amp: -0.05 },
    { cx:  0.342, cy: 0.13, sx: 0.13, sy: 0.05, amp: -0.05 },
    // nostrils (deep)
    { cx: -0.052, cy: -0.372, sx: 0.03, sy: 0.018, amp: -0.07 },
    { cx:  0.052, cy: -0.372, sx: 0.03, sy: 0.018, amp: -0.07 },
    // cheekbones (defined)
    { cx: -0.38, cy: -0.1, sx: 0.1, sy: 0.12, amp: 0.075 },
    { cx:  0.38, cy: -0.1, sx: 0.1, sy: 0.12, amp: 0.075 },
    // upper lip, lower lip, chin
    { cx: 0.0, cy: -0.54, sx: 0.1, sy: 0.03, amp: 0.13 },
    { cx: 0.0, cy: -0.655, sx: 0.1, sy: 0.04, amp: 0.14 },
    { cx: 0.0, cy: -0.90, sx: 0.12, sy: 0.10, amp: 0.10 },
    // jawline
    { cx: -0.26, cy: -0.74, sx: 0.09, sy: 0.1, amp: 0.05 },
    { cx:  0.26, cy: -0.74, sx: 0.09, sy: 0.1, amp: 0.05 },
  ],
};

// Cranium dome, above which the profile curve stops applying: half-width is
// a*sqrt(1-q^2) with q = (y - y0)/b.
const CRANIUM = { a: 0.585, b: 0.38, y0: 0.62 };

// Monotone cubic Hermite interpolation (Fritsch-Carlson limiter) through
// [[x, y], ...], with the end slopes given. Monotone matters: a Catmull-Rom or a
// polynomial overshoots and the head profile bulges where it should not.
function pchip(points, endSlopeLo, endSlopeHi) {
  const n = points.length;
  const h = [], d = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = points[i + 1][0] - points[i][0];
    d[i] = (points[i + 1][1] - points[i][1]) / h[i];
  }
  m[0] = endSlopeLo;
  m[n - 1] = endSlopeHi;
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {                       // keep the secant slope ratio inside the circle
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return function (x) {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let j = 0;
    while (x > points[j + 1][0]) j++;
    const t = (x - points[j][0]) / h[j], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * points[j][1] + (t3 - 2 * t2 + t) * h[j] * m[j] +
           (-2 * t3 + 3 * t2) * points[j + 1][1] + (t3 - t2) * h[j] * m[j + 1];
  };
}

// Half-width squared across the face plane (widest at the cheekbones, tapering to
// the jaw and the temple). Squared so the shoulder at the chin is smooth.
const halfWidthSq = pchip([
  [-1.000, 0.0000], [-0.966, 0.0121], [-0.933, 0.0306], [-0.832, 0.0961],
  [-0.697, 0.1936], [-0.563, 0.2630], [-0.361, 0.3170], [-0.025, 0.3520],
  [0.311, 0.3480], [0.620, 0.3420],
], 0.36, 0);

// How far forward the surface sits at each height (the face plane is not flat).
const depthCurve = pchip([
  [-1.0, 0.12], [-0.9, 0.33], [-0.7, 0.44], [-0.4, 0.50], [0.0, 0.52],
  [0.3, 0.50], [0.6, 0.45], [0.85, 0.34], [1.0, 0.12],
], 0.8, -1.6);

function headHalfWidth(y) {
  if (y >= 1 || y <= -1) return 0;
  if (y > CRANIUM.y0) {
    const q = (y - CRANIUM.y0) / CRANIUM.b;
    return CRANIUM.a * Math.sqrt(Math.max(0, 1 - q * q));
  }
  return Math.sqrt(Math.max(0, halfWidthSq(y)));
}

// Nose: a ridge from the brow to the tip, widening as it descends, with a Gaussian
// tip. It is a profile rather than a bump list so the bridge stays narrow.
function noseZ(x, y) {
  const yBrow = 0.03, yTip = -0.285;
  const t = (yBrow - y) / (yBrow - yTip);
  let ridge = 0;
  if (t > 0) {
    const ramp = Math.min(1, t);
    let s = Math.min(1, ramp / 0.12);
    s = s * s * (3 - 2 * s);                       // fade the bridge in below the brow
    const depth = 0.19 * ramp * s;
    const sx = 0.062 + 0.03 * ramp;
    const tail = t > 1 ? Math.exp(-0.5 * Math.pow((yTip - y) / 0.045, 2)) : 1;
    ridge = depth * tail * Math.exp(-0.5 * x * x / (sx * sx));
  }
  const tip = 0.05 * Math.exp(-0.5 * (x * x / 0.0072 + Math.pow((y - yTip) / 0.06, 2)));
  return ridge + tip;
}

// Mouth line: a shallow smile curve.
function mouthLineY(x) {
  const q = x / 0.22;
  return FACE.mouthY + FACE.smile * q * q;
}

function reliefZ(x, y) {
  let e = 0;
  for (const f of FACE.relief) {
    const dx = (x - f.cx) / f.sx, dy = (y - f.cy) / f.sy;
    e += f.amp * Math.exp(-0.5 * (dx * dx + dy * dy));
  }
  e += noseZ(x, y);
  const d = (y - mouthLineY(x)) / 0.014;           // the crease between the lips
  e += -0.055 * Math.exp(-0.5 * (d * d + x * x / 0.0121));
  return e;
}

// Front surface z; null outside the head. Relief is cross-faded out over the last
// 22% of the row so features do not poke through the silhouette edge.
function surfaceZ(x, y) {
  const w = headHalfWidth(y);
  if (w <= 1e-4) return null;
  const r = Math.abs(x) / w;
  if (r >= 1) return null;
  const base = depthCurve(y) * Math.pow(1 - Math.pow(r, 2.5), 0.4);
  let edge = Math.min(1, Math.max(0, (1 - r) / 0.22));
  edge = edge * edge * (3 - 2 * edge);
  return base + reliefZ(x, y) * edge;
}

function surfaceNormal(x, y) {
  const e = 8e-3;
  const f = (a, b) => { const z = surfaceZ(a, b); return z == null ? 0 : z; };
  const zx = (f(x + e, y) - f(x - e, y)) / (2 * e);
  const zy = (f(x, y + e) - f(x, y - e)) / (2 * e);
  const l = Math.hypot(zx, zy, 1);
  return { x: -zx / l, y: -zy / l, z: 1 / l };
}

// Brightness from the relief alone (the reference shades by dot brightness).
function reliefShade(x, y) {
  return Math.max(0.5, Math.min(1.5, 1 + reliefZ(x, y) * 5));
}

function gauss(x, y, cx, cy, sx, sy) {
  const a = (x - cx) / sx, b = (y - cy) / sy;
  return Math.exp(-0.5 * (a * a + b * b));
}

// Density-as-brightness: the reference is dark in the sockets, under the nose and
// around the mouth line, bright on the cheekbones, nose bridge and forehead.
function lightShade(x, y) {
  const ax = Math.abs(x), mY = FACE.mouthY;
  let dark = 0, hi = 0;
  dark += 0.50 * gauss(ax, y, 0.342, 0.03, 0.17, 0.10);   // sockets
  dark += 0.30 * gauss(ax, y, 0.34, 0.15, 0.20, 0.05);    // brow
  dark += 0.50 * gauss(ax, y, 0.36, -0.32, 0.14, 0.12);   // temple/cheek hollow
  dark += 0.30 * gauss(ax, y, 0.20, -0.50, 0.10, 0.10);   // beside the nose
  dark += 0.50 * gauss(x, y, 0, mY, 0.20, 0.065);         // mouth line
  dark += 0.40 * gauss(x, y, 0, -0.74, 0.12, 0.04);       // under the lower lip
  dark += 0.55 * gauss(x, y, 0, -0.385, 0.10, 0.032);     // philtrum
  dark += 0.40 * gauss(ax, y, 0.10, -0.10, 0.04, 0.15);   // nose shadow
  dark += 0.35 * gauss(ax, y, 0.14, -0.31, 0.04, 0.06);   // nostril shadow
  dark += 0.20 * gauss(ax, y, 0.52, 0.28, 0.08, 0.15);    // edge of the jaw
  dark += 0.20 * gauss(x, y, 0, -0.88, 0.30, 0.14);       // under the chin
  hi += 0.28 * gauss(ax, y, 0.37, -0.10, 0.10, 0.09);     // cheekbone
  hi += 0.35 * gauss(x, y, 0, -0.12, 0.035, 0.17);        // nose bridge
  hi += 0.35 * gauss(x, y, 0, -0.28, 0.055, 0.04);        // nose tip
  hi += 0.12 * gauss(x, y, 0, 0.45, 0.26, 0.15);          // forehead
  hi += 0.20 * gauss(x, y, 0, -0.88, 0.10, 0.05);         // chin
  return Math.max(0.2, Math.min(1.45, (1 - Math.min(0.8, dark)) * (1 + hi)));
}

// Probability that a lattice point stays, as a face density map: sparse in the
// sockets and the hollows, dense on the features. Clamped so no region vanishes.
function densityWeight(x, y) {
  let e = 1;
  e -= 0.9 * gauss(x, y, -0.342, 0.02, 0.1, 0.055);
  e -= 0.9 * gauss(x, y, 0.342, 0.02, 0.1, 0.055);
  e -= 0.5 * gauss(x, y, -0.052, -0.372, 0.028, 0.016);
  e -= 0.5 * gauss(x, y, 0.052, -0.372, 0.028, 0.016);
  e -= 0.35 * gauss(x, y, 0, -0.405, 0.07, 0.03);
  e -= 0.6 * gauss(x, y - (mouthLineY(x) - FACE.mouthY), 0, FACE.mouthY, 0.11, 0.013);
  e -= 0.2 * gauss(x, y, -0.1, -0.1, 0.04, 0.15);
  e -= 0.2 * gauss(x, y, 0.1, -0.1, 0.04, 0.15);
  e -= 0.3 * gauss(x, y, -0.342, 0.13, 0.12, 0.025);
  e -= 0.3 * gauss(x, y, 0.342, 0.13, 0.12, 0.025);
  return Math.max(0.2, Math.min(1, e * 2.2));
}

// Group ids: 0 face, 1 hair/ears/brows/lid rims, 3 mouth (moves with the lips).
function groupOf(x, y) {
  const a = x / FACE.mouthHalfW, b = (y - FACE.mouthY) / FACE.mouthHalfH;
  return a * a + b * b <= 1 ? 3 : 0;
}

// 0..1 lip weighting: how much a point inside the mouth ellipse rides the lips.
function mouthWeight(x, y) {
  const a = x / FACE.mouthHalfW, b = (y - FACE.mouthY) / FACE.mouthHalfH, s = a * a + b * b;
  return s >= 1 ? 0 : Math.pow(1 - s, 0.8);
}

// Jaw drop: the lower lip and everything under it goes down and slightly back, the
// upper lip rises a little. w is the lip weight.
function mouthOpenDelta(x, y, w) {
  return y < mouthLineY(x) - 1e-3
    ? { x: 0, y: -0.08 * w, z: -0.015 * w }
    : { x: 0, y: 0.012 * w, z: 0.005 * w };
}

// Lips widen: the surface slides outward from the centre line.
function mouthWideDelta(x, y, w) {
  return { x: x * 0.12 * w, y: 0, z: 0 };
}

// Lip profiles across the mouth, q = x / 0.22 (-1 .. 1).
function upperLipY(x) {
  const q = x / 0.22, a = Math.abs(q);
  if (a >= 1) return 0;
  const base = 0.05 * Math.pow(1 - q * q, 0.8);
  const bow = 0.012 * Math.exp(-Math.pow((a - 0.3) / 0.13, 2)) - 0.011 * Math.exp(-Math.pow(q / 0.09, 2));
  return Math.max(0, base + bow * (1 - q * q));
}

function lowerLipY(x) {
  const q = x / 0.22;
  return Math.abs(q) >= 1 ? 0 : 0.066 * Math.pow(1 - q * q, 0.7);
}

// The dark gap between the closed lips: no surface drones there, the lip rows draw
// the mouth instead.
function inLipGap(x, y) {
  if (Math.abs(x) >= 0.222) return false;
  const ml = mouthLineY(x);
  return y < ml + upperLipY(x) + 8e-3 && y > ml - lowerLipY(x) - 8e-3;
}

// Right-hand silhouette contour in the face plane: left side up, dome over the
// crown, right side down. Arc-length resampled so normals are usable. Cached.
let silhouetteCache = null;
function silhouette() {
  if (silhouetteCache) return silhouetteCache;
  const P = [];
  for (let i = 0; i <= 30; i++) {
    const y = 0.3 + (CRANIUM.y0 - 0.3) * i / 30;
    P.push([-headHalfWidth(y), y]);
  }
  for (let i = 1; i <= 120; i++) {
    const f = -Math.PI / 2 + Math.PI * i / 120;
    P.push([CRANIUM.a * Math.sin(f), CRANIUM.y0 + CRANIUM.b * Math.cos(f)]);
  }
  for (let i = 1; i <= 30; i++) {
    const y = CRANIUM.y0 + (0.3 - CRANIUM.y0) * i / 30;
    P.push([headHalfWidth(y), y]);
  }
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const N = 900;
  const L = cum[cum.length - 1];
  const pts = [];
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const s = L * i / N;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    pts.push({ x: P[j][0] + t * (P[j + 1][0] - P[j][0]), y: P[j][1] + t * (P[j + 1][1] - P[j][1]), s });
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
    pts[i].nx = ty / l;
    pts[i].ny = -tx / l;
  }
  silhouetteCache = { pts, len: L };
  return silhouetteCache;
}

// Distance from a face-plane point to the silhouette (used to keep drones off the
// outline and to seat the hair band).
function silhouetteDistance(x, y) {
  const S = silhouette().pts;
  let m = 1e9;
  for (let i = 0; i < S.length; i += 2) {
    const dx = S[i].x - x, dy = S[i].y - y, d = dx * dx + dy * dy;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}

// The hair band sits HAIR_INSET inside the silhouette above HAIR_Y, feathered in.
const HAIR_INSET = 0.145, HAIR_Y = 0.42;
function hairLimit(y) {
  const t = Math.max(0, Math.min(1, (y - 0.4) / 0.2));
  return HAIR_INSET * t * t * (3 - 2 * t);
}

// Hexagonal lattice over the face plane: rows at d*sqrt(3)/2, alternating rows
// offset by half a step, points placed by arc length along the surface curve so the
// spacing is even on the curved row, with a little jitter so it does not read as a
// grid.
function faceLattice(d) {
  const P = [];
  let rows = 0;
  const dy = d * 0.866;
  for (let y = 0.99; y > -0.99; y -= dy, rows++) {
    const yy = y + (Math.random() - 0.5) * d * 0.06;
    const w = headHalfWidth(yy);
    if (w < 0.02) continue;
    const us = [], zs = [], cum = [0];
    const K = 170;
    for (let i = 0; i <= K; i++) {
      let u = -w + 2 * w * i / K;
      if (i === 0) u += w * 1e-4;
      if (i === K) u -= w * 1e-4;
      const z = surfaceZ(u, yy);
      us.push(u);
      zs.push(z == null ? 0 : z);
    }
    for (let i = 1; i <= K; i++) cum.push(cum[i - 1] + Math.hypot(us[i] - us[i - 1], zs[i] - zs[i - 1]));
    const L = cum[K];
    const n = Math.max(1, Math.round(L / d));
    const sp = L / n;
    const odd = rows % 2 === 1;
    const cnt = odd ? n + 1 : n;
    for (let k = 0; k < cnt; k++) {
      let s = odd ? k * sp : (k + 0.5) * sp;
      s += (Math.random() - 0.5) * sp * 0.1;
      s = Math.max(0, Math.min(L, s));
      let j = 0;
      while (j < K - 1 && cum[j + 1] < s) j++;
      const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      P.push([us[j] + t * (us[j + 1] - us[j]), yy]);
    }
  }
  return P;
}

// Iterate the spacing to hit a target count (sqrt, since count goes as 1/d^2).
function faceDots(target) {
  let d = 0.021, P;
  for (let it = 0; it < 5; it++) {
    P = faceLattice(d);
    d *= Math.sqrt(P.length / target);
  }
  return faceLattice(d);
}

// Hair: arcs offset outward from the silhouette, with a two-frequency wobble so the
// strands look like hair rather than a rim. emit(x, y, strand) or null to count.
function hairArcs(spacing, emit) {
  const S = silhouette(), pts = S.pts;
  const strands = 5;
  let count = 0;
  for (let k = 0; k < strands; k++) {
    const off = 0.013 + k * 0.026;              // outward distance of this strand
    const yStart = 0.42 + k * 0.04;             // higher start for the outer strands
    let i0 = 0, i1 = pts.length - 1, len = 0;
    while (i0 < pts.length && pts[i0].y < yStart) i0++;
    while (i1 > 0 && pts[i1].y < yStart) i1--;
    for (let i = i0 + 1; i <= i1; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    len -= off * Math.PI * 0.9;                 // an offset arc is shorter in angle terms
    const n = Math.max(8, Math.round(len / spacing));
    const sp = (pts[i1].s - pts[i0].s) / n;
    for (let i = 0; i <= n; i++) {
      const s = pts[i0].s + (i + (k % 2 ? 0.5 : 0)) * sp;   // stagger alternate strands
      if (s > pts[i1].s) continue;
      const idx = Math.min(pts.length - 1, Math.max(0, Math.round(s / S.len * (pts.length - 1))));
      const q = pts[idx];
      const wobble = 9e-3 * Math.sin(s * 58 + k * 2.1) + 6e-3 * Math.sin(s * 131 + k);
      const d = off + wobble;
      const x = q.x + q.nx * d, y = q.y + q.ny * d;
      if (emit) emit(x, y, k);
      count++;
    }
  }
  return count;
}

const Z3 = { x: 0, y: 0, z: 0 };

function buildPoints(counts) {
  const pts = [];
  const rnd = Math.random;
  const reserve = () => rnd() < CONFIG.reserveFraction;

  const push = (x, y, z, n, group, shade, mo, mw2, blink, res) => {
    pts.push({ p: [x, y, z], n, group, shade, mo, mw2, blink, reserve: res });
  };

  // 1. face surface: lattice points, thinned by the density map, with the lip gap,
  //    the hair band and the outline kept clear.
  for (const [x, y] of faceDots(counts.face)) {
    if (y > HAIR_Y && silhouetteDistance(x, y) <= hairLimit(y)) continue;
    if (inLipGap(x, y)) continue;
    if (rnd() > densityWeight(x, y)) continue;
    const z = surfaceZ(x, y);
    if (z == null) continue;
    const w = mouthWeight(x, y);
    push(x, y, z, surfaceNormal(x, y), groupOf(x, y),
      reliefShade(x, y) * lightShade(x, y) * (0.93 + 0.14 * rnd()),
      mouthOpenDelta(x, y, w), mouthWideDelta(x, y, w), Z3, reserve());
  }

  // 2. hair: tune the spacing so the strand count lands near counts.hair
  let sp = 0.02;
  const emitted = hairArcs(sp, null);
  sp *= emitted / Math.max(1, counts.hair);
  hairArcs(sp, (x, y, k) => {
    const z = surfaceZ(x, y);
    if (z == null) return;
    push(x, y, z + 0.012, surfaceNormal(x, y), 1,
      1 + 0.2 * (k === 0 ? 1 : 0) + 0.12 * Math.sin(x * 70 + y * 40), Z3, Z3, Z3, reserve());
  });

  // 3. ears: two flattened rings per side, sitting just outside the head
  const nEar = Math.max(8, Math.round(counts.ears / 4));
  for (let side = -1; side <= 1; side += 2) {
    for (let ring = 0; ring < 2; ring++) {
      for (let t = 0; t < nEar; t++) {
        const u = -1 + 2 * (t + 0.5) / nEar;
        const yCenter = 0.06;
        const y = yCenter + 0.21 * u * (ring ? 0.78 : 1);
        const w = headHalfWidth(y);
        const bulge = (ring ? 0.075 : 0.12) * Math.pow(Math.max(0, 1 - u * u), 0.7);
        push(side * (w + 0.012 + bulge), y, -0.07, { x: side * 0.9, y: 0, z: 0.43 }, 1, 0.85, Z3, Z3, Z3, reserve());
      }
    }
  }

  // 4. eyes: lid curves (the blink group) plus iris ring and a highlight. The blink
  //    vector carries each lid point toward the closed line.
  for (let side = -1; side <= 1; side += 2) {
    const cx = side * FACE.eyeX, cy = FACE.eyeY, W = 0.14;
    const closeY = cy - 0.012;
    const lidUpper = (u) => cy + 0.011 * u + 0.046 * Math.pow(Math.max(0, 1 - u * u), 0.9);
    const lidLower = (u) => cy + 0.011 * u - 0.034 * Math.pow(Math.max(0, 1 - u * u), 0.9);
    const put = (x, y, shade, group) => {
      const z = surfaceZ(x, y);
      if (z == null) return;
      push(x, y, z + 0.016, surfaceNormal(x, y), group, shade, Z3, Z3,
        { x: 0, y: (closeY - y) * 0.97, z: 0 }, false);
    };
    for (let k = 0; k < 15; k++) put(cx + side * (-1 + 2 * k / 14) * W, lidUpper(-1 + 2 * k / 14), 1.25, 1);
    for (let k = 0; k < 13; k++) {
      const u = -0.9 + 1.8 * (k + 0.5) / 13;
      put(cx + side * u * W, lidUpper(u) + 0.012, 1.05, 1);
    }
    for (let k = 0; k < 11; k++) put(cx + side * (-0.85 + 1.7 * k / 10) * W, lidLower(-0.85 + 1.7 * k / 10), 0.95, 1);
    for (let k = 0; k < 9; k++) {
      const u = -0.65 + 1.3 * k / 8;
      put(cx + side * u * W, lidUpper(u) + 0.03 + 8e-3 * Math.sqrt(Math.max(0, 1 - u * u)), 0.55, 1);
    }
    for (let k = 1; k <= 3; k++) put(cx + side * (W + 0.014 * k), cy + 0.021 + 0.011 * k, 1, 1);
    for (let k = 0; k < 24; k++) {                        // iris ring, clipped to the lids
      const a = Math.PI * 2 * k / 24;
      const x = cx + Math.cos(a) * 0.05, y = cy + Math.sin(a) * 0.05;
      const u = (x - cx) * side / W;
      if (y > lidUpper(u) - 5e-3 || y < lidLower(u) + 4e-3) continue;
      put(x, y, 1.25, 1);
    }
    for (let k = 0; k < 10; k++) {                        // inner ring, dimmer
      const a = Math.PI * 2 * k / 10;
      const x = cx + Math.cos(a) * 0.03, y = cy + Math.sin(a) * 0.03;
      const u = (x - cx) * side / W;
      if (y > lidUpper(u) - 5e-3 || y < lidLower(u) + 4e-3) continue;
      put(x, y, 0.7, 1);
    }
    put(cx + 0.017, cy + 0.016, 2.6, 0);                  // catchlight
  }

  // 5. brows: two rows per side along a shallow arc
  const nBrow = 18;
  for (let side = -1; side <= 1; side += 2) {
    for (let row = 0; row < 2; row++) {
      for (let t = 0; t < nBrow; t++) {
        const tt = (t + (row ? 0.5 : 0)) / (nBrow - 1);
        if (tt > 1) continue;
        const x = side * (0.17 + 0.37 * tt);
        const y = 0.145 + 0.06 * Math.sin(Math.PI * Math.pow(tt, 0.85)) - 0.02 * tt + row * 0.017;
        const z = surfaceZ(x, y);
        if (z == null) continue;
        push(x, y, z + 0.01, surfaceNormal(x, y), 1, 1.25, Z3, Z3, Z3, reserve());
      }
    }
  }

  // 6. nose: bridge row, tip, nostril rings, wings
  for (let k = 0; k < 9; k++) {
    const t = -1 + 2 * k / 8;
    const x = t * 0.07, y = -0.322 + 0.02 * t * t;
    const z = surfaceZ(x, y);
    if (z == null) continue;
    push(x, y, z + 0.012, surfaceNormal(x, y), 0, 1.05, Z3, Z3, Z3, reserve());
  }
  const tipZ = surfaceZ(0, -0.292);
  if (tipZ != null) push(0, -0.292, tipZ + 0.016, surfaceNormal(0, -0.292), 0, 2, Z3, Z3, Z3, false);
  for (let side = -1; side <= 1; side += 2) {
    for (let k = 0; k < 9; k++) {                         // nostril rings
      const a = k / 9 * Math.PI * 2;
      const x = side * 0.052 + Math.cos(a) * 0.028, y = -0.372 + Math.sin(a) * 0.013;
      const z = surfaceZ(x, y);
      if (z == null) continue;
      push(x, y, z + 4e-3, { x: side * 0.15, y: -0.7, z: 0.7 }, 0, 0.35, Z3, Z3, Z3, reserve());
    }
    for (let k = 0; k < 8; k++) {                         // wings down to the tip
      const t = k / 7;
      const x = side * (0.078 + 0.03 * Math.sin(Math.PI * t) - 0.012 * t * t);
      const y = -0.305 - 0.088 * t;
      const z = surfaceZ(x, y);
      if (z == null) continue;
      push(x, y, z + 0.012, { x: side * 0.55, y: -0.3, z: 0.78 }, 0, 0.75, Z3, Z3, Z3, reserve());
    }
  }

  // 7. lips: six rows between the profiles. The cupid's-bow peaks are brighter and
  //    in the hair group so they read as highlights on the mouth.
  const lip = (x, y, shade, group) => {
    const z = surfaceZ(x, y);
    if (z == null) return;
    const w = mouthWeight(x, y);
    push(x, y, z + 0.014, surfaceNormal(x, y), group, shade,
      mouthOpenDelta(x, y, w), mouthWideDelta(x, y, w), Z3, reserve());
  };
  for (let k = 0; k < 23; k++) {                          // top of the upper lip
    const x = (-1 + 2 * k / 22) * 0.22;
    const peak = Math.abs(Math.abs(x) - 0.066) < 0.011;
    lip(x, mouthLineY(x) + upperLipY(x), peak ? 1.5 : 1.1, peak ? 1 : 3);
  }
  for (let k = 0; k < 17; k++) {                          // inside the upper lip
    const x = (-0.85 + 1.7 * k / 16) * 0.22;
    lip(x, mouthLineY(x) + 0.55 * upperLipY(x), 0.75, 3);
  }
  for (let k = 0; k < 20; k++) {                          // the mouth line itself
    const x = (-0.95 + 1.9 * k / 19) * 0.22;
    lip(x, mouthLineY(x) + 5e-3, 0.7, 3);
  }
  for (let k = 0; k < 19; k++) {                          // just under the line
    const x = (-0.9 + 1.8 * (k + 0.5) / 19) * 0.22;
    lip(x, mouthLineY(x) - 5e-3, 0.7, 3);
  }
  for (let k = 0; k < 15; k++) {                          // bottom of the lower lip
    const x = (-0.8 + 1.6 * k / 14) * 0.22;
    const hl = Math.abs(x) < 0.03;
    lip(x, mouthLineY(x) - 0.55 * lowerLipY(x), hl ? 1.5 : 0.85, hl ? 1 : 3);
  }
  for (let k = 0; k < 23; k++) {
    const x = (-1 + 2 * k / 22) * 0.22;
    lip(x, mouthLineY(x) - lowerLipY(x), 1.1, 3);
  }

  return pts;
}

function makeGeometry(pts) {
  const n = pts.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const grp = new Float32Array(n);
  const shade = new Float32Array(n);
  const mo = new Float32Array(n * 3);
  const mw = new Float32Array(n * 3);
  const blink = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const reserve = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const moD = q.mo || Z3;
    const mwD = q.mw2 || Z3;
    const blD = q.blink || Z3;
    pos.set(q.p, i * 3);
    nrm.set([q.n.x, q.n.y, q.n.z], i * 3);
    grp[i] = q.group;
    shade[i] = q.shade;
    mo.set([moD.x, moD.y, moD.z], i * 3);
    mw.set([mwD.x, mwD.y, mwD.z], i * 3);
    blink.set([blD.x, blD.y, blD.z], i * 3);
    seed[i] = Math.random();
    reserve[i] = q.reserve ? 1 : 0;
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('aGroup', new BufferAttribute(grp, 1));
  g.setAttribute('aShade', new BufferAttribute(shade, 1));
  g.setAttribute('aMouthOpen', new BufferAttribute(mo, 3));
  g.setAttribute('aMouthWide', new BufferAttribute(mw, 3));
  g.setAttribute('aBlink', new BufferAttribute(blink, 3));
  g.setAttribute('aSeed', new BufferAttribute(seed, 1));
  g.setAttribute('aReserve', new BufferAttribute(reserve, 1));
  return g;
}

/* ============================================================================
 * 3. shaders
 * ==========================================================================*/

const VERT = /* glsl */ `
uniform float uTime;
uniform float uForm;
uniform float uMouthOpen;
uniform float uLipWidth;
uniform float uBlink;
uniform float uBreath;
uniform float uDriftSpeed;
uniform float uPointScale;
uniform mat4 uModel;

attribute float aGroup;
attribute float aShade;
attribute float aSeed;
attribute float aReserve;
attribute vec3 aMouthOpen;
attribute vec3 aMouthWide;
attribute vec3 aBlink;

varying float vGroup;
varying float vShade;
varying float vSeed;
varying float vEdge;
varying float vDepth;

float easeInOutCubic(float x) {
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0;
}

float rand01(float n) { return fract(sin(n) * 43758.5453123); }

vec3 drift(float seed, float t) {
  // independent per-drone values (breaks the shared-Lissajous "lines" look)
  float h0 = rand01(seed * 12.9898);
  float h1 = rand01(seed * 78.233);
  float h2 = rand01(seed * 37.719);
  float h3 = rand01(seed * 91.287);
  float h4 = rand01(seed * 61.111);
  float h5 = rand01(seed * 23.669);

  // per-drone frequencies (rad/s): slow drift, roughly 0.02..0.08 units/s
  float fx = 0.025 + 0.06 * h0;
  float fy = 0.025 + 0.06 * h1;
  float fz = 0.02 + 0.05 * h2;
  float gx = 0.01 + 0.025 * h3;
  float gy = 0.01 + 0.025 * h4;
  float gz = 0.008 + 0.02 * h5;

  vec3 p;
  p.x = 0.95 * sin(fx * t + h0 * 6.2831853) + 0.50 * sin(gx * t + h3 * 6.2831853);
  p.y = 0.95 * sin(fy * t + h1 * 6.2831853) + 0.50 * sin(gy * t + h4 * 6.2831853);
  p.z = 1.40 * sin(fz * t + h2 * 6.2831853) + 0.50 * sin(gz * t + h5 * 6.2831853);
  return p;
}

void main() {
  float t = uTime * uDriftSpeed;
  vec3 freePos = drift(aSeed, t);

  // per-drone stagger so the face assembles out of the drift, not all at once
  float tt = clamp((uForm - aSeed * 0.25) / 0.75, 0.0, 1.0);
  vec3 pos = mix(freePos, position, easeInOutCubic(tt));

  // mouth + blink, applied in head-local space before rotation
  pos += aMouthOpen * uMouthOpen + aMouthWide * uLipWidth + aBlink * uBlink;

  // breathing scale
  pos *= uBreath;

  vec4 world = uModel * vec4(pos, 1.0);
  vec4 viewPos = viewMatrix * world;
  gl_Position = projectionMatrix * viewPos;

  // edge emphasis: silhouette where the surface normal turns away from view
  vec3 n = normalize((uModel * vec4(normal, 0.0)).xyz);
  vEdge = 1.0 - abs(dot(n, vec3(0.0, 0.0, 1.0)));

  // depth cue
  vDepth = clamp(-viewPos.z / 9.0, 0.0, 1.0);

  vGroup = aGroup;
  vShade = aShade;
  vSeed = aSeed;

  float size = uPointScale / max(0.1, -viewPos.z);
  // reserve drones only appear once the face starts forming (start screen ~50%)
  float vis = (aReserve > 0.5) ? smoothstep(0.05, 0.6, uForm) : 1.0;
  gl_PointSize = min(size * vis, 48.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorFace;
uniform vec3 uColorHair;
uniform vec3 uColorNeck;
uniform vec3 uColorRim;
uniform float uTime;

varying float vGroup;
varying float vShade;
varying float vSeed;
varying float vEdge;
varying float vDepth;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard; // circular sprite
  float d = sqrt(r2) * 2.0; // 0 centre .. 1 edge

  float glow = exp(-d * d * 3.0);
  float core = exp(-d * d * 12.0);

  vec3 base;
  if (vGroup < 0.5) base = uColorFace;        // 0 face
  else if (vGroup < 1.5) base = uColorHair;   // 1 hair/ears
  else if (vGroup < 2.5) base = uColorNeck;   // 2 neck/shoulders
  else if (vGroup < 3.5) base = uColorFace;   // 3 mouth
  else base = uColorFace;                     // 4 eye

  // per-drone hue/lightness variation (about +/-10%)
  float vary = (fract(vSeed * 13.37) * 2.0 - 1.0) * 0.10;
  base *= 1.0 + vary;

  // relief shading (protrusions bright, recesses dark); the 0.85 keeps the body of
  // the head under the rim highlight below
  base *= vShade * 0.85;

  // edge brightening: the accent group rims in its own brighter tone (the hair reads
  // as a halo), everything else rims toward cyan-white
  vec3 rimCol = (vGroup > 0.5 && vGroup < 1.5) ? uColorHair * 1.8 : uColorRim * 1.15;
  base = mix(base, rimCol, smoothstep(0.35, 0.9, vEdge) * 0.9);

  // depth cue: dim far points
  base *= 1.0 - 0.45 * vDepth;

  // twinkle: 2-4% brightness sine
  float tw = 1.0 + 0.03 * sin(uTime * 2.0 + vSeed * 40.0);

  float intensity = glow * 0.55 + core * 1.5;
  vec3 col = base * intensity * tw;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ============================================================================
 * 4. state machine
 * ==========================================================================*/

const State = {
  IDLE: 'idle',
  FORMING: 'forming',
  ACTIVE: 'active',
  SPEAKING: 'speaking',
  DISPERSING: 'dispersing',
};

let state = State.IDLE;

function setState(next) {
  if (state === next) return;
  const prev = state;
  state = next;
  emit('stateChange', { from: prev, to: next });
  updateUI();
}

/* ============================================================================
 * 5. renderer / scene setup
 * ==========================================================================*/

let renderer, scene, camera, points, material, geometry;
let canvas;
let model = new Matrix4();
let uniforms;
let started = false;          // Start has been pressed at least once
let dispersed = false;        // whether the last dispersal made it "Reform"
let webglOk = true;

function initRenderer() {
  canvas = document.getElementById('scene');
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    webglOk = false;
    showFallback();
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.dprCap));
  renderer.setClearColor(new Color(CONFIG.background), 1);

  scene = new Scene();
  camera = new PerspectiveCamera(CONFIG.fov, 1, 0.1, 100);
  camera.position.set(0, 0, 4);

  uniforms = {
    uTime: { value: 0 },
    uForm: { value: 0 },
    uMouthOpen: { value: 0 },
    uLipWidth: { value: 0 },
    uBlink: { value: 0 },
    uBreath: { value: 1 },
    uDriftSpeed: { value: reducedMotion ? 0.4 : 1.0 },
    uPointScale: { value: 1 },
    uModel: { value: model },
    uColorFace: { value: new Color(CONFIG.colorFace) },
    uColorHair: { value: new Color(CONFIG.colorHair) },
    uColorNeck: { value: new Color(CONFIG.colorNeck) },
    uColorRim: { value: new Color(CONFIG.colorRim) },
  };

  material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });

  geometry = makeGeometry(buildPoints(CONFIG.counts));
  points = new Points(geometry, material);
  points.frustumCulled = false;
  points.position.y = 0.10; // leave room for the neck at the bottom
  scene.add(points);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); pause(); });
  canvas.addEventListener('webglcontextrestored', () => { resume(); });

  return true;
}

function rebuildGeometry(counts) {
  const next = makeGeometry(buildPoints(counts));
  if (points) {
    geometry.dispose();
    points.geometry = next;
    geometry = next;
  }
}

function showFallback() {
  const el = document.getElementById('fallback');
  if (el) el.hidden = false;
  const wrap = document.getElementById('startWrap');
  if (wrap) wrap.classList.add('hidden');
}

/* ============================================================================
 * 6. input handling (drag orientation)
 * ==========================================================================*/

let yaw = 0, pitch = 0, yawTarget = 0, pitchTarget = 0;
let dragging = false, lastX = 0, lastY = 0, lastInputAt = 0;

function initInput() {
  canvas.addEventListener('pointerdown', (e) => {
    if (state !== State.ACTIVE && state !== State.SPEAKING) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    yawTarget += dx * CONFIG.dragSensitivity;
    pitchTarget += dy * CONFIG.dragSensitivity;
    lastInputAt = now;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
}

function orientStep(dt) {
  idleStep(dt);

  // soft limits (rubber band): slow as we approach the limit
  const yl = CONFIG.yawLimit, pl = CONFIG.pitchLimit;
  yawTarget = rubber(yawTarget, yl);
  pitchTarget = rubber(pitchTarget, pl);

  // exponential damping toward targets
  const k = 1 - Math.exp(-dt / CONFIG.orientSmooth);
  yaw += (yawTarget - yaw) * k;
  pitch += (pitchTarget - pitch) * k;

  // auto-recentre after no input (only while formed)
  if (CONFIG.recentreEnabled && !dragging && (state === State.ACTIVE || state === State.SPEAKING)) {
    if (now - lastInputAt > CONFIG.recentreDelay) {
      yawTarget += (0 - yawTarget) * Math.min(1, dt * 2);
      pitchTarget += (0 - pitchTarget) * Math.min(1, dt * 2);
    }
  }

  // build model = RY(yaw + idle glance) * RX(pitch) * RZ(idle tilt)
  // roll goes innermost so it is a tilt of the head's own axis, whichever way it faces
  const rad = Math.PI / 180;
  const ry = new Matrix4().makeRotationY((yaw + idle.yaw) * rad);
  const rx = new Matrix4().makeRotationX(pitch * rad);
  const rz = new Matrix4().makeRotationZ(idle.roll * rad);
  model.multiplyMatrices(ry, rx).multiply(rz);
  uniforms.uModel.value = model;
}

function rubber(v, limit) {
  // soft clamp: full travel inside, damped beyond
  if (Math.abs(v) <= limit) return v;
  return Math.sign(v) * (limit + (Math.abs(v) - limit) * 0.2);
}

/* ----------------------------------------------------------------------------
 * Idle motion. A formed face that holds perfectly still reads as a paused video,
 * so while it is formed and silent it runs a slow cycle of small gestures — tilt,
 * glance, tilt the other way, glance the other way — with ten seconds of doing
 * nothing between each. The stillness is the point: gestures every few seconds
 * would be a screensaver, not a head waiting for its next instruction.
 * -------------------------------------------------------------------------*/

const idle = {
  step: 0, phase: 'wait', t: 0, from: 0, pose: 0, axis: 'roll',
  yaw: 0, roll: 0, enabled: true,
};

function idleCycle() {
  const c = CONFIG.idleMotion;
  return [
    { axis: 'roll', value: -c.tiltDeg, hold: c.holdTilt },
    { axis: 'yaw', value: -c.lookDeg, hold: c.holdLook },
    { axis: 'roll', value: c.tiltDeg, hold: c.holdTilt },
    { axis: 'yaw', value: c.lookDeg, hold: c.holdLook },
  ];
}

// same easing the formation transition uses, in JS
const easeSoft = (p) => p * p * (3 - 2 * p);

function idleStep(dt) {
  const c = CONFIG.idleMotion;
  const cycle = idleCycle();
  const free = idle.enabled && !reducedMotion && !dragging &&
    state === State.ACTIVE && !audioActive && !synthVoice;

  if (!free) {
    // a gesture in progress finishes the way it started, along the same curve; then the
    // cycle sits at its start so the ten-second wait restarts from the beginning
    if (idle.pose !== 0) {
      idle.pose += (0 - idle.pose) * Math.min(1, dt / (c.moveOut * 0.5));
      if (Math.abs(idle.pose) < 0.002) idle.pose = 0;
    }
    idle.phase = 'wait'; idle.t = 0; idle.step = 0; idle.from = idle.pose;
    return;
  }

  idle.t += dt;
  const g = cycle[idle.step];
  if (idle.phase === 'wait') {
    idle.pose = 0;
    if (idle.t >= c.gap) { idle.axis = g.axis; idle.from = 0; idle.phase = 'in'; idle.t = 0; }
  } else if (idle.phase === 'in') {
    const p = Math.min(1, idle.t / c.moveIn);
    idle.pose = idle.from + (g.value - idle.from) * easeSoft(p);
    if (p >= 1) { idle.pose = g.value; idle.phase = 'hold'; idle.t = 0; }
  } else if (idle.phase === 'hold') {
    idle.pose = g.value;
    if (idle.t >= g.hold) { idle.from = g.value; idle.phase = 'out'; idle.t = 0; }
  } else {
    const p = Math.min(1, idle.t / c.moveOut);
    idle.pose = idle.from * (1 - easeSoft(p));
    if (p >= 1) {
      idle.pose = 0;
      idle.step = (idle.step + 1) % cycle.length;
      idle.phase = 'wait'; idle.t = 0;
    }
  }
  idle.yaw = idle.axis === 'yaw' ? idle.pose : 0;
  idle.roll = idle.axis === 'roll' ? idle.pose : 0;
}

/* ============================================================================
 * 7. audio & lip sync
 * ==========================================================================*/

let audioCtx = null;
let analyser = null;
let td = null, fd = null;       // time/freq domain buffers
let peak = 0;                   // adaptive gain running peak
let mouthOpen = 0, lipWidth = 0; // smoothed outputs
let audioMeter = { rms: 0, peak: 0, target: 0 };   // last analysis pass, for diagnostics
let audioActive = false;        // an audio source is currently playing
let synthVoice = false;        // synthetic lip envelope is driving the mouth (browser TTS or fallback)
let manual = { open: 0, width: 0 };
let soundOn = true;            // master sound flag: speaker button, drives the music bed

function ensureAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
  } catch (_) {
    audioCtx = null;
    return;
  }
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = CONFIG.analyserFFT;
  analyser.smoothingTimeConstant = CONFIG.smoothing;
  analyser.connect(audioCtx.destination);
  td = new Float32Array(analyser.fftSize);
  fd = new Float32Array(analyser.frequencyBinCount);
}

function loadSoundPref() {
  try {
    const v = localStorage.getItem('droneface.ambient');   // key kept for existing installs
    if (v === 'off') soundOn = false;
  } catch (_) {}
}

// Master sound flag. The background music bed in src/index.html mirrors it, so the
// speaker button mutes the music and never the voice. `setAmbient`/`ambient` stay as
// deprecated aliases (spec §11).
function setSound(on) {
  soundOn = !!on;
  try { localStorage.setItem('droneface.ambient', soundOn ? 'on' : 'off'); } catch (_) {}
  updateUI();
}
const setAmbient = setSound;

// one-pole smoother with asymmetric attack/release
function smooth(cur, target, attackTau, releaseTau, dt) {
  const tau = target > cur ? attackTau : releaseTau;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

// pure DSP (testable): loudness -> mouthOpen, spectral brightness -> lipWidth
function computeMouth(timeData, freqData, sampleRate, fftSize, dt, prevPeak) {
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
  const rms = Math.sqrt(sum / timeData.length);

  // adaptive gain: running peak with slow decay, so a quiet voice still gets full gape
  const pk = Math.max(rms, prevPeak * Math.exp(-dt / CONFIG.peakDecay));
  let open = 0;
  if (rms > CONFIG.noiseFloor && pk > 1e-4) {
    open = clamp01((rms - CONFIG.noiseFloor) / (pk * 0.7 - CONFIG.noiseFloor));
  }

  // lip width from spectral ratio (2-8 kHz vs 180 Hz-2 kHz); freqData is dB
  const bin = sampleRate / fftSize;
  const lo0 = Math.floor(180 / bin), lo1 = Math.floor(2000 / bin);
  const hi0 = lo1, hi1 = Math.floor(8000 / bin);
  let loE = 0, hiE = 0;
  for (let i = lo0; i < lo1; i++) loE += Math.pow(10, freqData[i] / 20);
  for (let i = hi0; i < hi1; i++) hiE += Math.pow(10, freqData[i] / 20);
  const ratio = hiE / (loE + 1e-6);
  const width = Math.min(1, ratio * 4.0);

  return { open, width, peak: pk, rms };
}

let simStart = 0;               // when the synthetic envelope started (now-seconds)
function updateLipSync(dt) {
  if (synthVoice && !audioActive) {
    // no analyser signal to follow (browser speechSynthesis, or the simulated
    // fallback): drive the mouth from a speech-like envelope
    const t = now - simStart;
    const syll = 0.5 + 0.5 * Math.sin(t * 5.2 + 2.0 * Math.sin(t * 1.9));
    const word = (t * 3.1) % 1 < 0.86 ? 1 : 0.12;   // a brief closure once per word
    const breath = 0.75 + 0.25 * Math.sin(t * 3.3);
    const open = clamp01(syll * breath * word);
    const width = clamp01(0.25 + 0.35 * syll * (0.5 + 0.5 * Math.sin(t * 6.1)));
    mouthOpen = smooth(mouthOpen, open, CONFIG.mouthAttack, CONFIG.mouthRelease, dt);
    lipWidth = smooth(lipWidth, width, CONFIG.widthAttack, CONFIG.widthRelease, dt);
    return;
  }
  if (!analyser) return;

  if (audioActive) {
    analyser.getFloatTimeDomainData(td);
    analyser.getFloatFrequencyData(fd);
    const r = computeMouth(td, fd, audioCtx.sampleRate, analyser.fftSize, dt, peak);
    peak = r.peak;
    audioMeter = { rms: r.rms, peak: r.peak, target: r.open };
    mouthOpen = smooth(mouthOpen, r.open, CONFIG.mouthAttack, CONFIG.mouthRelease, dt);
    lipWidth = smooth(lipWidth, r.width, CONFIG.widthAttack, CONFIG.widthRelease, dt);
  } else {
    // no audio: fall back to manual values (usually 0)
    mouthOpen = smooth(mouthOpen, manual.open, CONFIG.mouthAttack, CONFIG.mouthRelease, dt);
    lipWidth = smooth(lipWidth, manual.width, CONFIG.widthAttack, CONFIG.widthRelease, dt);
  }
}

let currentSource = null;      // the playing TTS BufferSource, so Disperse can stop it
let streamNodes = [];          // every source scheduled by a streamed utterance
let ttsAbort = null;           // the in-flight TTS fetch, so stop() can cancel it

function decodeAndPlay(arrayBuffer) {
  return new Promise((resolve, reject) => {
    audioCtx.decodeAudioData(arrayBuffer, (buf) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      src.onended = () => { if (currentSource === src) currentSource = null; endSpeech(); };
      src.start();
      currentSource = src;
      beginSpeech();
      resolve();
    }, reject);
  });
}

function beginSpeech() {
  audioActive = true;
  if (state === State.ACTIVE || state === State.IDLE) setState(State.SPEAKING);
  emit('speechStart', {});
}

function endSpeech() {
  audioActive = false;
  if (state === State.SPEAKING) setState(State.ACTIVE);
  emit('speechEnd', {});
}

// s16le (or f32, or a raw ArrayBuffer) → the Float32Array an AudioBuffer wants
function toFloat32(chunk) {
  if (chunk instanceof Float32Array) return chunk;
  if (chunk instanceof Int16Array) {
    const out = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] / 32768;
    return out;
  }
  if (chunk instanceof ArrayBuffer) return toFloat32(new Int16Array(chunk));
  return new Float32Array(0);
}

function base64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);   // little-endian, which is every target we run on
}

// Server-sent events, fed in arbitrary pieces. An event boundary can land in the middle
// of a base64 payload, and a parser that silently drops one sounds like a broken
// speaker rather than a bug — so this is a pure function and it is tested on its own.
function createSSEParser(onEvent) {
  let buf = '';
  const emitEvent = (raw) => {
    let name = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line[0] === ':') continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) onEvent(name, data.join('\n'));
  };
  const feed = (text) => {
    buf += text;
    // only cut on a complete blank line: a CRLF split across two chunks must wait for
    // the second byte rather than be read as two line endings
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      emitEvent(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  };
  feed.flush = () => {
    const rest = buf.replace(/[\r\n]+$/, '');
    buf = '';
    if (rest) emitEvent(rest);
  };
  return feed;
}

// One utterance arriving in pieces. Each chunk becomes an AudioBuffer scheduled
// back-to-back on the analyser, so a stream and a complete file are the same thing
// downstream — same lip sync, same ducking, same stop().
function createPlaybackStream(sampleRate) {
  ensureAudio();
  const rate = sampleRate || CONFIG.tts.pcmRate;
  let cursor = 0, started = false, finished = false, chunks = 0, seconds = 0, firstMs = 0;
  const t0 = performance.now();      // from the sink's birth: the click is ~1 frame earlier
  return {
    info: () => ({ chunks, seconds: +seconds.toFixed(2), firstMs }),
    push(chunk) {
      if (!audioCtx || finished) return;
      const f32 = toFloat32(chunk);
      if (!f32.length) return;
      if (!started) { started = true; firstMs = Math.round(performance.now() - t0); beginSpeech(); }
      const buf = audioCtx.createBuffer(1, f32.length, rate);
      buf.copyToChannel(f32, 0);
      const node = audioCtx.createBufferSource();
      node.buffer = buf;
      node.connect(analyser);
      // never schedule in the past: a chunk that lands late starts now. A short gap is
      // better than a glitch, and the lateness cannot accumulate into drift.
      const at = Math.max(cursor, audioCtx.currentTime + 0.005);
      node.start(at);
      cursor = at + buf.duration;
      streamNodes.push(node);
      node.onended = () => {
        if (finished && node === streamNodes[streamNodes.length - 1]) endSpeech();
      };
      chunks++;
      seconds += buf.duration;
    },
    end() {
      finished = true;
      if (!started) endSpeech();      // nothing ever arrived; do not leave it SPEAKING
    },
    stop() {
      finished = true;
      for (const n of streamNodes) {
        try { n.onended = null; n.stop(); } catch (_) {}
      }
    },
  };
}

// Where this endpoint keeps its voice list: same origin, /audio/speech → /audio/voices
function voicesUrl(endpoint) {
  try {
    const u = new URL(endpoint, location.href);
    u.pathname = /\/audio\/speech$/.test(u.pathname)
      ? u.pathname.replace(/\/audio\/speech$/, '/audio/voices')
      : '/v1/audio/voices';
    u.search = '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

/* ============================================================================
 * 8. TTS client
 * ==========================================================================*/

function getEndpoint() { try { return localStorage.getItem('droneface.endpoint') || ''; } catch (_) { return ''; } }
function setEndpointStore(url) { try { localStorage.setItem('droneface.endpoint', url); } catch (_) {} }
function getVoice() { try { return localStorage.getItem('droneface.voice') || CONFIG.tts.voice; } catch (_) { return CONFIG.tts.voice; } }
function setVoiceStore(name) { try { localStorage.setItem('droneface.voice', name); } catch (_) {} }
function getModel() { try { return localStorage.getItem('droneface.model') || CONFIG.tts.model; } catch (_) { return CONFIG.tts.model; } }
function setModelStore(name) { try { localStorage.setItem('droneface.model', name); } catch (_) {} }

// What the last speak() actually did, for the status line and for the harness
// (a silent fallback is the worst failure mode a demo can have).
let ttsStatus = { mode: 'none', detail: 'not spoken yet', endpoint: '', at: 0 };

// Two wire formats are in the wild. An OpenAI-compatible server (vLLM, and the
// qwen3-tts deployments that speak that API) wants /v1/audio/speech with
// {model, input, voice, response_format}; the shape spec §8 originally guessed
// wants {text, voice}. Pick by URL so both work without a rebuild.
function isOpenAIEndpoint(url) {
  return /\/audio\/speech\b|\/v1\/?$/.test(url);
}

// the only place that knows the TTS wire format (spec §11)
async function requestTTS(text) {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('no TTS endpoint configured');
  const openai = isOpenAIEndpoint(endpoint);
  const body = openai
    ? { model: getModel(), input: text, voice: getVoice(), response_format: 'wav' }
    : { text, voice: getVoice(), response_format: 'wav' };
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // fetch rejects on network failure and on a CORS block alike (deliberately
    // uninformative); say both, because from a file:// page CORS is the usual answer
    throw new Error(`could not reach ${endpoint} (network or CORS)`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 160).replace(/\s+/g, ' '); } catch (_) {}
    throw new Error(`TTS ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const j = await res.json();
    const b64 = (j.output && (j.output.audio || j.output.audio_b64)) || j.audio_base64 || j.audio || j.data || j.b64;
    if (!b64) throw new Error('no audio field in TTS response');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  return res.arrayBuffer();
}

// The same utterance as a stream: SSE carrying raw PCM chunks, which is how you get the
// mouth moving in ~120 ms instead of ~2 s (spec §11).
async function requestTTSStream(text, sink) {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('no TTS endpoint configured');
  if (!isOpenAIEndpoint(endpoint)) throw new Error('endpoint does not take the streaming shape');
  const ctrl = new AbortController();
  ttsAbort = ctrl;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: getModel(), input: text, voice: getVoice(), response_format: 'pcm', stream: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) return Object.assign(sink.info(), { aborted: true });
    throw new Error(`could not reach ${endpoint} (network or CORS)`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 160).replace(/\s+/g, ' '); } catch (_) {}
    throw new Error(`TTS ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!/event-stream/.test(ct)) throw new Error(`endpoint did not stream (${ct || 'no content-type'})`);
  if (!res.body || !res.body.getReader) throw new Error('stream response has no body to read');

  const dec = new TextDecoder();
  const reader = res.body.getReader();
  const feed = createSSEParser((name, data) => {
    let j;
    try { j = JSON.parse(data); } catch (_) { return; }
    const isDelta = j.type ? j.type === 'speech.audio.delta' : name === 'speech.audio.delta';
    if (isDelta && j.audio) sink.push(base64ToInt16(j.audio));
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
    }
    feed.flush();
  } catch (e) {
    if (ctrl.signal.aborted) { sink.stop(); return Object.assign(sink.info(), { aborted: true }); }
    throw e;
  }
  sink.end();
  if (ttsAbort === ctrl) ttsAbort = null;
  return sink.info();
}

async function speak(text) {
  ensureAudio();
  stopVoice();                      // interrupt whatever was speaking before this
  const endpoint = getEndpoint();
  fallbackReason = '';
  if (audioCtx && endpoint) {
    // 1-2 s of synthesis is dead air on a stage: say the wait is happening
    ttsStatus = { mode: 'requesting', detail: 'synthesising…', endpoint, at: now };
    setVoiceBtnLabel('Synthesising…');
    updateTTSStatus();
    // streaming first: the first chunk lands in about 100 ms, a complete file in ~2 s
    if (CONFIG.tts.stream && isOpenAIEndpoint(endpoint)) {
      const sink = createPlaybackStream();
      try {
        const info = await requestTTSStream(text, sink);
        setVoiceBtnLabel('');
        if (info.aborted) return;                 // the user stopped it; nothing to fall back to
        ttsStatus = {
          mode: 'tts-stream',
          detail: `${info.seconds.toFixed(1)} s in ${info.chunks} chunks, first sound at ${info.firstMs} ms`,
          endpoint, at: now,
        };
        updateTTSStatus();
        return;
      } catch (e) {
        console.warn('[DroneFace] TTS stream failed, asking for a complete file:', e);
        fallbackReason = String((e && e.message) || e);
      }
    }
    try {
      const buf = await requestTTS(text);
      const kb = Math.max(1, Math.round(buf.byteLength / 1024));   // byteLength reads 0 after decodeAudioData detaches the buffer
      await decodeAndPlay(buf);
      ttsStatus = { mode: 'tts', detail: `${kb} kB played`, endpoint, at: now };
      setVoiceBtnLabel('');
      updateTTSStatus();
      return;
    } catch (e) {
      console.warn('[DroneFace] TTS failed, falling back:', e);
      fallbackReason = String((e && e.message) || e);
      ttsStatus = { mode: 'fallback', detail: fallbackReason, endpoint, at: now };
    }
  } else if (!endpoint) {
    fallbackReason = 'no TTS endpoint configured';
    ttsStatus = { mode: 'fallback', detail: fallbackReason, endpoint, at: now };
  } else {
    fallbackReason = 'no Web Audio in this browser';
    ttsStatus = { mode: 'fallback', detail: fallbackReason, endpoint, at: now };
  }
  // offline demo voice: real speechSynthesis if it will actually talk, otherwise a
  // simulated envelope so the face never stands silent with its mouth shut
  const spoke = await demoSpeak(text);
  if (!spoke) simulateSpeak(text);
  setVoiceBtnLabel('');
  updateTTSStatus();
}

// The button doubles as the "waiting on the server" indicator: the panel that carries
// the status text is collapsed most of the time.
function setVoiceBtnLabel(label) {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  if (!label) { btn.textContent = btn.dataset.label || 'Generate voice'; return; }
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = label;
}

// resolves true only if the browser TTS really started; if it is present but has no
// engine behind it (the usual answer on a Linux demo box) it never fires onstart, and
// waiting forever is what left the face frozen
function demoSpeak(text) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(started);
    };
    const guard = setTimeout(() => {
      if (!settled) {
        // onstart never came; make sure a late start cannot double up with the simulation
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
        finish(false);
      }
    }, 400);
    try {
      if (!window.speechSynthesis) return finish(false);
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.onstart = () => {
        if (settled) { try { window.speechSynthesis.cancel(); } catch (_) {} return; }
        synthVoice = true;
        simStart = now;
        if (state === State.ACTIVE || state === State.IDLE) setState(State.SPEAKING);
        emit('speechStart', {});
        finish(true);
      };
      const done = () => {
        synthVoice = false;
        if (state === State.SPEAKING) setState(State.ACTIVE);
        emit('speechEnd', {});
      };
      u.onend = done;
      u.onerror = () => { done(); finish(false); };
      window.speechSynthesis.speak(u);
      ttsStatus = { mode: 'browser-tts', detail: 'browser speechSynthesis', endpoint: getEndpoint(), at: now };
    } catch (_) {
      finish(false);
    }
  });
}

// Last resort: nothing made a sound, so move the mouth on a synthetic envelope for a
// duration guessed from the text. The face reads as talking to the room; the status
// line and the console say honestly that the voice is simulated.
let simTimer = 0;
let fallbackReason = '';    // why the TTS path gave up, kept so the status line can say so
// silence every voice path at once: TTS audio, browser speechSynthesis, simulation
function stopVoice() {
  clearTimeout(simTimer);
  synthVoice = false;
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  if (ttsAbort) { try { ttsAbort.abort(); } catch (_) {} ttsAbort = null; }
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  for (const n of streamNodes) {
    try { n.onended = null; n.stop(); } catch (_) {}
  }
  streamNodes = [];
  if (audioActive) endSpeech();
}
function simulateSpeak(text) {
  clearTimeout(simTimer);
  const dur = Math.min(12, Math.max(1.2, 0.55 + text.length * 0.058));
  synthVoice = true;
  simStart = now;
  if (state === State.ACTIVE || state === State.IDLE || state === State.FORMING) setState(State.SPEAKING);
  emit('speechStart', {});
  ttsStatus = {
    mode: 'simulated',
    detail: (fallbackReason ? fallbackReason + ' — ' : '') + 'no voice available, lip movement only',
    endpoint: getEndpoint(), at: now,
  };
  simTimer = setTimeout(() => {
    synthVoice = false;
    if (state === State.SPEAKING) setState(State.ACTIVE);
    emit('speechEnd', {});
  }, dur * 1000);
}

/* ============================================================================
 * 9. public DroneFace API
 * ==========================================================================*/

function makeApi() {
  window.DroneFace = {
    start() {
      if (state !== State.IDLE) return;
      ensureAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      beginForming();
    },
    disperse() {
      if (state !== State.ACTIVE) return;
      beginDispersing();
    },
    get state() { return state; },
    build: BUILD,
    attachAudio(source) {
      ensureAudio();
      if (!audioCtx || !analyser) return;
      let node = source._dronefaceNode;
      if (!node) {
        if (source.captureStream) node = audioCtx.createMediaStreamSource(source.captureStream());
        else node = audioCtx.createMediaElementSource(source);
        node.connect(analyser);
        source._dronefaceNode = node;
      }
      source.addEventListener('play', () => beginSpeech());
      source.addEventListener('pause', () => endSpeech());
      source.addEventListener('ended', () => endSpeech());
    },
    speakFromUrl(url) {
      ensureAudio();
      return fetch(url)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => decodeAndPlay(buf));
    },
    speak,
    stop() { stopVoice(); },
    setEndpoint(url) { setEndpointStore(url); },
    setVoice(name) { setVoiceStore(name); },
    setModel(name) { setModelStore(name); },
    voiceStatus() {
      return {
        mode: ttsStatus.mode, detail: ttsStatus.detail, endpoint: getEndpoint(),
        voice: getVoice(), model: getModel(),
        open: +mouthOpen.toFixed(3), width: +lipWidth.toFixed(3),
        audioActive, synthVoice,
      };
    },
    attachStream(sampleRate) {
      // real sink for a backend that delivers audio in pieces (WebSocket, gRPC, SSE):
      // push Int16Array / Float32Array / ArrayBuffer chunks, then end()
      return createPlaybackStream(sampleRate);
    },
    setMouth(open, width) {
      manual.open = clamp01(open);
      manual.width = width == null ? 0 : clamp01(width);
      audioActive = false;
    },
    setSound,
    get sound() { return soundOn; },
    setAmbient,                        // deprecated alias for setSound
    get ambient() { return soundOn; }, // deprecated alias for sound
    setOrientationLimits({ yaw, pitch }) {
      if (typeof yaw === 'number') CONFIG.yawLimit = yaw;
      if (typeof pitch === 'number') CONFIG.pitchLimit = pitch;
    },
    // off for a screenshot, a recording, or a test that needs a still head (spec §9.2)
    setIdleMotion(on) { idle.enabled = !!on; },
    get idleMotion() { return idle.enabled && !reducedMotion; },
    on(event, handler) { addListener(event, handler); },
  };
  return window.DroneFace;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* test/debug internals — not part of the public DroneFace contract */
function makeInternals() {
  const GROUP_NAMES = ['face', 'hair', 'neck', 'mouth', 'eye'];
  window.__DF = {
    getState: () => state,
    getForm: () => form,
    getVoiceStream: createPlaybackStream,
    getAudioMeter: () => ({ ...audioMeter, smooth: mouthOpen }),
    getUniforms: () => ({
      mouthOpen: +uniforms.uMouthOpen.value.toFixed(4),
      lipWidth: +uniforms.uLipWidth.value.toFixed(4),
      blink: +uniforms.uBlink.value.toFixed(4),
      form: +uniforms.uForm.value.toFixed(4),
    }),
    getAudioClock: () => (audioCtx ? { state: audioCtx.state, t: +audioCtx.currentTime.toFixed(3), rate: audioCtx.sampleRate } : null),
    parseSSE: createSSEParser,
    int16FromBase64: base64ToInt16,
    voicesUrlFor: voicesUrl,
    getMouth: () => ({ open: mouthOpen, width: lipWidth }),
    getOrientation: () => ({ yaw, pitch, roll: idle.roll, idleYaw: idle.yaw, idleRoll: idle.roll }),
    getIdle: () => ({
      phase: idle.phase, step: idle.step, t: +idle.t.toFixed(3),
      yaw: +idle.yaw.toFixed(4), roll: +idle.roll.toFixed(4), enabled: idle.enabled,
    }),
    getCounts() {
      if (!geometry) return null;
      const g = geometry.getAttribute('aGroup');
      const r = geometry.getAttribute('aReserve');
      const c = { face: 0, hair: 0, neck: 0, mouth: 0, eye: 0, reserve: 0, total: g.count };
      for (let i = 0; i < g.count; i++) {
        c[GROUP_NAMES[g.getX(i)]]++;
        if (r && r.getX(i) > 0.5) c.reserve++;
      }
      return c;
    },
    geometryStats() {
      if (!geometry) return null;
      const g = geometry.getAttribute('aGroup');
      const pos = geometry.getAttribute('position');
      const mo = geometry.getAttribute('aMouthOpen');
      const blink = geometry.getAttribute('aBlink');
      let noseZ = -Infinity, nose = { x: 0, y: 0, z: 0 };
      let jawDrop = 0, blinkMax = 0;
      const eyeXs = [];
      for (let i = 0; i < g.count; i++) {
        const grp = g.getX(i);
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (grp === 0 && z > noseZ) { noseZ = z; nose = { x, y, z }; }
        if (grp === 3) jawDrop = Math.max(jawDrop, -mo.getY(i));
        // the points that carry a blink displacement are the lids, whatever group
        // they belong to — that is the property the test actually cares about
        const bl = Math.hypot(blink.getX(i), blink.getY(i), blink.getZ(i));
        if (bl > 1e-6) { eyeXs.push(x); blinkMax = Math.max(blinkMax, bl); }
      }
      return { noseTip: nose, jawDropMax: jawDrop, blinkMax, eyeXs };
    },
    attributeNaNCount() {
      if (!geometry) return -1;
      let n = 0;
      for (const name of ['position', 'normal', 'aMouthOpen', 'aMouthWide', 'aBlink']) {
        const a = geometry.getAttribute(name);
        for (let i = 0; i < a.count * a.itemSize; i++) if (!isFinite(a.array[i])) n++;
      }
      return n;
    },
    renderStats() {
      if (!renderer) return null;
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let lit = 0, sumX = 0, sumY = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (buf[i] + buf[i + 1] + buf[i + 2] > 60) { lit++; sumX += x; sumY += y; }
        }
      }
      return { w, h, lit, cx: lit ? sumX / lit : -1, cy: lit ? sumY / lit : -1 };
    },
    tick,
    computeMouth,
    requestTTS,
    pause,
    resume,
  };
}

/* ============================================================================
 * 10. transitions / animation drivers
 * ==========================================================================*/

let form = 0;          // current uForm value
let formTarget = 0;
let formSpeed = 0;     // 1/duration, sign = direction
let formT = 0;         // 0..1 within transition
let blink = 0;         // current blink amount
let blinkTarget = 0;
let blinkAt = 0;
let speakQueued = '';   // text queued while the face forms, then spoken

function beginForming() {
  setState(State.FORMING);
  formTarget = 1;
  formSpeed = 1 / (reducedMotion ? CONFIG.formDuration * 0.6 : CONFIG.formDuration);
  formT = 0;
  document.getElementById('startWrap').classList.add('hidden');
}

function beginDispersing() {
  stopVoice();          // a dispersed face must not keep talking over the transition
  setState(State.DISPERSING);
  formTarget = 0;
  formSpeed = -1 / CONFIG.disperseDuration;
  formT = 0;
  dispersed = true;
}

// form the face if needed, then speak (used by the text box / Generate voice)
function requestSpeak(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (state === State.ACTIVE || state === State.SPEAKING) {
    speak(t);
  } else {
    speakQueued = t;
    if (state === State.IDLE) window.DroneFace.start();
  }
}

function transitionsStep(dt) {
  if (form !== formTarget) {
    formT += dt * Math.abs(formSpeed);
    form += formSpeed * dt;
    if ((formSpeed > 0 && form >= formTarget) || (formSpeed < 0 && form <= formTarget)) {
      form = formTarget;
      formT = 1;
      formSpeed = 0;
      if (formTarget === 1) {
        setState(State.ACTIVE);
        lastInputAt = now;
        if (speakQueued) { const t = speakQueued; speakQueued = ''; speak(t); }
      } else {
        yaw = 0; pitch = 0; yawTarget = 0; pitchTarget = 0; // ease back to centre
        setState(State.IDLE);
      }
    }
  }
  uniforms.uForm.value = form;

  // blink scheduler (only while formed)
  if (state === State.ACTIVE || state === State.SPEAKING) {
    if (now >= blinkAt) {
      blinkTarget = 1;
      blinkAt = now + CONFIG.blinkMin + Math.random() * (CONFIG.blinkMax - CONFIG.blinkMin);
    }
  } else {
    blinkTarget = 0;
  }
  const bk = blink < blinkTarget ? (blinkTarget - blink) : (blink - blinkTarget);
  if (blinkTarget === 0 && blink < 0.001) blink = 0;
  else blink = Math.max(0, Math.min(1, blink + (blinkTarget - blink) * Math.min(1, dt / (CONFIG.blinkDuration / 3))));
  // when blink target reached, start closing
  if (blinkTarget === 1 && blink > 0.97) blinkTarget = 0;
  uniforms.uBlink.value = blink;

  // breathing
  uniforms.uBreath.value = 1 + 0.005 * Math.sin(now * 0.8);
}

/* ============================================================================
 * 11. UI
 * ==========================================================================*/

const startWrap = document.getElementById('startWrap');
const startBtn = document.getElementById('startBtn');
const disperseBtn = document.getElementById('disperseBtn');
const soundBtn = document.getElementById('soundBtn');

function updateUI() {
  if (state === State.IDLE) {
    startWrap.classList.remove('hidden');
    startBtn.textContent = dispersed ? 'Reform' : 'Start';
  } else {
    startWrap.classList.add('hidden');
  }
  disperseBtn.classList.toggle('visible', state === State.ACTIVE);
  soundBtn.classList.toggle('on', soundOn);
  soundBtn.classList.toggle('off', !soundOn);
  soundBtn.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
}

// Voice settings panel: endpoint, model, voice. Persisted in localStorage, and
// seedable from the URL (?endpoint=…&model=…&voice=…) so a room can be configured
// without touching the page (spec §9).
function initTTSSettings() {
  const btn = document.getElementById('ttsBtn');
  const panel = document.getElementById('ttsPanel');
  if (!btn || !panel) return;
  const q = new URLSearchParams(location.search);
  if (q.get('endpoint')) setEndpointStore(q.get('endpoint'));
  if (q.get('model')) setModelStore(q.get('model'));
  if (q.get('voice')) setVoiceStore(q.get('voice'));

  const ep = document.getElementById('ttsEndpoint');
  const md = document.getElementById('ttsModel');
  const vc = document.getElementById('ttsVoice');
  // suggestions from CONFIG.tts, so the known-good lab settings are one keystroke away
  const fill = (listId, values) => {
    const dl = document.getElementById(listId);
    if (dl) dl.innerHTML = values.map((v) => `<option value="${v}">`).join('');
  };
  fill('ttsVoiceList', CONFIG.tts.voices);
  fill('ttsModelList', [CONFIG.tts.model]);
  const readFields = () => { ep.value = getEndpoint(); md.value = getModel(); vc.value = getVoice(); refreshVoices(); };
  readFields();

  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { readFields(); ep.focus(); }   // show what is stored now, not at page load
  });
  // commit as you type: this is a demo control, not a form
  ep.addEventListener('input', () => { setEndpointStore(ep.value.trim()); updateTTSStatus(); refreshVoices(true); });
  md.addEventListener('input', () => { setModelStore(md.value.trim()); updateTTSStatus(); });
  vc.addEventListener('input', () => { setVoiceStore(vc.value.trim() || CONFIG.tts.voice); updateTTSStatus(); renderVoiceChips(); });
}

// Voice suggestions come from the server when it will say (`GET {origin}/v1/audio/voices`),
// and from CONFIG.tts when it will not — a stale hardcoded list is how this looked wrong
// with nine perfectly good voices installed.
let voiceSuggestions = { list: CONFIG.tts.voices, source: 'built-in' };
function setVoiceSuggestions(list, source) {
  if (!list || !list.length) return;
  voiceSuggestions = { list, source };
  const dl = document.getElementById('ttsVoiceList');
  if (dl) dl.innerHTML = list.map((v) => `<option value="${escapeHTML(v)}">`).join('');
  renderVoiceChips();
}

// One click auditions a voice: pick it and say the sample line. Typing a name into a text
// box to compare nine of them is not how anyone actually chooses a voice.
function renderVoiceChips() {
  const box = document.getElementById('ttsVoices');
  if (!box) return;
  const list = voiceSuggestions.list;
  box.hidden = list.length < 2;
  box.innerHTML = list.map((v) =>
    `<button type="button" data-voice="${escapeHTML(v)}" aria-pressed="${v === getVoice()}">${escapeHTML(v)}</button>`).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-voice]');
      if (!btn) return;
      setVoiceStore(btn.dataset.voice);
      renderVoiceChips();
      updateTTSStatus();
      requestSpeak(CONFIG.tts.sample);
    });
  }
}
let voiceRefresh = 0;
async function refreshVoices(debounced) {
  clearTimeout(voiceRefresh);
  if (debounced) { voiceRefresh = setTimeout(refreshVoices, 500); return; }
  const url = voicesUrl(getEndpoint());
  if (!url) { setVoiceSuggestions(CONFIG.tts.voices, 'built-in'); updateTTSStatus(); return; }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const list = [...(j.voices || []), ...(j.uploaded_voices || [])].filter(Boolean);
    if (!list.length) throw new Error('empty');
    setVoiceSuggestions(list, 'server');
  } catch (_) {
    setVoiceSuggestions(CONFIG.tts.voices, 'built-in');
  }
  updateTTSStatus();
}

// One line that says what the voice actually is. Silence with no explanation is what
// makes a demo like this undiagnosable.
function updateTTSStatus() {
  const el = document.getElementById('ttsStatus');
  if (!el) return;
  const modeName = {
    tts: 'TTS endpoint', 'tts-stream': 'TTS stream', 'browser-tts': 'browser voice', simulated: 'simulated',
    fallback: 'fell back', requesting: 'asking the server', none: 'not used yet',
  }[ttsStatus.mode] || ttsStatus.mode;
  el.className = ttsStatus.mode === 'tts' || ttsStatus.mode === 'tts-stream' ? '' : 'warn';
  el.innerHTML = `<b>${modeName}</b> — ${escapeHTML(ttsStatus.detail)}` +
    (getEndpoint() ? ` · ${escapeHTML(getEndpoint())}` : ' · no endpoint set') +
    ` · model ${escapeHTML(getModel())} · voice ${escapeHTML(getVoice())}` +
    ` · ${voiceSuggestions.list.length} voices (${escapeHTML(voiceSuggestions.source)})`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function initUI() {
  startBtn.addEventListener('click', () => window.DroneFace.start());
  disperseBtn.addEventListener('click', () => window.DroneFace.disperse());
  soundBtn.addEventListener('click', () => setSound(!soundOn));

  const voiceText = document.getElementById('voiceText');
  const voiceBtn = document.getElementById('voiceBtn');
  voiceBtn.addEventListener('click', () => requestSpeak(voiceText.value));
  voiceText.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestSpeak(voiceText.value); });

  initTTSSettings();
  updateTTSStatus();

  updateUI();

  // debug overlay (?debug=1): one panel that says what every part of the voice path
  // is doing, because "the face is frozen" has five different causes and you should not
  // have to open devtools to tell them apart. Uses setInterval so it keeps reporting even
  // if the render loop itself has stopped.
  if (/[?&]debug=1/.test(location.search)) {
    const diag = document.createElement('pre');
    diag.id = 'diag';
    diag.style.cssText = 'position:fixed;left:12px;top:12px;z-index:14;margin:0;' +
      'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fc4e8;' +
      'background:rgba(2,6,13,0.86);border:1px solid rgba(25,230,211,0.25);border-radius:8px;' +
      'padding:8px 11px;white-space:pre;pointer-events:none;';
    document.body.appendChild(diag);
    const line = (k, v) => k.padEnd(10) + String(v);
    setInterval(() => {
      const vs = window.DroneFace.voiceStatus();
      const m = __DF.getAudioMeter();
      const c = __DF.getAudioClock();
      const u = __DF.getUniforms();
      diag.textContent = [
        line('build', BUILD),
        line('frames', frames) + '   ' + line('state', state),
        line('audio', c ? `${c.state} t=${c.t.toFixed(2)}s ${c.rate}Hz` : 'no AudioContext'),
        line('rms', m.rms.toFixed(4)) + '   ' + line('gain peak', m.peak.toFixed(4)) + '   ' + line('floor', CONFIG.noiseFloor),
        line('open', m.smooth.toFixed(3)) + '   ' + line('width', lipWidth.toFixed(3)) + '   ' + line('target', m.target.toFixed(3)),
        // the two lines that matter when the face will not talk: computed value vs what
        // the shader was actually handed
        line('uniforms', u ? `mouth ${u.mouthOpen}  wide ${u.lipWidth}  blink ${u.blink}` : '?'),
        line('orient', `yaw ${yaw.toFixed(1)}  pitch ${pitch.toFixed(1)}  idle ${JSON.stringify(__DF.getIdle()).replace(/["{}]/g, '')}`),
        line('playing', `${audioActive}  synth ${synthVoice}  sound ${soundOn}`),
        line('mode', `${vs.mode}  (${vs.detail})`.slice(0, 62)),
        line('endpoint', (vs.endpoint || 'none').slice(0, 62)),
      ].join('\n');
    }, 250);
  }

  // debug file picker (?debug=1)
  if (/[?&]debug=1/.test(location.search)) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.style.cssText = 'position:fixed;left:20px;top:20px;z-index:12;';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      ensureAudio();
      const audio = new Audio(URL.createObjectURL(f));
      window.DroneFace.attachAudio(audio);
      audio.play();
    });
    document.body.appendChild(input);
  }
}

/* ============================================================================
 * 12. events
 * ==========================================================================*/

const listeners = {};
function addListener(event, handler) {
  (listeners[event] = listeners[event] || []).push(handler);
}
function emit(event, payload) {
  for (const h of listeners[event] || []) { try { h(payload); } catch (_) {} }
}

/* ============================================================================
 * 13. render loop / lifecycle
 * ==========================================================================*/

let now = 0, lastFrame = 0, running = true, hidden = false;
let frames = 0;                       // tick count: proof the render loop is alive
const BUILD = (document.querySelector('meta[name="droneface:build"]') || {}).content || 'source';
let fpsFrames = 0, fpsTime = 0, reducedDone = false;

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.dprCap));
  camera.aspect = w / h;

  // fit the head (2 units) to a viewport fraction, in both height and width
  const tan = Math.tan(CONFIG.fov * Math.PI / 360);
  const dH = 1.0 / (CONFIG.faceFractionHeight * tan);
  const dW = 0.6 / (CONFIG.faceFractionWidth * tan * camera.aspect);
  camera.position.z = Math.max(dH, dW, 3.2);
  camera.updateProjectionMatrix();

  // point size scales with viewport height and DPR
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.dprCap);
  uniforms.uPointScale.value = h * dpr * CONFIG.pointFraction * camera.position.z;
}

function tick(dt) {
  now += dt;
  frames++;
  transitionsStep(dt);
  orientStep(dt);
  updateLipSync(dt);
  // The mouth uniforms were declared, used by the shader, and never written — the face
  // computed a perfect mouthOpen every frame and the swarm stood still. Blink and
  // formation were wired; the mouth was not.
  uniforms.uMouthOpen.value = mouthOpen;
  uniforms.uLipWidth.value = lipWidth;
  uniforms.uTime.value = now;
}

function animate() {
  if (!running) return;
  requestAnimationFrame(animate);

  const t = performance.now() / 1000;
  const dt = Math.min(0.1, t - lastFrame);
  lastFrame = t;

  // auto-reduce quality after warmup if frames are slow
  if (!reducedDone && started) {
    fpsFrames++; fpsTime += dt;
    if (fpsFrames >= CONFIG.fpsWarmupFrames) {
      const fps = fpsFrames / fpsTime;
      if (fps < CONFIG.fpsMin) { rebuildGeometry(CONFIG.reducedCounts); }
      reducedDone = true;
    }
  }

  tick(dt);
  renderer.render(scene, camera);
}

function pause() { running = false; }
function resume() { if (!running) { running = true; lastFrame = performance.now() / 1000; requestAnimationFrame(animate); } }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
  else resume();
});

/* ============================================================================
 * 14. boot
 * ==========================================================================*/

const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

loadSoundPref();
// point the demo at the lab's qwen3-tts box unless it has been configured before
if (getEndpoint() === '') setEndpointStore(CONFIG.tts.endpoint);
if (initRenderer()) {
  initInput();
  initUI();
  makeApi();
  makeInternals();
  resize();
  updateUI();
  lastFrame = performance.now() / 1000;
  requestAnimationFrame(animate);
}
