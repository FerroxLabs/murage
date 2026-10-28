// The door's twin of the phone-ask contract pieces it needs: the tag, the token pattern and the
// mint message builder. companion/src is its own build root and cannot import shared/ (TS6059
// under build:companion; plan B8), so these are kept identical on purpose.
// companion/test/phone-ask-shape.test.ts checks them byte for byte against
// apps/mobile/contract/phone-ask.json and shared/phone-ask-contract.ts.

export const PHONE_ASK_TAG = "murage-phone-ask/1";
export const PHONE_ASK_TOKEN = /^murage_pa_[A-Za-z0-9_-]{43}$/;

export interface PhoneAskMessageFields {
  origin: string;
  keyId: string;
  nonce: string;
  expiresAt: number;
}

/** UTF-8 of tag, origin, keyId, nonce and decimal expiresAt joined by LF, no trailing newline. */
export function phoneAskMessage(f: PhoneAskMessageFields): string {
  return [PHONE_ASK_TAG, f.origin, f.keyId, f.nonce, String(f.expiresAt)].join("\n");
}
