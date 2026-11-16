// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrozenRequest } from './held-request.ts';
import type { RequestDraft } from './operations/registry.ts';
import type { OperationId } from '../../shared/highlevel.ts';
/** Owned parent observations and qualified recovery selectors travel with one
 * exact draft/held object, like contact tag pre-state. Never from write replies. */
export interface CalendarContext {
 readonly parents: Readonly<Record<string, string>>;
 readonly recoveryOperation?: OperationId;
 readonly recoveryQuery?: Readonly<Record<string, string>>;
}
const drafts = new WeakMap<RequestDraft, CalendarContext>();
const requests = new WeakMap<FrozenRequest, CalendarContext>();
export function retainCalendarDraft(draft: RequestDraft, context: CalendarContext): void {
 drafts.set(draft, Object.freeze({ ...context, parents: Object.freeze({ ...context.parents }), ...(context.recoveryQuery ? { recoveryQuery: Object.freeze({ ...context.recoveryQuery }) } : {}) }));
}
export function bindCalendarContext(frozen: FrozenRequest, draft: RequestDraft): void {
 const context = drafts.get(draft); if (context) requests.set(frozen, context);
}
export function calendarContextFor(frozen: FrozenRequest): CalendarContext | undefined { return requests.get(frozen); }
