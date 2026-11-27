import { useLayoutEffect, useRef } from "react";
import { useSkillSwitchReview, markPrivateSkillReviewRendered, retryPrivateSkillReview } from "@/lib/skill-switch-review";
import { t } from "@/lib/i18n";
import { isSkillSwitchAction, reviewedSkillSha256, type SkillRequestCardData } from "../../shared/skill-request";

/** Render learned instructions as inert plain text. The approval hash binds
 * this exact preview to the staged file the server will promote. */
export function SkillRequestPreview({ request: original, messageId }: { request: SkillRequestCardData; messageId?: string }) {
  const review = useSkillSwitchReview(original, messageId);
  const shown = useRef<HTMLPreElement>(null);
  const request = review?.phase === "loaded" ? review.request : original;
  useLayoutEffect(() => {
    if (review?.phase === "loaded" && shown.current?.textContent === request.preview) markPrivateSkillReviewRendered(original, messageId, request.preview!);
  }, [review, original, messageId, request.preview]);
  const reviewedSha256 = reviewedSkillSha256(request);
  if (isSkillSwitchAction(original.action) && !original.preview && !reviewedSha256) {
    const message = review?.phase === "loading" ? "Loading the private skill review…"
      : review?.phase === "failed" && review.reason === "changed" ? "This skill request changed or is no longer open. Open Murage to ask the bot again if retry does not help."
      : review?.phase === "failed" && review.reason === "unavailable" ? "The private skill review could not be loaded. Try again."
      : "Open Murage on your computer to review this skill. You can deny it here.";
    return <div className="mt-3 text-[12px] text-ink-secondary" role="status">
      <p>{message}</p>
      {review?.phase === "failed" && <button type="button" className="mt-2 underline" onClick={() => retryPrivateSkillReview(original, messageId)}>Retry private review</button>}
    </div>;
  }
  if (!reviewedSha256) {
    return (
      <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
        This proposal was created by an older build and cannot be applied. Deny it, then ask the bot to
        {request.action === "update" ? " propose the update again." : " create the skill again."}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
      {review?.phase === "loaded" && request.gist && <p className="mb-2 whitespace-pre-wrap text-[12px] text-ink-secondary">{request.gist}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
        <span>
          {isSkillSwitchAction(request.action) ? t("approval.skillReviewChange") : <>Review the complete SKILL.md before {request.action === "update" ? "replacing the current version" : "enabling"}</>}
        </span>
        <span className="font-mono" title={`sha256 ${reviewedSha256}`}>
          sha256 {reviewedSha256.slice(0, 8)}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-ink-secondary">Source: {request.source || "Unknown"}</div>
      {request.findings && <ul aria-label="Skill check findings">{request.findings.map((finding,i)=><li key={i} className="mt-1 whitespace-pre-wrap text-[12px] text-ink-secondary">{finding.severity} · {finding.category} · {Math.round(finding.confidence*100)}% · {finding.file}{'\n'}{finding.message}{finding.evidence ? `: ${finding.evidence}` : ''}{'\n'}{finding.source} · {finding.rule}</li>)}</ul>}
      <pre
        ref={shown}
        tabIndex={0}
        aria-label={`Full SKILL.md for ${request.name}`}
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {request.preview}
      </pre>
    </div>
  );
}
