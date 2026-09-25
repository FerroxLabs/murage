import { AlertTriangle } from "lucide-react";
import type { TailnetHttpsHelp } from "../lib/tailnet-https";

export function TailnetHttpsHelpCard({ help, className = "" }: { help: TailnetHttpsHelp; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border border-hairline/40 px-3 py-2.5 text-left ${className}`}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
      <div className="min-w-0 text-[11.5px] leading-relaxed text-ink-secondary">
        <div className="text-[12.5px] font-medium text-ink">{help.title}</div>
        <ol className="mt-1 list-decimal pl-4">
          {help.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <a href={help.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-accent hover:opacity-80">
          {help.linkLabel}
        </a>
        <span className="ml-1 font-mono text-[11px] text-ink-secondary">{help.url}</span>
        <p className="mt-1.5">{help.after}</p>
      </div>
    </div>
  );
}
