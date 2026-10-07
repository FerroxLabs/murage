// SEC-006 P7: a test double for the phone app's native `approveWithDevice`.
//
// It stands where the Face ID / biometric prompt and the Secure Enclave or
// AndroidKeyStore sit on a device: it validates the challenge fields exactly as
// native does (apps/mobile/contract/approval-proof.json), builds the signed
// bytes itself from those fields (never bytes the page made), and signs them
// with a WebCrypto P-256 key. WebCrypto returns raw r||s; the contract wants
// ASN.1 DER, so it is wrapped here and S is never normalised.
//
// Plain script, no modules: Playwright injects it at document start, and the
// vitest guard loads it in Node. `__makeMurageDouble(config)` builds one;
// when `globalThis.__E2E_DOUBLE` is set it also installs `murageNative`.
// config: { privateJwk, mode: "sign" | "cancel" | "no_lock" | "no_key", calls?: [] }
(function (root) {
  var TAG = "murage-approval-proof/1";

  function b64u(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return root.btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function ascii(value, min, max, hexOnly) {
    if (typeof value !== "string" || value.length < min || value.length > max) return false;
    return hexOnly ? /^[0-9a-f]+$/.test(value) : /^[A-Za-z0-9_-]+$/.test(value);
  }
  // C0, DEL, C1, U+2028 and U+2029.
  function framing(text) { return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text); }
  function hidden(text) { return framing(text) || /\p{Cf}/u.test(text); }
  function integer(value) { return typeof value === "number" && Number.isInteger(value); }

  /** The contract's refusals. Returns the validated fields or null. */
  function parse(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    if (args.v !== 1) return null;
    if (!ascii(args.threadId, 1, 128, false)) return null;
    if (typeof args.requestId !== "string" || args.requestId.length < 1 || args.requestId.length > 256 || framing(args.requestId)) return null;
    if (args.decision !== "allow" && args.decision !== "allow-task") return null;
    if (!ascii(args.digest, 64, 64, true)) return null;
    if (!ascii(args.nonce, 43, 43, false)) return null;
    if (!integer(args.expiresAt) || args.expiresAt <= 0) return null;
    if (typeof args.reason !== "string" || args.reason.length < 1 || args.reason.length > 160 || hidden(args.reason)) return null;
    return args;
  }

  function messageText(a) {
    return [TAG, a.threadId, a.requestId, a.decision, a.digest, a.nonce, String(a.expiresAt)].join("\n");
  }

  // r||s (64 bytes) to ASN.1 DER, S kept as signed.
  function derInteger(bytes) {
    var i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    var body = Array.prototype.slice.call(bytes, i);
    if (body[0] & 0x80) body.unshift(0);
    return [0x02, body.length].concat(body);
  }
  function toDer(raw) {
    var r = derInteger(raw.slice(0, 32));
    var s = derInteger(raw.slice(32, 64));
    return new Uint8Array([0x30, r.length + s.length].concat(r, s));
  }

  function makeDouble(config) {
    var keyPromise = null;
    function key() {
      if (!keyPromise) keyPromise = root.crypto.subtle.importKey("jwk", config.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return keyPromise;
    }
    return {
      hello: function () {
        return { version: 1, methods: ["ready", "approveWithDevice"] };
      },
      message: function (args) {
        return messageText(args);
      },
      approveWithDevice: function (args) {
        var fields = parse(args);
        if (!fields) return Promise.reject(new Error("bad_args"));
        // What the owner would be reading under Face ID: kept for the run's assertions.
        if (config.calls) config.calls.push({ reason: fields.reason, decision: fields.decision, requestId: fields.requestId });
        if (config.mode === "cancel") return Promise.reject(new Error("cancelled"));
        if (config.mode === "no_lock") return Promise.reject(new Error("no_lock"));
        if (config.mode === "no_key") return Promise.reject(new Error("no_key"));
        return key().then(function (privateKey) {
          return root.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(messageText(fields)));
        }).then(function (raw) {
          return { signature: b64u(toDer(new Uint8Array(raw))) };
        });
      },
    };
  }

  root.__makeMurageDouble = makeDouble;
  if (root.__E2E_DOUBLE) root.murageNative = makeDouble(root.__E2E_DOUBLE);
})(globalThis);
