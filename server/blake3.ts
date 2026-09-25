// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BLAKE3 (default hash mode, 32-byte output), after the reference
// implementation in the BLAKE3 specification. Node's crypto has no BLAKE3,
// and Fuigo/Grok name some per-folder directories with it
// (fuigo-config paths.rs `encode_cwd_dirname` long form, fuigo-memory
// storage.rs `compute_workspace_hash`). Deleting a conversation needs the
// same name to find those directories exactly. Speed is irrelevant here:
// inputs are folder paths.

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(s: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  s[a] = (s[a]! + s[b]! + x) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]! + y) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 7);
}

function compress(cv: Uint32Array, block: Uint32Array, counter: number, blockLen: number, flags: number): Uint32Array {
  const s = new Uint32Array(16);
  s.set(cv, 0);
  s.set(IV.subarray(0, 4), 8);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x100000000) >>> 0;
  s[14] = blockLen;
  s[15] = flags;
  let m = Uint32Array.from(block);
  for (let round = 0; round < 7; round++) {
    g(s, 0, 4, 8, 12, m[0]!, m[1]!);
    g(s, 1, 5, 9, 13, m[2]!, m[3]!);
    g(s, 2, 6, 10, 14, m[4]!, m[5]!);
    g(s, 3, 7, 11, 15, m[6]!, m[7]!);
    g(s, 0, 5, 10, 15, m[8]!, m[9]!);
    g(s, 1, 6, 11, 12, m[10]!, m[11]!);
    g(s, 2, 7, 8, 13, m[12]!, m[13]!);
    g(s, 3, 4, 9, 14, m[14]!, m[15]!);
    if (round < 6) m = Uint32Array.from(PERMUTATION, (index) => m[index]!);
  }
  for (let i = 0; i < 8; i++) {
    s[i] = (s[i]! ^ s[i + 8]!) >>> 0;
    s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0;
  }
  return s;
}

function words(bytes: Uint8Array): Uint32Array {
  const padded = new Uint8Array(BLOCK_LEN);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  return Uint32Array.from({ length: 16 }, (_, i) => view.getUint32(i * 4, true));
}

interface Output { cv: Uint32Array; block: Uint32Array; counter: number; blockLen: number; flags: number }

/** The last block of one chunk, uncompressed, so the caller can set ROOT. */
function chunkOutput(chunk: Uint8Array, counter: number): Output {
  let cv = IV;
  const blocks = Math.max(1, Math.ceil(chunk.length / BLOCK_LEN));
  for (let i = 0; i < blocks - 1; i++) {
    cv = compress(cv, words(chunk.subarray(i * BLOCK_LEN, (i + 1) * BLOCK_LEN)), counter, BLOCK_LEN, i === 0 ? CHUNK_START : 0).subarray(0, 8);
  }
  const last = chunk.subarray((blocks - 1) * BLOCK_LEN);
  return { cv, block: words(last), counter, blockLen: last.length, flags: (blocks === 1 ? CHUNK_START : 0) | CHUNK_END };
}

const chainingValue = (output: Output) => compress(output.cv, output.block, output.counter, output.blockLen, output.flags).subarray(0, 8);
const parentOutput = (left: Uint32Array, right: Uint32Array): Output => {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return { cv: IV, block, counter: 0, blockLen: BLOCK_LEN, flags: PARENT };
};

/** BLAKE3 hash of `input`, 32 bytes, as lower-case hex. */
export function blake3Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_LEN));
  // The spec's chaining-value stack: merge completed subtrees as the chunk
  // count's trailing zero bits say, keeping the last chunk for the root.
  const stack: Uint32Array[] = [];
  let output = chunkOutput(bytes.subarray(0, CHUNK_LEN), 0);
  for (let index = 1; index < chunks; index++) {
    let cv = chainingValue(output);
    let total = index;
    while ((total & 1) === 0) {
      cv = chainingValue(parentOutput(stack.pop()!, cv));
      total >>= 1;
    }
    stack.push(cv);
    output = chunkOutput(bytes.subarray(index * CHUNK_LEN, (index + 1) * CHUNK_LEN), index);
  }
  while (stack.length) output = parentOutput(stack.pop()!, chainingValue(output));
  const root = compress(output.cv, output.block, output.counter, output.blockLen, output.flags | ROOT);
  const out = new Uint8Array(OUT_LEN);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, root[i]!, true);
  return Buffer.from(out).toString("hex");
}
