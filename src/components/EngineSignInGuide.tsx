// The customer's sign-in screen: plain words, the code in large type, one button. No terminal, no Cloud imports, so the desktop
// can use it as it is. The raw output of the vendor CLI is not shown here; the caller offers it under "Details".
import type { ReactNode } from "react";

import { displayAddress } from "@/lib/engine-login-view";
import { useCopyFeedback } from "@/lib/copy-text";

export interface EngineSignInGuideProps {
  /** "Claude", "Grok"... */
  label: string;
  /** The bot the sign-in is for; absent for the home's own. */
  botName?: string;
  /** The vendor page and the one-time code, once the CLI has printed them. */
  url?: string;
  code?: string;
  /** Whether the page was opened for them: true opened, false could not, null not tried yet. */
  opened: boolean | null;
  /** Claude's paste-back box, or anything else the engine needs; shown once the page is known. */
  children?: ReactNode;
  onOpen(): void;
  /** The session has ended; the line says how. */
  endedMessage?: string;
}

const big = "rounded-lg bg-accent px-4 py-3 text-[15px] font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const small = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset";

function CopyButton({ text, label }: { text: string; label: string }) {
  const { mark, copy } = useCopyFeedback();
  return <button type="button" className={small} aria-label={label} onClick={() => void copy(text)}>{mark === "copied" ? "Copied" : mark === "failed" ? "Select it and copy" : "Copy"}</button>;
}

export function EngineSignInGuide({ label, botName, url, code, opened, children, onOpen, endedMessage }: EngineSignInGuideProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3 text-[13px] text-ink" data-testid="signin-guide">
      <h3 className="text-[16px] font-semibold">{botName ? `Hey ${botName}, sign in to ${label}` : `Sign in to ${label}`}</h3>
      {endedMessage ? <p role="status">{endedMessage}</p> : !url ? <p role="status" className="text-ink-secondary">Getting your {label} sign-in ready...</p> : opened === false ? (
        <>
          <p>We could not open it for you. Go to <strong className="break-all">{displayAddress(url)}</strong>{code ? " and enter this code." : "."}</p>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className={big} onClick={onOpen}>Open {label} sign-in</button><CopyButton text={url} label={`Copy the ${label} sign-in address`} /></div>
        </>
      ) : opened === null ? (
        <div><button type="button" className={big} onClick={onOpen}>Open {label} sign-in</button></div>
      ) : (
        <>
          <p>{code ? "A new tab opened. Enter this code there." : "A new tab opened. Sign in there."}</p>
          <div><button type="button" className={small} onClick={onOpen}>Open it again</button></div>
        </>
      )}
      {url && code && !endedMessage ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="text-ink-secondary">{opened === false ? "Code" : "Enter this code"}</span>
          <code aria-label="Sign-in code" className="break-all text-[28px] font-semibold tracking-widest">{code}</code>
          <CopyButton text={code} label={`Copy the ${label} code`} />
        </div>
      ) : null}
      {children}
      {url && !endedMessage ? <p className="text-ink-secondary">Waiting for you to finish in the other tab. This closes by itself when you are done.</p> : null}
    </div>
  );
}
