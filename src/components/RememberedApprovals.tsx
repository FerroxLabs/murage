// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings, Permissions: every "Always allow" this bot remembers, with a way
// to take each one back. Exact-command grants show the command, the folder
// and the engine they are limited to. Desktop only, like granting one.
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { describeGrant, rememberedGrants } from "@/lib/remembered-grants";

export function RememberedApprovals({ bot, desktop }: { bot: Pick<Bot, "id" | "alwaysAllow" | "tasks">; desktop: boolean | undefined }) {
  const { state } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const held = rememberedGrants(bot);
  const keys = held.filter((key) => !removed.includes(key));
  // once the server's update lands, forget what was hidden, so a grant given
  // again later shows up again
  const heldKey = JSON.stringify(held);
  useEffect(() => { setRemoved((current) => current.filter((key) => held.includes(key))); }, [heldKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (desktop !== true) return null;

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/always-allow/remove`, { method: "POST", body: JSON.stringify({ key }) });
      // the bot update arrives over the event stream; hide it now meanwhile
      setRemoved((current) => [...current, key]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove it. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Always allowed" className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Always allowed</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {keys.length
          ? "This bot does these without asking. It still asks before anything that looks destructive, reads your keys, deletes outside its folder, pays or messages someone new."
          : "Nothing yet. When you choose Always allow on an approval, it shows up here."}
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      {keys.length > 0 && (
        <ul className="mt-3 space-y-2">
          {keys.map((key) => {
            const grant = describeGrant(key, state.instances);
            return (
              <li key={key} data-grant={grant.kind} className="flex items-start justify-between gap-3 rounded-lg bg-inset px-3 py-2">
                <div className="min-w-0 flex-1">
                  {grant.kind === "exact" ? (
                    <>
                      <div className="text-[11.5px] text-ink-secondary">This exact command</div>
                      <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-ink">{grant.command}</pre>
                      <div className="mt-1 break-words text-[12px] text-ink-secondary">
                        In <span className="font-mono">{grant.folder}</span> · {grant.engine}
                      </div>
                    </>
                  ) : (
                    <div className="break-words text-[13px] text-ink">{grant.text}</div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void remove(key)}
                  aria-label={grant.kind === "exact" ? `Remove always allow for ${grant.command}` : `Remove always allow for ${grant.text}`}
                  className="min-h-8 shrink-0 rounded-lg px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
                >
                  {busy === key ? "Removing…" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
