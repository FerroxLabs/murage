import type { MemoryWork, MemoryWorkResult } from "./worker-protocol.ts";

/** Byte offsets always describe the exact retained source, including whitespace. */
export function chunksFor(text: string, offset = 0, maximum = 2048) {
  const chunks: Array<{text:string;startByte:number;endByte:number}> = [];
  let part = "", bytes = 0, at = offset;
  for (const char of text) {
    const length = Buffer.byteLength(char);
    if (bytes + length > maximum && part) {
      chunks.push({text:part,startByte:at,endByte:at+bytes}); at+=bytes;part="";bytes=0;
    }
    part+=char;bytes+=length;
  }
  if (part) chunks.push({text:part,startByte:at,endByte:at+bytes});
  return chunks;
}

export function captureWork(work: MemoryWork): MemoryWorkResult {
  if (work.stage !== "capture") return {id:work.id,leaseGeneration:work.leaseGeneration,status:"deferred",nextCursor:work.cursor,chunks:[],reason:"extractor-unavailable"};
  const next = work.cursor+Buffer.byteLength(work.text);
  if (next>work.totalBytes || next===work.cursor && work.cursor<work.totalBytes) throw new Error("INVALID_SOURCE_COVERAGE");
  return {id:work.id,leaseGeneration:work.leaseGeneration,status:next===work.totalBytes?"complete":"partial",nextCursor:next,
    chunks:work.kind === "turn" ? [] : chunksFor(work.text,work.cursor)};
}
