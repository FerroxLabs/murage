import { useEffect, useState } from 'react';
import { api } from '@/state/store';
import { respondWithFreshAuth } from '@/lib/fresh-auth';
import { botReviewCard, type BotReviewSpec, type BotReviewView } from '../../shared/bot-review';
const button = 'min-h-11 rounded-lg border border-hairline px-4 py-2 text-sm disabled:opacity-50';
const level = (v: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }) => v.noLimits ? 'No limits' : v.fullAccess ? 'Full access' : v.autoApprove ? 'Auto' : 'Ask';
const value = (v: unknown): string => typeof v === 'string' ? v : v === undefined ? 'None' : typeof v === 'boolean' ? v ? 'Yes' : 'No' : JSON.stringify(v, null, 2);
function WordDiff({ before, after }: { before: unknown; after: unknown }) {
  const old = value(before).split(/(\s+)/), next = value(after).split(/(\s+)/);
  let start = 0, end = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (end < old.length - start && end < next.length - start && old[old.length - end - 1] === next[next.length - end - 1]) end++;
  return <div className="whitespace-pre-wrap break-words"><span>{old.slice(0, start).join('')}</span><del className="bg-red-500/10">{old.slice(start, old.length - end).join('')}</del>{' '}<ins className="bg-green-500/10">{next.slice(start, next.length - end).join('')}</ins><span>{end ? next.slice(-end).join('') : ''}</span></div>;
}
export function BotReviewFields({ spec, renderer }: { spec: BotReviewSpec; renderer: string }) {
  const pending = spec.staged ?? spec.pendingRevision, intended = spec.staged?.intended;
  const field = (label: string, content: unknown) => <div className="my-3" key={label}><dt className="font-medium">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value(content)}</dd></div>;
  const labels: Record<string, string> = { name: 'Name', role: 'Role', instructions: 'Instructions', modelSelection: 'Model', section: 'Team', lead: 'Lead', restore: 'Restore' };
  return <section data-bot-review-renderer={renderer} className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">Review {spec.name}</h2>
    <dl>{field('Name', spec.name)}{field('Role', spec.role)}{field('Instructions', spec.instructions)}{field('Current model', spec.modelSelection)}{field('Team', spec.section || 'General')}{field('Lead', spec.lead)}{field('Archived', spec.archived)}{field('Level', level(spec))}
      {field('Saved approvals for this bot', spec.alwaysAllow.length ? spec.alwaysAllow.join('\n') : 'None')}
      {intended && <>{field('Starts at level', level(intended))}{field('Starts as lead', intended.lead)}{field('Requested model', intended.modelSelection ?? spec.modelSelection)}</>}
      {field('Outside source', pending?.source ?? (pending?.reason === 'outside' ? 'Outside content' : 'None recorded'))}
    </dl>
    {spec.tasks.map(task => <section key={task.threadId}><h3 className="font-medium">Conversation {task.threadId}</h3><p>Level: {level(task)}</p>{intended && <p>Starts at level: {level(intended)}</p>}<h4>Saved approvals</h4><pre className="whitespace-pre-wrap break-words font-sans">{task.alwaysAllow.join('\n') || 'None'}</pre></section>)}
    {spec.pendingRevision && <section><h3 className="font-medium">Proposed changes</h3>{Object.entries(spec.pendingRevision.fields).map(([key, proposed]) => <section className="my-3" key={key}><h4>{labels[key] ?? key}</h4><WordDiff before={key === 'restore' ? !spec.archived : (spec as unknown as Record<string, unknown>)[key]} after={proposed} /></section>)}</section>}
    {!!spec.staged?.heldWork.length && <section><h3 className="font-medium">Then it will:</h3><ol className="list-decimal space-y-3 pl-5">{spec.staged.heldWork.map((work, i) => <li key={i} className="whitespace-pre-wrap break-words">{work.text}<p className="text-sm text-ink-secondary">From {work.fromBotId} · {work.kind}</p></li>)}</ol></section>}
  </section>;
}
export function BotReviewActions({ surface, pending, multiple, busy, onAction }: { surface: string; pending: boolean; multiple: boolean; busy: boolean; onAction: (action: 'activate' | 'discard') => void }) {
  const activate = ['computer', 'cloud-desktop', 'phone-app'].includes(surface);
  return <div className="space-y-3 border-t border-hairline p-4">{!activate && <p>Switch this bot on from the Murage computer or phone app. You can read everything here, or Discard it.</p>}<div className="flex flex-wrap gap-3">{activate && <button type="button" className={button} disabled={busy} onClick={() => onAction('activate')}>{multiple ? 'Activate all' : pending ? 'Apply' : 'Activate'}</button>}<button type="button" className={button} disabled={busy} onClick={() => onAction('discard')}>Discard</button></div></div>;
}
export function BotReviewSheet({ botIds, onDone }: { botIds: string[]; onDone?: () => void }) {
  const [views, setViews] = useState<BotReviewView[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const key = botIds.join(',');
  const load = async () => { const items = await Promise.all(botIds.map(id => api(`/api/bots/${encodeURIComponent(id)}/review`))); setViews(items); };
  useEffect(() => { let live = true; setViews([]); void Promise.all(botIds.map(id => api(`/api/bots/${encodeURIComponent(id)}/review`))).then(items => { if (live) setViews(items); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [key]);
  const surface = views[0]?.surface ?? 'other-owner', renderer = surface === 'phone-app' ? 'bot-review-phone@1' : 'bot-review@1';
  const action = async (action: 'activate' | 'discard') => {
    if (!views.length || busy) return; setBusy(true); setError('');
    try {
      if (action === 'discard') for (const view of views) await api(`/api/bots/${view.spec.id}/review`, { method: 'POST', body: JSON.stringify({ action }) });
      else {
        const items = views.map(v => ({ id: v.spec.id, digest: v.digest })), first = views[0], p = first.spec.staged ?? first.spec.pendingRevision!;
        await respondWithFreshAuth(extra => api(`/api/bots/${first.spec.id}/review`, { method: 'POST', body: JSON.stringify({ action, items, seen: { renderer, digest: first.digest }, ...extra }) }), { threadId: p.byThreadId, requestId: `bot-review-${first.spec.id}`, decision: 'allow', card: botReviewCard(items), reason: `Activate ${views.map(v => v.spec.name).join(', ')}` });
      }
      onDone?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not apply this review.'); await load().catch(refresh => { setError(message => `${message}\n${refresh instanceof Error ? refresh.message : String(refresh)}`); }); }
    finally { setBusy(false); }
  };
  return <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Bot review"><div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-4">{!views.length && !error && <p>Loading review…</p>}{views.map(view => <BotReviewFields key={view.spec.id} spec={view.spec} renderer={renderer} />)}{error && <p role="alert">{error}</p>}</div>{views.length > 0 && <BotReviewActions surface={surface} pending={!!views[0].spec.pendingRevision} multiple={views.length > 1} busy={busy} onAction={action} />}</div>;
}
