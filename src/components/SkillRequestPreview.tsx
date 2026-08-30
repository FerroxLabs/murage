import type { SkillRequestCardData } from "../../shared/skill-request";

/** Render learned instructions as inert plain text. The approval hash binds
 * this exact preview to the staged file the server will promote. */
export function SkillRequestPreview({ request }: { request: SkillRequestCardData }) {
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>Review the complete SKILL.md before enabling</span>
        <span className="font-mono" title={`sha256 ${request.sha256}`}>
          sha256 {request.sha256.slice(0, 8)}
        </span>
      </div>
      <pre
        tabIndex={0}
        aria-label={`Full SKILL.md for ${request.name}`}
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {request.preview}
      </pre>
    </div>
  );
}
