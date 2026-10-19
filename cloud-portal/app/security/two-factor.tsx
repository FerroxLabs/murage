"use client";
import { useEffect, useState } from "react";

const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (v: string) => {
  const s = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function post(path: string, body: unknown) {
  const res = await fetch(`/api/2fa/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "failed");
  return data as Record<string, any>;
}

export function TwoFactor(props: { enrolled: boolean; verified: boolean; factors: { id: string; label: string }[]; next: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Buttons stay off until the page is live, so a fast click never submits to nothing.
  useEffect(() => setReady(true), []);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); } catch (e) {
      const code = (e as Error).message;
      setErr(code === "step_up_required" ? "Confirm with a device you already added first."
        : code === "NotAllowedError" ? "The device did not confirm. Try again."
        : "That did not work. Try again.");
    } finally { setBusy(false); }
  }

  const add = () => run(async () => {
    const o = await post("register/options", {});
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: new TextEncoder().encode(o.message),
        rp: o.rp, user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        excludeCredentials: (o.excludeCredentials as string[]).map((id) => ({ type: "public-key", id: fromB64u(id) })),
        timeout: 120000,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("NotAllowedError");
    const r = cred.response as AuthenticatorAttestationResponse;
    const spki = r.getPublicKey();
    if (!spki) throw new Error("unsupported_key");
    await post("register", {
      challengeId: o.challengeId, credentialId: cred.id, publicKey: b64u(spki), clientDataJSON: b64u(r.clientDataJSON),
      label: "Security key",
    });
    window.location.assign(props.next);
  });

  const confirm = () => run(async () => {
    const o = await post("assert/options", {});
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: new TextEncoder().encode(o.message), rpId: o.rpId, userVerification: "required", timeout: 120000,
        allowCredentials: (o.allowCredentials as string[]).map((id) => ({ type: "public-key", id: fromB64u(id) })),
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("NotAllowedError");
    const r = cred.response as AuthenticatorAssertionResponse;
    await post("assert", {
      challengeId: o.challengeId,
      assertion: { credentialId: cred.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) },
    });
    window.location.assign(props.next);
  });

  return (
    <div>
      {props.enrolled && props.verified && <p className="ok" data-testid="2fa-status">Confirmed. You can buy a plan.</p>}
      {props.enrolled && !props.verified && <p data-testid="2fa-status">You have a second step set up. Confirm it now.</p>}
      {!props.enrolled && <p data-testid="2fa-status">No second step yet.</p>}
      {props.factors.length > 0 && <ul>{props.factors.map((f) => <li key={f.id}>{f.label}</li>)}</ul>}
      {err && <p role="alert" className="error">{err}</p>}
      {msg && <p>{msg}</p>}
      <div className="row">
        {props.enrolled && !props.verified && <button type="button" disabled={busy || !ready} onClick={confirm}>Confirm with my device</button>}
        {(!props.enrolled || props.verified) && <button type="button" disabled={busy || !ready} onClick={add}>{props.enrolled ? "Add another device" : "Add a second step"}</button>}
      </div>
    </div>
  );
}
