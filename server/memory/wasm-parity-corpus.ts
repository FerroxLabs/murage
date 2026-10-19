// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A fixed, varied set of memory-like chunks for comparing the native and WebAssembly executors of the local model:
// short notes and long records (several model windows), eight languages and scripts, code, numbers, URLs and
// symbols. Deterministic, so every run compares the same inputs.

const NOTES = [
  "The database backup runs every night at 02:00 UTC.",
  "Sean prefers short status reports with one table.",
  "Deploys to staging need a green CI run first.",
  "The invoice for October was paid on the 3rd.",
  "Remember to rotate the API keys every 90 days.",
  "Die Datensicherung läuft jede Nacht um zwei Uhr.",
  "Bitte die Rechnung bis Freitag an die Buchhaltung schicken.",
  "La copia de seguridad se ejecuta cada noche.",
  "El cliente pidió una demo el martes por la mañana.",
  "La sauvegarde de la base de données a lieu chaque nuit.",
  "Le rendez-vous avec l’équipe produit est reporté à jeudi.",
  "O backup do banco de dados roda toda noite.",
  "データベースのバックアップは毎晩実行されます。",
  "来週の会議は木曜日の午後三時からです。",
  "数据库每晚备份一次。",
  "客户希望下周二进行产品演示。",
  "ฐานข้อมูลสำรองทุกคืนเวลาตีสอง",
  "ลูกค้าขอเลื่อนการประชุมเป็นวันพฤหัสบดี",
  "डेटाबेस का बैकअप हर रात चलता है।",
  "ग्राहक ने मंगलवार को डेमो माँगा है।",
];
const CODE = [
  "const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
  "SELECT id, created_at FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50;",
  "git rebase --onto main feature~3 feature && git push --force-with-lease",
  "def embed(texts): return model.encode(texts, normalize_embeddings=True)",
  "curl -4 -H 'Authorization: Bearer $TOKEN' https://api.example.com/v2/instances",
  "error[E0502]: cannot borrow `self.items` as mutable because it is also borrowed as immutable",
];
const SYMBOLS = [
  "Order #48213: 3 × 12.50 EUR = 37.50 EUR (paid ✅)",
  "Temperature range 18–24 °C, humidity 40 % ± 5 %",
  "Q3 revenue: $1,284,900 (+12.4% YoY); churn 2.1%",
  "Meeting link: https://meet.example.org/abc-defg-hij?pwd=xyz",
  "🎉 Launch day! 🚀 Ship it, then sleep 😴",
  "Phone +1 (512) 555-0147, ext. 22; fax none",
];
const SUBJECTS = ["The release checklist", "Our support inbox", "The mobile app", "The billing service", "Weekly planning", "The onboarding flow", "The search index", "Customer feedback"];
const PREDICATES = ["needs a review before Friday", "was migrated to the new server last week", "keeps timing out under heavy load", "should send a summary every Monday", "depends on the shared configuration file", "has three open questions from legal", "is owned by the platform team", "was rolled back after the incident"];
const DETAILS = ["because the previous version lost data on restart", "so the team can plan the next sprint", "after the customer asked for an audit trail", "while the vendor fixes their rate limits", "which means nightly jobs must wait", "and nobody has tested it on Windows yet"];

/** A long record: several sentences, so the model sees it as many 120-byte windows that are then averaged. */
function paragraph(seed: number, sentences: number) {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    // Mixed per seed: with a plain linear step only a few hundred sentences exist, and the generator below took minutes
    // to find a 100th distinct chunk.
    const n = (Math.imul(seed + 1, 2654435761) >>> 0) + i * 13;
    parts.push(`${SUBJECTS[n % SUBJECTS.length]} ${PREDICATES[(n >>> 3) % PREDICATES.length]}, ${DETAILS[(n >>> 7) % DETAILS.length]}.`);
  }
  return parts.join(" ");
}

/** At least 240 chunks: every fixed sample, then generated sentences and paragraphs of growing length (up to ~2 KB,
 * the capture chunk limit), with mixed-language and code-carrying records in between. */
export function wasmParityCorpus(count = 240): string[] {
  const clip = (text: string) => Buffer.byteLength(text) > 2048 ? Buffer.from(text).subarray(0, 2048).toString("utf8").replace(/�+$/, "") : text;
  const out = new Set([...NOTES, ...CODE, ...SYMBOLS]);
  for (let i = 0; out.size < count; i++) {
    const a = NOTES[(i * 7) % NOTES.length], b = NOTES[(i * 11 + 3) % NOTES.length];
    switch (i % 6) {
      case 0: out.add(clip(paragraph(i, 1))); break;
      case 1: out.add(clip(paragraph(i, 3))); break;
      case 2: out.add(clip(paragraph(i, 1 + (i % 18)))); break;
      case 3: out.add(clip(a === b ? a : `${a} ${b}`)); break;
      case 4: out.add(clip(`${paragraph(i, 2)} ${CODE[i % CODE.length]}`)); break;
      default: out.add(clip(`${SYMBOLS[i % SYMBOLS.length]} — ${paragraph(i, 4)} ${NOTES[(i * 5) % NOTES.length]}`)); break;
    }
  }
  return [...out];
}

/** Twenty chunks spread over the full corpus (short notes in every script, code, symbols, long records), for the fast
 * parity test against stored native vectors (testdata/wasm-native-reference.json). */
export function wasmParitySample(): string[] {
  return wasmParityCorpus(200).filter((_, i) => i % 10 === 0);
}

export function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}
