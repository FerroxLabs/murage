// SIGNED OUT, SAID ONCE, WITH THE WAY BACK.
//
// Reached only after the door itself answered GET /session with 401
// (src/lib/session-check.ts), never on an API 401 alone. Before this, a phone
// whose session had been revoked or had expired kept its last screen, kept
// reconnecting every ten seconds, and never said why nothing arrived.
//
// Inside the phone app the store has already asked native to re-pair; this
// card is what shows underneath while it does, and the fallback if it cannot.
import { LogIn } from "lucide-react";

import { callNative, nativeHas } from "@/lib/native-shell";
import { PAIR_AGAIN_PATH } from "@/lib/session-check";

export async function pairAgain(): Promise<void> {
  if (nativeHas("rePair")) {
    try {
      await callNative("rePair");
      return;
    } catch {
      /* fall through to the door's own code page */
    }
  }
  globalThis.location.assign(PAIR_AGAIN_PATH);
}

export function SignedOutCard() {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="signed-out-title"
      aria-describedby="signed-out-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-app/95 p-4"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
    >
      <div className="w-full max-w-[420px] rounded-2xl border border-hairline/60 bg-panel p-6">
        <h2 id="signed-out-title" className="text-[16px] font-medium text-ink">
          Signed out. Pair again
        </h2>
        <p id="signed-out-body" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          This device is no longer signed in to your Murage. Your conversations are still on your computer.
          Pair again with the code Murage shows on your computer.
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => void pairAgain()}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <LogIn size={16} aria-hidden="true" />
          Pair again
        </button>
      </div>
    </div>
  );
}
