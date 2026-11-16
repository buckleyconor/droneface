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
    face: 2240,   // base surface (density-shaded, no neck/ears)
    hair: 490,    // wavy bottle-green strands over the crown
    eyes: 140,    // eyelid rims (blink group)
  },
  reducedCounts: {
    face: 1120,
    hair: 245,
    eyes: 70,
  },
  reserveFraction: 0.285,  // share of drones hidden while dispersed (start screen)

  // head ellipsoid half-axes (normalised, centre at eye line, y up, z forward)
  head: { rx: 0.60, ry: 1.0, rz: 0.55 },

  // colours
  colorFace: '#19e6d3',
  colorHair: '#18c990',   // bottle green, brightened to read on the dark sky
  colorNeck: '#19e6d3',   // face turquoise, dimmed in shader
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

  // camera
  fov: 35,
  faceFractionHeight: 0.80, // head (2 units) fills this fraction of viewport height
  faceFractionWidth: 0.90,

  // points
  pointFraction: 0.0065,    // point diameter as fraction of viewport height (device px)
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

  // blink
  blinkMin: 3.0,
  blinkMax: 6.0,
  blinkDuration: 0.22,

  // performance
  dprCap: 2,
  fpsWarmupFrames: 60,
  fpsMin: 40,

  // ambient
  ambientFade: 2.0,
  ambientToggleRamp: 0.3,
  duckDb: 6.0,              // ducking while speaking
  duckRamp: 0.5,
};

/* ============================================================================
 * 2. face generator
 * ==========================================================================*/

// Named, tunable feature parameters (spec §7). All positions in normalised
// head units: y +1 = hair crest, y -1 = chin, x in +-rx, z toward viewer.
const FACE = {
  // measured from reference-image-notes.md (fraction of head height)
  hairline: 0.68,           // y where the forehead meets the hair cap
  eyeLine: 0.02,
  eyeX: 0.342,              // eye centre x (separation 57% of face width)
  eyeHalfW: 0.138,          // eye width 23% of face width
  eyeHalfH: 0.05,
  noseTipY: -0.40,
  mouthY: -0.64,
  mouthHalfW: 0.234,        // mouth width 39% of face width
  mouthHalfH: 0.14,
  chinY: -0.92,

  // relief: Gaussian bumps/dips {cx, cy, sx, sy, amp} (amp + = out toward viewer)
  relief: [
    // eye sockets (deep)
    { cx: -0.342, cy: 0.02, sx: 0.095, sy: 0.048, amp: -0.16 },
    { cx:  0.342, cy: 0.02, sx: 0.095, sy: 0.048, amp: -0.16 },
    // brow ridge (subtle shadow band above the eyes)
    { cx: -0.342, cy: 0.13, sx: 0.13, sy: 0.05, amp: -0.05 },
    { cx:  0.342, cy: 0.13, sx: 0.13, sy: 0.05, amp: -0.05 },
    // nose bridge + tip (clearly protruding)
    { cx: 0.0, cy: -0.10, sx: 0.085, sy: 0.17, amp: 0.17 },
    { cx: 0.0, cy: -0.42, sx: 0.09, sy: 0.09, amp: 0.23 },
    // nostrils (deep)
    { cx: -0.06, cy: -0.47, sx: 0.035, sy: 0.03, amp: -0.08 },
    { cx:  0.06, cy: -0.47, sx: 0.035, sy: 0.03, amp: -0.08 },
    // cheekbones (defined)
    { cx: -0.30, cy: -0.05, sx: 0.13, sy: 0.10, amp: 0.11 },
    { cx:  0.30, cy: -0.05, sx: 0.13, sy: 0.10, amp: 0.11 },
    // lips (fuller, with a clear mouth line)
    { cx: 0.0, cy: -0.54, sx: 0.11, sy: 0.032, amp: 0.11 },
    { cx: 0.0, cy: -0.71, sx: 0.09, sy: 0.038, amp: 0.10 },
    { cx: 0.0, cy: -0.63, sx: 0.11, sy: 0.014, amp: -0.055 }, // mouth line dip
    // chin + jawline
    { cx: 0.0, cy: -0.90, sx: 0.12, sy: 0.10, amp: 0.10 },
    { cx: -0.26, cy: -0.74, sx: 0.09, sy: 0.10, amp: 0.05 },
    { cx:  0.26, cy: -0.74, sx: 0.09, sy: 0.10, amp: 0.05 },
  ],
};

const { rx, ry, rz } = CONFIG.head;

function reliefZ(x, y) {
  let z = 0;
  for (const f of FACE.relief) {
    const dx = (x - f.cx) / f.sx;
    const dy = (y - f.cy) / f.sy;
    z += f.amp * Math.exp(-0.5 * (dx * dx + dy * dy));
  }
  return z;
}

// face-shaped half-width profile: widest at the cheekbones, narrow at jaw/chin
function headHalfWidth(y) {
  const P = [
    { y:  1.00, w: 0.40 },
    { y:  0.55, w: 0.52 },
    { y:  0.05, w: 0.60 },
    { y: -0.25, w: 0.58 },
    { y: -0.55, w: 0.48 },
    { y: -0.82, w: 0.38 },
    { y: -1.00, w: 0.24 },
  ];
  for (let i = 0; i < P.length - 1; i++) {
    if (y <= P[i].y && y >= P[i + 1].y) {
      const t = (P[i].y - y) / (P[i].y - P[i + 1].y);
      return P[i].w + t * (P[i + 1].w - P[i].w);
    }
  }
  return P[P.length - 1].w;
}

// front surface z (face-shaped outline + relief); null if outside the head
function surfaceZ(x, y) {
  const w = headHalfWidth(y);
  const a = (x * x) / (w * w) + (y * y) / (ry * ry);
  if (a >= 1.0) return null;
  return rz * Math.sqrt(1.0 - a) + reliefZ(x, y);
}

// surface normal from the height field (finite differences); +z facing viewer
function surfaceNormal(x, y) {
  const h = 0.008;
  const zx1 = surfaceZ(x + h, y), zx0 = surfaceZ(x - h, y);
  const zy1 = surfaceZ(x, y + h), zy0 = surfaceZ(x, y - h);
  const dzdx = (zx1 == null || zx0 == null) ? 0 : (zx1 - zx0) / (2 * h);
  const dzdy = (zy1 == null || zy0 == null) ? 0 : (zy1 - zy0) / (2 * h);
  const n = { x: -dzdx, y: -dzdy, z: 1.0 };
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  return { x: n.x / len, y: n.y / len, z: n.z / len };
}

// brightness multiplier from relief (protrusions bright, recesses dark)
function reliefShade(x, y) {
  return Math.max(0.3, Math.min(1.5, 1.0 + reliefZ(x, y) * 5.0));
}

function groupOf(x, y) {
  // mouth region (elliptical)
  const mx = x / FACE.mouthHalfW, my = (y - FACE.mouthY) / FACE.mouthHalfH;
  if (mx * mx + my * my <= 1.0) return 3; // mouth
  return 0; // face
}

// mouth weight: 1 at the lower lip/jaw, falling to 0 at the mouth boundary
function mouthWeight(x, y) {
  const mx = x / FACE.mouthHalfW, my = (y - FACE.mouthY) / FACE.mouthHalfH;
  const d2 = mx * mx + my * my;
  if (d2 >= 1.0) return 0;
  return Math.pow(1.0 - d2, 0.8);
}

// mouth-open displacement (weighted): jaw drops down+back, upper lip rises
function mouthOpenDelta(x, y, w) {
  const below = y < FACE.mouthY;
  if (below) return { x: 0, y: -0.08 * w, z: -0.015 * w };
  return { x: 0, y: 0.012 * w, z: 0.005 * w };
}

// mouth-wide displacement (weighted): corners spread outward
function mouthWideDelta(x, y, w) {
  return { x: x * 0.12 * w, y: 0, z: 0 };
}

function gauss(x, y, cx, cy, sx, sy) {
  const dx = (x - cx) / sx, dy = (y - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

// density field: denser on protruding features, sparser in recesses (shading
// by dot density, like the reference) rather than drawn-on lines
function densityWeight(x, y) {
  let d = 1.0;
  d += 1.2 * gauss(x, y, 0, -0.25, 0.06, 0.20);      // nose bridge
  d += 1.4 * gauss(x, y, 0, -0.43, 0.08, 0.06);      // nose tip
  d -= 0.9 * gauss(x, y, -0.342, 0.02, 0.10, 0.055); // eye sockets
  d -= 0.9 * gauss(x, y,  0.342, 0.02, 0.10, 0.055);
  d += 0.7 * gauss(x, y, 0, -0.54, 0.12, 0.025);     // upper lip
  d += 0.7 * gauss(x, y, 0, -0.71, 0.10, 0.025);     // lower lip
  d -= 0.6 * gauss(x, y, 0, -0.63, 0.11, 0.013);     // mouth line
  d += 0.6 * gauss(x, y, -0.30, -0.06, 0.07, 0.05);  // cheekbones
  d += 0.6 * gauss(x, y,  0.30, -0.06, 0.07, 0.05);
  d -= 0.5 * gauss(x, y, -0.06, -0.48, 0.03, 0.025); // nostrils
  d -= 0.5 * gauss(x, y,  0.06, -0.48, 0.03, 0.025);
  const w = headHalfWidth(y);
  const r = Math.sqrt((x * x) / (w * w) + (y * y) / (ry * ry));
  if (y < -0.5) d += 0.8 * Math.exp(-0.5 * Math.pow((r - 0.94) / 0.05, 2)); // jaw rim
  return Math.max(0.25, Math.min(2.0, d));
}

// stratified sampling over the face outline, thinned by density (denser on
// features, sparser in recesses)
function sampleFace(count) {
  const faceArea = 1.35;
  const cell = Math.sqrt(faceArea / (count * 1.3));
  const nx = Math.max(2, Math.ceil((2 * 0.62) / cell));
  const ny = Math.max(2, Math.ceil((2 * ry) / cell));
  const pts = [];
  for (let iy = 0; iy < ny && pts.length < count; iy++) {
    for (let ix = 0; ix < nx && pts.length < count; ix++) {
      const x = -0.62 + (ix + Math.random()) * (2 * 0.62 / nx);
      const y = -ry + (iy + Math.random()) * (2 * ry / ny);
      if (surfaceZ(x, y) == null) continue;
      if (Math.random() > densityWeight(x, y) / 2.0) continue;
      pts.push([x, y]);
    }
  }
  while (pts.length < count) {
    const x = (Math.random() * 2 - 1) * 0.62;
    const y = (Math.random() * 2 - 1) * ry;
    if (surfaceZ(x, y) == null) continue;
    if (Math.random() > densityWeight(x, y) / 2.0) continue;
    pts.push([x, y]);
  }
  return pts;
}

function buildPoints(counts) {
  const pts = [];
  const Z = () => ({ x: 0, y: 0, z: 0 });

  const push = (x, y, z, n, group, shade, mo, mw2, blink, reserve) => {
    pts.push({ p: [x, y, z], n, group, shade, mo, mw2, blink, reserve });
  };

  // project a face-plane point onto the surface and push it with all attributes
  const pushSurface = (x, y, group) => {
    const z = surfaceZ(x, y);
    if (z == null) return false;
    const n = surfaceNormal(x, y);
    const shade = reliefShade(x, y);
    const g = (group == null) ? groupOf(x, y) : group;
    const mw = mouthWeight(x, y);
    const reserve = Math.random() < CONFIG.reserveFraction;
    push(x, y, z, n, g, shade, mouthOpenDelta(x, y, mw), mouthWideDelta(x, y, mw), Z(), reserve);
    return true;
  };

  // 1. face surface (density-shaded; no drawn feature lines)
  for (const [x, y] of sampleFace(counts.face)) {
    pushSurface(x, y);
  }

  // 2. hair: wavy bottle-green strands flowing over the crown
  const hairRows = 15;
  const perRow = Math.ceil((counts.hair * 1.15) / hairRows);
  for (let r = 0; r < hairRows; r++) {
    const y = 0.56 + (r / (hairRows - 1)) * 0.42;      // 0.56 .. 0.98
    const surfaceW = headHalfWidth(y) * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry)));
    const amp = surfaceW * (0.08 + 0.10 * (r / hairRows));
    const freq = 2.0 + 0.4 * Math.sin(r * 1.1);
    const phase = r * 1.7;
    for (let i = 0; i < perRow; i++) {
      const t = (i / (perRow - 1)) - 0.5;              // -0.5 .. 0.5
      const x = t * 2 * surfaceW * 0.92 + amp * Math.sin(t * 2 * Math.PI * freq + phase);
      pushSurface(x, y, 1);
    }
  }

  // 3. eyes: eyelid rim ring around each socket (the blink group)
  const eyeRim = Math.floor(counts.eyes / 2);
  for (let e = 0; e < 2; e++) {
    const ex = (e === 0 ? -1 : 1) * FACE.eyeX;
    for (let i = 0; i < eyeRim; i++) {
      const ang = (i / eyeRim) * Math.PI * 2;
      const x = ex + Math.cos(ang) * FACE.eyeHalfW;
      const y = FACE.eyeLine + Math.sin(ang) * FACE.eyeHalfH;
      const z = surfaceZ(x, y);
      if (z == null) continue;
      const n = surfaceNormal(x, y);
      const cx = ex, cy = FACE.eyeLine, cz = surfaceZ(ex, cy) ?? 0;
      const dx = cx - x, dy = cy - y, dz = cz - z;
      pts.push({
        p: [x, y, z], n, group: 4, shade: 0.8,
        mo: { x: 0, y: 0, z: 0 }, mw2: { x: 0, y: 0, z: 0 },
        blink: { x: dx * 0.55, y: dy * 0.55, z: dz * 0.55 },
        reserve: false,
      });
    }
  }

  return pts;
}

const Z3 = { x: 0, y: 0, z: 0 };

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

  // relief shading (protrusions bright, recesses dark)
  base *= vShade;

  // edge brightening toward the rim colour
  base = mix(base, uColorRim, smoothstep(0.35, 0.9, vEdge) * 0.85);

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

  // build model = RY(yaw) * RX(pitch)
  const rad = Math.PI / 180;
  const ry = new Matrix4().makeRotationY(yaw * rad);
  const rx = new Matrix4().makeRotationX(pitch * rad);
  model.multiplyMatrices(ry, rx);
  uniforms.uModel.value = model;
}

function rubber(v, limit) {
  // soft clamp: full travel inside, damped beyond
  if (Math.abs(v) <= limit) return v;
  return Math.sign(v) * (limit + (Math.abs(v) - limit) * 0.2);
}

/* ============================================================================
 * 7. audio & lip sync
 * ==========================================================================*/

let audioCtx = null;
let analyser = null;
let td = null, fd = null;       // time/freq domain buffers
let peak = 0;                   // adaptive gain running peak
let mouthOpen = 0, lipWidth = 0; // smoothed outputs
let audioActive = false;        // an audio source is currently playing
let demoActive = false;         // browser speechSynthesis demo voice is speaking
let manual = { open: 0, width: 0 };
let ambientOn = true;
let ambientNodes = null;        // { master, duck }
let ambientStarted = false;

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

function loadAmbientPref() {
  try {
    const v = localStorage.getItem('droneface.ambient');
    if (v === 'off') ambientOn = false;
  } catch (_) {}
}

function buildAmbient() {
  if (!audioCtx || ambientNodes) return;
  const master = audioCtx.createGain();
  master.gain.value = 0;
  const duck = audioCtx.createGain();
  duck.gain.value = 1;

  // gentle lowpass; cutoff slowly sweeps for an evolving timbre
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200;
  lp.Q.value = 0.4;
  master.connect(lp).connect(duck).connect(audioCtx.destination);

  const voice = (freq, detune, level, out) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = audioCtx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(out);
    osc.start();
  };

  // two chords slowly crossfade (Am-ish -> C-ish), so it isn't one chord looping
  const chordA = [110.0, 164.81, 220.0, 261.63, 329.63];
  const chordB = [130.81, 196.0, 261.63, 329.63, 392.0];
  const gA = audioCtx.createGain(); gA.gain.value = 0.5;
  const gB = audioCtx.createGain(); gB.gain.value = 0.5;
  const lvlA = [0.14, 0.10, 0.09, 0.06, 0.04];
  const lvlB = [0.13, 0.09, 0.08, 0.055, 0.035];
  chordA.forEach((f, i) => voice(f, i * 1.1, lvlA[i], gA));
  chordB.forEach((f, i) => voice(f, -i * 0.9, lvlB[i], gB));

  // out-of-phase LFO crossfades gA and gB over ~22 s
  const breath = audioCtx.createGain(); breath.gain.value = 1.0;
  gA.connect(breath); gB.connect(breath); breath.connect(master);

  const xf = audioCtx.createOscillator(); xf.type = 'sine'; xf.frequency.value = 0.045;
  const xfA = audioCtx.createGain(); xfA.gain.value = 0.5;
  const xfB = audioCtx.createGain(); xfB.gain.value = -0.5;
  xf.connect(xfA).connect(gA.gain);
  xf.connect(xfB).connect(gB.gain);
  xf.start();

  // slow filter sweep + gentle amplitude breathing
  const sweep = audioCtx.createOscillator(); sweep.type = 'sine'; sweep.frequency.value = 0.035;
  const sweepG = audioCtx.createGain(); sweepG.gain.value = 600;
  sweep.connect(sweepG).connect(lp.frequency);
  sweep.start();

  const br = audioCtx.createOscillator(); br.type = 'sine'; br.frequency.value = 0.07;
  const brG = audioCtx.createGain(); brG.gain.value = 0.12;
  br.connect(brG).connect(breath.gain);
  br.start();

  // very quiet high sparkle with slow vibrato (gentle shimmer, not noise)
  const hi = audioCtx.createOscillator(); hi.type = 'sine'; hi.frequency.value = 880;
  const hiG = audioCtx.createGain(); hiG.gain.value = 0.006;
  const vib = audioCtx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 0.08;
  const vibG = audioCtx.createGain(); vibG.gain.value = 14;
  vib.connect(vibG).connect(hi.frequency);
  hi.connect(hiG).connect(master);
  hi.start(); vib.start();

  ambientNodes = { master, duck };
}

function setAmbient(on) {
  ambientOn = !!on;
  try { localStorage.setItem('droneface.ambient', ambientOn ? 'on' : 'off'); } catch (_) {}
  if (ambientNodes) {
    const g = ambientNodes.master.gain;
    const t = audioCtx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(ambientOn ? 1 : 0, t, CONFIG.ambientToggleRamp);
  }
  updateUI();
}

function duckAmbient(ducked) {
  if (!ambientNodes) return;
  const g = ambientNodes.duck.gain;
  const t = audioCtx.currentTime;
  const target = ducked ? Math.pow(10, -CONFIG.duckDb / 20) : 1;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(target, t, CONFIG.duckRamp);
}

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

  return { open, width, peak: pk };
}

function updateLipSync(dt) {
  if (demoActive) {
    // synthetic speech envelope while the browser TTS speaks (demo mode)
    const t = now;
    const syll = 0.5 + 0.5 * Math.sin(t * 5.2 + 2.0 * Math.sin(t * 1.9));
    const breath = 0.75 + 0.25 * Math.sin(t * 3.3);
    const open = clamp01(syll * breath);
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
    mouthOpen = smooth(mouthOpen, r.open, CONFIG.mouthAttack, CONFIG.mouthRelease, dt);
    lipWidth = smooth(lipWidth, r.width, CONFIG.widthAttack, CONFIG.widthRelease, dt);
  } else {
    // no audio: fall back to manual values (usually 0)
    mouthOpen = smooth(mouthOpen, manual.open, CONFIG.mouthAttack, CONFIG.mouthRelease, dt);
    lipWidth = smooth(lipWidth, manual.width, CONFIG.widthAttack, CONFIG.widthRelease, dt);
  }
}

function decodeAndPlay(arrayBuffer) {
  return new Promise((resolve, reject) => {
    audioCtx.decodeAudioData(arrayBuffer, (buf) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      src.onended = () => endSpeech();
      src.start();
      beginSpeech();
      resolve();
    }, reject);
  });
}

function beginSpeech() {
  audioActive = true;
  duckAmbient(true);
  if (state === State.ACTIVE || state === State.IDLE) setState(State.SPEAKING);
  emit('speechStart', {});
}

function endSpeech() {
  audioActive = false;
  duckAmbient(false);
  if (state === State.SPEAKING) setState(State.ACTIVE);
  emit('speechEnd', {});
}

/* ============================================================================
 * 8. TTS client
 * ==========================================================================*/

function getEndpoint() { try { return localStorage.getItem('droneface.endpoint') || ''; } catch (_) { return ''; } }
function setEndpointStore(url) { try { localStorage.setItem('droneface.endpoint', url); } catch (_) {} }
function getVoice() { try { return localStorage.getItem('droneface.voice') || 'default'; } catch (_) { return 'default'; } }
function setVoiceStore(name) { try { localStorage.setItem('droneface.voice', name); } catch (_) {} }

// the only place that knows the TTS wire format (spec §11)
async function requestTTS(text) {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('no TTS endpoint configured');
  const voice = getVoice();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const j = await res.json();
    const b64 = j.audio_base64 || j.audio || j.data || j.b64 || (j.output && j.output.audio);
    if (!b64) throw new Error('no audio field in TTS response');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  return res.arrayBuffer();
}

async function speak(text) {
  ensureAudio();
  if (audioCtx) {
    try {
      const buf = await requestTTS(text);
      await decodeAndPlay(buf);
      return;
    } catch (_) { /* fall through to the offline demo voice */ }
  }
  demoSpeak(text);
}

function demoSpeak(text) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => {
      demoActive = true;
      duckAmbient(true);
      if (state === State.ACTIVE || state === State.IDLE) setState(State.SPEAKING);
      emit('speechStart', {});
    };
    const done = () => {
      demoActive = false;
      duckAmbient(false);
      if (state === State.SPEAKING) setState(State.ACTIVE);
      emit('speechEnd', {});
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  } catch (_) {}
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
      if (!ambientStarted) { buildAmbient(); setAmbient(ambientOn); fadeAmbientIn(); ambientStarted = true; }
      beginForming();
    },
    disperse() {
      if (state !== State.ACTIVE) return;
      beginDispersing();
    },
    get state() { return state; },
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
    setEndpoint(url) { setEndpointStore(url); },
    setVoice(name) { setVoiceStore(name); },
    attachStream() {
      // streaming hook (stub in v1) — later: AudioWorklet fed with PCM chunks
      return {
        push(_chunk) { /* TODO: feed AudioWorklet */ },
        end() { endSpeech(); },
      };
    },
    setMouth(open, width) {
      manual.open = clamp01(open);
      manual.width = width == null ? 0 : clamp01(width);
      audioActive = false;
    },
    setAmbient,
    get ambient() { return ambientOn; },
    setOrientationLimits({ yaw, pitch }) {
      if (typeof yaw === 'number') CONFIG.yawLimit = yaw;
      if (typeof pitch === 'number') CONFIG.pitchLimit = pitch;
    },
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
    getMouth: () => ({ open: mouthOpen, width: lipWidth }),
    getOrientation: () => ({ yaw, pitch }),
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
        if (grp === 4) { eyeXs.push(x); blinkMax = Math.max(blinkMax, Math.hypot(blink.getX(i), blink.getY(i), blink.getZ(i))); }
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

function fadeAmbientIn() {
  if (!ambientNodes) return;
  const g = ambientNodes.master.gain;
  const t = audioCtx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(ambientOn ? 1 : 0, t, CONFIG.ambientFade);
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
  soundBtn.classList.toggle('on', ambientOn);
  soundBtn.classList.toggle('off', !ambientOn);
  soundBtn.setAttribute('aria-label', ambientOn ? 'Sound on' : 'Sound off');
}

function initUI() {
  startBtn.addEventListener('click', () => window.DroneFace.start());
  disperseBtn.addEventListener('click', () => window.DroneFace.disperse());
  soundBtn.addEventListener('click', () => setAmbient(!ambientOn));

  const voiceText = document.getElementById('voiceText');
  const voiceBtn = document.getElementById('voiceBtn');
  voiceBtn.addEventListener('click', () => requestSpeak(voiceText.value));
  voiceText.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestSpeak(voiceText.value); });

  updateUI();

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
  transitionsStep(dt);
  orientStep(dt);
  updateLipSync(dt);
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

loadAmbientPref();
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
