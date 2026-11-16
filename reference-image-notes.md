# Reference image notes (text description of `reference_image.png`)

Source: operator-provided description, for tuning the procedural face. The image
itself (788x1135 portrait PNG) is the night-time drone-show face; this file lets
a text-only session build against it without viewing the image.

## What it is
A phone photo/video frame of a night-time drone light show. Thousands of small
drones, each a single point of coloured light, form a giant frontal 3D face in
the sky. It is a point cloud, never a solid surface: every light is an
individual dot with a small glow, separated by dark gaps.

## Scene composition
- Sky: near-black navy (~#02030c to #050a1e), no stars, no gradient.
- Face: horizontally centred (centre x ~0.49 W), spanning ~0.08 H to ~0.61 H.
  Face width ~0.45 W. Taller than wide.
- Foreground (bottom 15%): crowd silhouettes, raised phones, small warm/amber/
  magenta/teal ground lights, trees, a hill. NOT to be reproduced.
- Dots ~3-4 px with a soft 2-3 px glow. No sharp edges.

## Face proportions (head height: hair crest top = 0%, chin = 100%)
- Hair crest top: 0%. Forehead hairline: ~16%.
- Eye line: ~49%. Eyes almond, ~80 px wide (23% of face width), centres ~200 px
  apart (57% of face width).
- Nose tip: ~68%. Nose width ~90 px (26% of face width), wide nostrils.
- Mouth line: ~82%. Mouth width ~135 px (39% of face width).
- Chin: 100%, rounded.
- Outline: elongated oval. Widest at cheekbones, narrowing to jaw then chin.
- Expression: neutral, mouth closed, eyes open, strictly frontal, no tilt.
  Gender-neutral, smooth, generic features.

## Feature structure
- Forehead: smooth, high, evenly filled.
- Brow: darker band just above the eyes (shadowed brow ridge), gently curved.
- Eyes: dark sockets (sparse/dim dots), brighter ring around the eye opening,
  ring-shaped iris with dark pupil centre.
- Nose: bright vertical stripe of denser dots down the bridge, rounded bright
  tip, dark gaps at the nostrils and nose-wing sides.
- Cheeks: smooth, evenly filled, slightly dimmer than the rim.
- Mouth: dark horizontal band (fewer, dimmer dots) with slightly brighter upper
  and lower lip edge; darker area under the lower lip.
- Jaw/chin: strong bright rim along the jawline, rounded chin.
- Hair: not a volume; a thin cap/band ~40-60 px thick following the top of the
  head, a dense scalloped ridge 2-3 dots thick. Forehead continues below it.
- Ears: small sparse arcs at each side, dimmer than the face.
- Neck/shoulders: very sparse; two thin curved strands down from the jaw sides
  with scattered dots forming a loose V; a few isolated dots at shoulder level.
  Dim, fading out.

## Drone distribution / 3D effect
- Face surface dots sit on a smooth surface in a roughly even, slightly
  staggered lattice, ~7-9 px apart; ~50 dots across, ~70-75 rows down
  (~3,000-5,000 visible face dots).
- Edge-density effect: at the silhouette the surface turns away, so dots bunch
  and merge into a bright continuous rim — the main depth cue.
- Shading is by dot brightness and density, NOT by lighting. No cast shadow or
  occlusion. Recessed areas (eye sockets, nostrils, under brow, under lower lip,
  nose sides) are dimmer and sparser; protruding areas (nose bridge/tip,
  cheekbones, brow edge) are brighter.
- Moire/hex patterns where rows overlap should be kept.
- Single layer of dots; no second surface behind the face.

## Colour (reference — informational)
- Face interior: electric blue/cobalt (#2a5bff to #3b7bff).
- Face rim: bright cyan-white (#7fe9ff to #d8f6ff).
- Accents: pink/magenta-violet on nose, around eyes/mouth; lavender-pink hair/
  ears/neck. Brightness hierarchy: rim > nose bridge > hair crest > interior >
  ears > neck.

## Adaptation for this project (authoritative)
- Face: TURQUOISE ~#19e6d3, cyan rim #7ff5ea, slight variation toward #2ad0ff.
- Hair + ears: BOTTLE GREEN ~#0b7a56 (brightened for the dark background).
- Neck + shoulders: dimmed turquoise.
- KEEP: frontal pose, proportions above, feature shading by density/brightness,
  strong bright rim from edge density, sparse hair/ears/neck.
- DO NOT copy: pink/violet accents, crowd, trees, hills, ground lights.
