import { useState } from "react";
import { MausAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";

/** First-run welcome: collect an email before entering the app. */
export function EmailGate({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const submit = () => {
    if (!valid) return;
    identifyEmail(email.trim().toLowerCase());
    setEmailGateDone("submitted");
    onDone();
  };
  const skip = () => {
    track("email_skipped");
    setEmailGateDone("skipped");
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app">
      <div className="flex w-[420px] flex-col items-center rounded-2xl border border-hairline/40 bg-panel p-8">
        <MausAvatar color="green" expression="friendly" size={72} />
        <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to OpenMausBot</h1>
        <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
          Bots that do real work on their own computer. Drop your email and
          we&rsquo;ll let you know when big things ship.
        </p>
        <input
          autoFocus
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="you@example.com"
          className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={!valid}
          className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
        >
          Continue
        </button>
        <button onClick={skip} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
          Maybe later
        </button>
      </div>
    </div>
  );
}
