// A tiny, fully local embedding model for tests: a real ONNX graph (one Gather over a hand-set word table), a real tokenizer.json and the
// same file layout the pinned model uses, so MemoryEmbeddings, the worker and the controller run their real verification and loading
// code with no download. It stands in for the multilingual MiniLM only as data; no production path reads it.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelManifest } from "./embeddings.ts";

const DIM = 8;
// Words of one idea share an axis, so a query and a record that never share a word still land near each other.
const CONCEPTS: Record<string, number> = { backups: 0, backup: 0, save: 0, copies: 0, recovery: 0, frequently: 1, every: 1, night: 1, database: 2 };
const FILLER = ["how", "do", "we", "are", "made", "?", "."];
const words = ["[UNK]", "[PAD]", ...Object.keys(CONCEPTS), ...FILLER];

function table(): Float32Array {
  const weights = new Float32Array(words.length * DIM);
  words.forEach((word, row) => {
    const axis = CONCEPTS[word];
    weights[row * DIM + (axis === undefined ? 3 + (row % 5) : axis)] = axis === undefined ? 0.3 : 1;
    weights[row * DIM + 3 + ((row * 3) % 5)] += 0.1;
  });
  return weights;
}

const varint = (n: number): number[] => { const out: number[] = []; let v = n; while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); return out; };
const field = (no: number, wire: number, body: number[]): number[] => [...varint(no * 8 + wire), ...body];
const bytes = (no: number, data: Uint8Array | number[]): number[] => field(no, 2, [...varint(data.length), ...data]);
const text = (no: number, value: string): number[] => bytes(no, Buffer.from(value));
const int = (no: number, value: number): number[] => field(no, 0, varint(value));
function valueInfo(name: string, elemType: number, dims: Array<string | number>): number[] {
  const shape = dims.flatMap(d => bytes(1, typeof d === "number" ? int(1, d) : text(2, d)));
  return [...text(1, name), ...bytes(2, bytes(1, [...int(1, elemType), ...bytes(2, shape)]))];
}
function onnxModel(): Buffer {
  const weights = Buffer.from(table().buffer);
  const initializer = [...int(1, words.length), ...int(1, DIM), ...int(2, 1), ...text(8, "word_table"), ...bytes(9, weights)];
  const node = [...text(1, "word_table"), ...text(1, "input_ids"), ...text(2, "last_hidden_state"), ...text(3, "lookup"), ...text(4, "Gather"), ...bytes(5, [...text(1, "axis"), ...int(3, 0), ...int(20, 2)])];
  const graph = [...bytes(1, node), ...text(2, "tiny-embedder"), ...bytes(5, initializer),
    ...bytes(11, valueInfo("input_ids", 7, ["batch", "sequence"])), ...bytes(11, valueInfo("attention_mask", 7, ["batch", "sequence"])),
    ...bytes(12, valueInfo("last_hidden_state", 1, ["batch", "sequence", DIM]))];
  return Buffer.from([...int(1, 8), ...bytes(8, [...text(1, ""), ...int(2, 17)]), ...bytes(7, graph)]);
}

/** Writes the model files into `directory` and returns the manifest that pins exactly them. */
export function writeTinyModel(directory: string): ModelManifest {
  mkdirSync(join(directory, "onnx"), { recursive: true });
  const vocab = Object.fromEntries(words.map((word, id) => [word, id]));
  const special = (content: string, id: number) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true });
  const files: Array<[string, Buffer | string]> = [
    ["config.json", JSON.stringify({ model_type: "bert", hidden_size: DIM, num_hidden_layers: 1, num_attention_heads: 1, vocab_size: words.length })],
    ["tokenizer_config.json", JSON.stringify({ tokenizer_class: "BertTokenizer", do_lower_case: true, unk_token: "[UNK]", pad_token: "[PAD]", model_max_length: 128 })],
    ["tokenizer.json", JSON.stringify({ version: "1.0", truncation: null, padding: null, added_tokens: [special("[UNK]", 0), special("[PAD]", 1)], normalizer: { type: "Lowercase" }, pre_tokenizer: { type: "BertPreTokenizer" }, post_processor: null, decoder: null, model: { type: "WordLevel", vocab, unk_token: "[UNK]" } })],
    ["onnx/model_quantized.onnx", onnxModel()],
  ];
  const manifestFiles = files.map(([path, content]) => {
    const data = Buffer.from(content);
    writeFileSync(join(directory, path), data);
    return { path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  });
  return { model: "test/tiny-local-embedder", revision: "fixture", dimensions: DIM, files: manifestFiles };
}
