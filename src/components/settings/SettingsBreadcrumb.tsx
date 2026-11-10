// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The header of a Settings page: `Settings > Models and tools > Models & engines` or `Settings > Each bot > Nova`,
// then the one Copy link (SETTINGS-LOCKED-1019.md 2.2). Group names are plain text; only a bot segment is a button.
// Copied and failed are said through one polite live region.
import { Link2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { sw } from "@/lib/settings-words";
import { copyText } from "@/lib/copy-text";

export interface Crumb { label: string; onClick?: () => void }

export function SettingsBreadcrumb({ crumbs, link }: { crumbs: readonly Crumb[]; link: string | null }) {
  const [said, setSaid] = useState<"" | "copied" | "failed">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (!link) return;
    const ok = await copyText(link);
    setSaid(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setSaid(""), 2500);
  };
  const all: Crumb[] = [{ label: sw("settings.crumb.root") }, ...crumbs];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[15px] font-semibold text-ink">
      <nav aria-label={sw("settings.crumb.aria")} className="min-w-0">
        <ol className="flex min-w-0 flex-wrap items-center">
          {all.map((crumb, index) => {
            const last = index === all.length - 1;
            const body: ReactNode = crumb.onClick
              ? <button type="button" aria-current={last ? "page" : undefined} onClick={crumb.onClick} className="rounded-md px-0.5 hover:bg-control/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{crumb.label}</button>
              : <span aria-current={last ? "page" : undefined} className={last ? undefined : "font-normal text-ink-secondary"}>{crumb.label}</span>;
            return (
              <li key={`${index}-${crumb.label}`} className="flex min-w-0 items-center">
                {index > 0 && <span aria-hidden="true" className="px-1.5 font-normal text-ink-secondary">{">"}</span>}
                <span className={last ? "min-w-0 truncate" : "shrink-0"}>{body}</span>
              </li>
            );
          })}
        </ol>
      </nav>
      {link && (
        <button
          type="button"
          data-settings-copy-link
          onClick={copy}
          className="ml-1 inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
        >
          <Link2 size={14} aria-hidden="true" />
          <span>{sw("settings.crumb.copy")}</span>
        </button>
      )}
      <span role="status" aria-live="polite" data-settings-copy-status className="w-full text-[12px] font-normal text-ink-secondary empty:hidden">
        {said === "copied" ? sw("settings.crumb.copied") : said === "failed" ? <>{sw("settings.crumb.copyFailed")}<code className="select-all break-all">{link}</code></> : null}
      </span>
    </div>
  );
}
