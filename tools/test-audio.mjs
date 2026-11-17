// A speech-like WAV, generated rather than shipped. The checks need audio that varies like
// speech (syllable envelope, brief closures, a bright band for sibilants) to prove the mouth
// moves — they do not need anyone's music track, and a repo that carries no audio is a repo
// that can be published. Everything here is deterministic: no RNG, so a failing check fails
// the same way twice.
export function speechLikeWav(seconds = 2, rate = 24000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * t);          // ~3 Hz
    const word = Math.sin(2 * Math.PI * 2.2 * t) > -0.35 ? 1 : 0.1;         // brief closures
    const tone = 0.6 * Math.sin(2 * Math.PI * 180 * t) +
      0.3 * Math.sin(2 * Math.PI * 1240 * t) +
      0.12 * Math.sin(2 * Math.PI * 5300 * t);                              // top band for width
    const s = Math.max(-1, Math.min(1, syllable * word * tone * 0.55));
    data.writeInt16LE(s * 32767 | 0, i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);           // PCM
  hdr.writeUInt16LE(1, 22);           // mono
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}
