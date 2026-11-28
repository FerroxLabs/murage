// Settings v10 A9-bots (roster): the Bots list with its bulk bar (level, Archive) and the Move all review. The body is
// presentational so the rows and the reviews can be checked without the store; BotsRosterLive.tsx is the container. Every bot is drawn, active and archived, in one list.
import { ConfirmClearsAppChoices } from "@/components/settings/ConfirmClearsAppChoices";
import { FULL_ACCESS_ASKS_UNLESS_ALLOWED, FULL_ACCESS_STOP_LINE, FULL_ACCESS_WARNING } from "@/components/FullAccessWarning";
import { LOCAL_COMPUTER_AUTO_WARNING, LOCAL_COMPUTER_FULL_ACCESS_WARNING } from "@/components/LocalComputerAutoWarning";
import { levelName } from "@/lib/fold-words";
import { moveAllReview, type BulkLevelReview, type MoveAllOutcome } from "@/lib/bots-bulk";
import type { Bot } from "@/state/store";
import { permissionModeOf, type PermissionMode } from "@/lib/permission-mode";
import type { ArchiveReviewBot } from "../../shared/settings-v10/archive-review";
import type { NoLimitsPlan } from "../../shared/settings-v10/no-limits-plan";

const LEVELS: PermissionMode[] = ["ask", "auto", "full"];

export interface BotsRosterBodyProps {
  bots: Array<Pick<Bot, "id" | "name" | "autoApprove" | "fullAccess" | "noLimits" | "hidden">>;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  target: PermissionMode;
  onTarget: (level: PermissionMode) => void;
  onApply: () => void;
  onArchive: () => void;
  onMoveAll: () => void;
  busy: boolean;
  /** Per-bot result lines from the last bulk save or archive. */
  results: Array<{ botId: string; text: string }>;
  levelReview: BulkLevelReview[] | null;
  onConfirmLevel: () => void;
  onCancelLevel: () => void;
  /** Bots the owner chose "Set to Auto" for in the review; every other bot that needs the this-computer answer stays at Ask. */
  setAuto: ReadonlySet<string>;
  onToggleSetAuto: (id: string) => void;
  archiveReview: ArchiveReviewBot[] | null;
  onConfirmArchive: () => void;
  onCancelArchive: () => void;
  moveAll: { plan: NoLimitsPlan; outcome: MoveAllOutcome | null } | null;
  onConfirmMoveAll: () => void;
  onCancelMoveAll: () => void;
}

export function BotsRosterBody(props: BotsRosterBodyProps) {
  const { bots, selected } = props;
  const active = bots.filter((bot) => !bot.hidden);
  const archived = bots.filter((bot) => bot.hidden);
  const row = (bot: BotsRosterBodyProps["bots"][number]) => (
    <li key={bot.id} data-bot-row={bot.id} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
      <input type="checkbox" aria-label={`Select ${bot.name}`} checked={selected.has(bot.id)} onChange={() => props.onToggle(bot.id)} />
      <span className="min-w-0 flex-1 truncate text-ink">{bot.name}</span>
      <span className="text-ink-secondary">{bot.hidden ? "Archived" : levelName(permissionModeOf(bot))}</span>
    </li>
  );
  return (
    <section aria-label="Your bots">
      <p className="text-[13px] text-ink-secondary">{`${active.length} bots. ${archived.length} archived.`}</p>
      {selected.size > 0 ? (
        <div role="toolbar" aria-label="Bulk actions" className="mt-2 flex items-center gap-2 text-[13px]">
          <span>{`${selected.size} of ${bots.length} selected`}</span>
          <select aria-label="Set approval level" disabled={props.levelReview !== null} value={props.target} onChange={(event) => props.onTarget(event.target.value as PermissionMode)}>
            {LEVELS.map((level) => <option key={level} value={level}>{levelName(level)}</option>)}
          </select>
          <button type="button" data-bots-action="apply" disabled={props.busy} onClick={props.onApply}>Apply</button>
          <button type="button" data-bots-action="archive" disabled={props.busy} onClick={props.onArchive}>Archive</button>
          <button type="button" data-bots-action="clear" onClick={props.onClear}>Clear</button>
        </div>
      ) : null}
      <ul aria-label="Bots" className="mt-2 divide-y divide-hairline/40 rounded-lg border border-hairline/40">
        {active.map(row)}
        {archived.map(row)}
      </ul>
      <button type="button" data-bots-action="move-all" disabled={props.busy} onClick={props.onMoveAll} className="mt-3 text-[13px]">Move all to No limits</button>
      {props.results.length ? (
        <ul aria-label="Results" className="mt-2 text-[12.5px]">
          {props.results.map((result) => <li key={result.botId} data-result-for={result.botId}>{result.text}</li>)}
        </ul>
      ) : null}
      {props.levelReview ? <LevelReview {...props} review={props.levelReview} /> : null}
      {props.archiveReview ? <ConfirmClearsAppChoices bots={props.archiveReview} action="archive" onConfirm={props.onConfirmArchive} onCancel={props.onCancelArchive} /> : null}
      {props.moveAll ? <MoveAllReview {...props} state={props.moveAll} /> : null}
    </section>
  );
}

function LevelReview({ review, target, setAuto, onToggleSetAuto, onConfirmLevel, onCancelLevel }: BotsRosterBodyProps & { review: BulkLevelReview[] }) {
  const changing = review.filter((item) => item.previous !== target);
  const same = review.filter((item) => item.previous === target);
  return (
    <div role="dialog" aria-modal="true" aria-label={`Review before ${levelName(target)}`}>
      <h2 className="text-[15px] font-semibold">{`Review before ${levelName(target)}`}</h2>
      {changing.some((item) => item.acks.acknowledgeFullAccess) ? <p data-level-review-note="full-access">{`${FULL_ACCESS_WARNING} ${FULL_ACCESS_STOP_LINE} ${FULL_ACCESS_ASKS_UNLESS_ALLOWED}`}</p> : null}
      <ul>
        {changing.map((item) => (
          <li key={item.botId}>
            {`${item.name} (now ${levelName(item.previous)})`}
            {item.acks.acknowledgeFullAccess ? <span data-level-review-first="full-access">{" First time at Full access for this bot."}</span> : null}
            {item.acks.acknowledgeLocalAuto ? (
              <label data-level-review-local={item.botId} className="mt-1 block">
                <span className="block">{target === "full" ? LOCAL_COMPUTER_FULL_ACCESS_WARNING : LOCAL_COMPUTER_AUTO_WARNING}</span>
                <input type="checkbox" aria-label={`Set ${item.name} to ${levelName(target)} on this computer`} checked={setAuto.has(item.botId)} onChange={() => onToggleSetAuto(item.botId)} />
                {` Set to ${levelName(target)}. Unticked, ${item.name} stays at Ask.`}
              </label>
            ) : null}
          </li>
        ))}
        {same.map((item) => <li key={item.botId}>{`${item.name} is already set to ${levelName(target)}, so nothing changes for it.`}</li>)}
      </ul>
      <p>Each bot is saved by itself, with its own review. A bot that changed since this review is not saved: its row reads Changed since the review.</p>
      <button type="button" data-level-review="cancel" onClick={onCancelLevel}>Cancel</button>
      <button type="button" data-level-review="confirm" onClick={onConfirmLevel}>{`Apply to ${changing.filter((item) => !item.acks.acknowledgeLocalAuto || setAuto.has(item.botId)).length} bots`}</button>
    </div>
  );
}

function MoveAllReview({ state, onConfirmMoveAll, onCancelMoveAll }: BotsRosterBodyProps & { state: { plan: NoLimitsPlan; outcome: MoveAllOutcome | null } }) {
  const view = moveAllReview(state.plan);
  const { outcome } = state;
  return (
    <div role="dialog" aria-modal="true" aria-label="Move all to No limits">
      <h2 className="text-[15px] font-semibold">Move all to No limits?</h2>
      {outcome?.kind === "changed" ? <p role="alert">The list changed while this was open. Nothing was moved. Review the new list.</p> : null}
      {outcome?.kind === "notMoved" ? <p role="alert">{`Nothing was moved. Every bot, routine and chat keeps its previous level.${outcome.message ? ` ${outcome.message}` : ""}`}</p> : null}
      {outcome?.kind === "pending" ? <p role="status">Pending: Murage is checking the outcome or restoring the previous levels.</p> : null}
      {outcome?.kind === "moved" ? <p role="status">Moved.</p> : null}
      <p>{`${view.activeBots} active bots and ${view.archivedBots} archived bots follow No limits.`}</p>
      <h3>{`${view.routines.length} routines. Each one's own level is cleared.`}</h3>
      <ul aria-label="Routines">
        {view.routines.map((item) => <li key={item.id}>{item.text}{item.withdrawn ? ". It was waiting for you to approve Auto, and that request is withdrawn." : ""}</li>)}
      </ul>
      <h3>{`${view.chats.length} chats. Each one's own level is cleared.`}</h3>
      <ul aria-label="Chats">
        {view.chats.map((item) => <li key={item.id}>{item.text}{item.guest ? ", a chat a guest started: it still never runs at No limits" : ""}</li>)}
      </ul>
      <p>If anything on this list changes while this question is open, or something gets a level of its own, nothing is moved and Murage shows you the new list.</p>
      <button type="button" data-move-all="cancel" onClick={onCancelMoveAll}>{outcome?.kind === "moved" ? "Close" : "Leave them as they are"}</button>
      {outcome?.kind === "moved" || outcome?.kind === "pending" ? null : <button type="button" data-move-all="confirm" onClick={onConfirmMoveAll}>{outcome ? "Try again" : "Move all to No limits"}</button>}
    </div>
  );
}
