// Source-only Windows transport contract. Not wired into platform admission.
export const limits = Object.freeze({ frame: 32768, control: 131072, key: 136, bytes: 20 * 1024 ** 3 });
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => { throw new Error("INVALID_BACKUP_TRANSPORT"); };
const integer = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
export function safePath(value) {
  if (typeof value !== "string" || value.length > 8192 || !/^[A-Za-z]:\\/.test(value)) return false;
  const parts = value.slice(3).split("\\");
  return parts.length <= 127 && parts.every(part => part.length > 0 && part.length <= 255 &&
    !/[\x00-\x1f\x7f\\/:*?"<>|]/.test(part) && !/[ .]$/.test(part) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(part));
}
export function encodeRequest(request, identity = "") {
  const { nonce, operation, parentPid, parentDirectory, ciphertext = "", maxBytes, timeoutMs = 900000, closeTimeoutMs = 5000 } = request;
  if (!noncePattern.test(nonce) || !["private-stage", "decrypt"].includes(operation) || !integer(parentPid, 0xffffffff) ||
      !safePath(parentDirectory) || !integer(maxBytes, limits.bytes) || !integer(timeoutMs, 1800000) || !integer(closeTimeoutMs, 30000)) fail();
  if (operation === "decrypt" ? !safePath(ciphertext) || !/^AGE-SECRET-KEY-1[A-Z0-9]{40,120}\n$/.test(identity) : ciphertext !== "" || identity !== "") fail();
  const key = Buffer.from(identity, "ascii");
  if (key.length > limits.key) fail();
  const metadata = Buffer.from(["1", nonce, operation, parentPid, parentDirectory, ciphertext, key.length, maxBytes, timeoutMs, closeTimeoutMs].join("\n"), "utf8");
  if (metadata.length > limits.frame) fail();
  // Key remains a distinct exact-length write; it never enters a control parser.
  return { header: Buffer.concat([Buffer.from(`${metadata.length}\n`), metadata]), key };
}
export function createControlProtocol(nonce, operation, maxBytes = limits.bytes) {
  if (!noncePattern.test(nonce) || !["private-stage", "decrypt"].includes(operation) || !integer(maxBytes, limits.bytes)) fail();
  let state = "prepare", pending = Buffer.alloc(0), incoming = 0, outgoing = 0;
  let received = 0, expected = null;
  const guarded = fn => (...args) => {
    if (state === "failed") fail();
    try { return fn(...args); } catch (error) { state = "failed"; throw error; }
  };
  const command = event => {
    if (event === "CANCEL" && !["released", "cancelled", "closed"].includes(state)) state = "cancelled";
    else if (event === "START" && state === "prepared" && operation === "decrypt") state = "running";
    else if (event === "RELEASE" && state === (operation === "decrypt" ? "child-closed" : "prepared") &&
        (operation !== "decrypt" || received === expected)) state = "releasing";
    else fail();
    const line = `1\t${nonce}\t${event}\n`;
    outgoing += Buffer.byteLength(line); if (outgoing > limits.control) fail();
    return line;
  };
  return {
    command: guarded(command),
    get state() { return state; },
    get plaintextComplete() { return state === "child-closed" && received === expected; },
    plaintext: guarded(bytes => {
      if (operation !== "decrypt" || !["running", "child-closed"].includes(state) || !integer(bytes, maxBytes) || received + bytes > maxBytes) fail();
      received += bytes;
      if (expected !== null && received > expected) fail();
    }),
    receive: guarded(chunk => {
      if (!Buffer.isBuffer(chunk) || ["released", "cancelled", "closed"].includes(state)) fail();
      incoming += chunk.length; if (incoming > limits.control) fail();
      pending = Buffer.concat([pending, chunk]); const events = [];
      for (;;) {
        const end = pending.indexOf(10);
        if ((end < 0 ? pending.length : end) > limits.frame) fail();
        if (end < 0) break;
        const bytes = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (bytes.some(byte => byte !== 9 && (byte < 32 || byte > 126))) fail();
        const [version, actualNonce, event, ...fields] = bytes.toString("ascii").split("\t");
        if (version !== "1" || actualNonce !== nonce) fail();
        if (event === "PREPARED" && state === "prepare" && fields.length === 5 &&
            /^\d{1,20}$/.test(fields[0]) && /^[a-f0-9]{32}$/.test(fields[1]) && /^\d{1,11}$/.test(fields[2]) &&
            Number(fields[2]) <= limits.bytes && /^\d{1,20}$/.test(fields[3]) && /^[a-f0-9]{32}$/.test(fields[4])) state = "prepared";
        else if (event === "CHILD_CLOSED" && state === "running" && fields.length === 2 && fields[0] === "0" &&
            /^(?:0|[1-9][0-9]{0,10})$/.test(fields[1]) && Number(fields[1]) <= maxBytes && received <= Number(fields[1])) {
          expected = Number(fields[1]); state = "child-closed";
        }
        else if (event === "RELEASED" && state === "releasing" && fields.length === 1 &&
            (operation === "decrypt" ? /^[a-f0-9]{64}$/.test(fields[0]) : fields[0] === "-")) state = "released";
        else fail();
        events.push({ event, fields });
        if (state === "released" && pending.length) fail();
      }
      return events;
    }),
    close: guarded(code => {
      if (state !== "released" || pending.length || code !== 0) fail();
      state = "closed"; return { guardsClosed: true, helperClosed: true };
    }),
  };
}
