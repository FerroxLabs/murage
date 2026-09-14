// Deterministic, short two-note notification resource. Generates bytes only.
import { writeFileSync } from "node:fs";
const rate = 22050, duration = 0.48, samples = Math.round(rate * duration);
const wave = Buffer.alloc(44 + samples * 2);
wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write("data", 36); wave.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const t = i / rate, onset = t < 0.22 ? 0 : 0.25, phase = t - onset;
  const frequency = onset === 0 ? 659.25 : 880;
  const envelope = phase < 0 || phase > 0.2 ? 0 : Math.min(1, phase / 0.012) * Math.pow(1 - phase / 0.2, 2);
  wave.writeInt16LE(Math.round(0.18 * 32767 * envelope * Math.sin(2 * Math.PI * frequency * phase)), 44 + i * 2);
}
writeFileSync(new URL("../electron/resources/murage-approval.wav", import.meta.url), wave);
