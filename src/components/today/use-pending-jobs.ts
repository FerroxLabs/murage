// FIRSTRUN-1019 D2: the queue of ticked jobs and the runner that starts them. Mounted in two places (the Today line and
// the first job's result card) so the queue keeps moving wherever the person is; the shared module state below means
// two mounted copies never send the same job twice.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { api, useStore } from "@/state/store";
import { useSetupView } from "../FirstRunChrome";
import {
  canStartNext,
  nextToStart,
  mutatePending,
  pendingLoaded,
  pendingNow,
  readPendingJobs,
  setPendingLocal,
  startPendingJob,
  forgetSendId,
  sendIdFor,
  subscribePending,
  withoutJob,
  QUEUE_SETTLE_MS,
} from "@/lib/first-run-pending";
import type { FirstRunJobId } from "@/lib/first-run-jobs";

const SEND_TIMEOUT_MS = 30_000;
const gate = { sending: false, acceptedAt: 0, sawBusySince: false };
const failedThisSession = new Set<FirstRunJobId>();
/** Where each job's send went the first time: a retry with the same send id goes to the SAME bot and thread, never to whichever conversation is open now. */
const sendTargets = new Map<string, { botId: string; threadId: string | undefined }>();

export function usePendingJobs() {
  const { view } = useSetupView();
  const { state, dispatch } = useStore();
  const [ids, setIds] = useState<readonly FirstRunJobId[]>(() => pendingNow());
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => subscribePending(setIds), []);
  // A failed read is retried, never taken for an empty queue.
  useEffect(() => {
    if (pendingLoaded()) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void readPendingJobs(api).then((list) => {
      if (!live) return;
      if (list === null) timer = setTimeout(bump, 5_000);
      else if (!pendingLoaded()) setPendingLocal(list);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  const chiefId = view?.chiefBotId ?? null;
  const chief = chiefId ? state?.bots?.find((bot) => bot.id === chiefId) : undefined;
  const busy = chief?.busy === true;
  const flow = view?.steps.find((step) => step.id === "flow");
  const firstJobFinished = !view ? false : view.conversationLive !== true || flow?.done === true || flow?.skipped === true;
  const head = nextToStart(ids, failedThisSession);

  if (busy) gate.sawBusySince = true;

  const stateRef = useRef(state);
  stateRef.current = state;
  const send = useCallback((text: string, sendId: string) => new Promise<void>((resolve, reject) => {
    if (!chiefId) { reject(new Error("no chief")); return; }
    let target = sendTargets.get(sendId);
    if (!target) {
      target = { botId: chiefId, threadId: stateRef.current?.bots?.find((bot) => bot.id === chiefId)?.threadId };
      sendTargets.set(sendId, target);
    }
    // An unanswered send is UNRESOLVED, not failed: the outbox may still deliver it. It is asked again with the same send
    // id (the server answers with the first acceptance) and never shown as failed, so it can never run twice.
    const timer = setTimeout(() => reject(Object.assign(new Error("The send did not answer."), { unresolved: true })), SEND_TIMEOUT_MS);
    dispatch({
      type: "send", botId: target.botId, threadId: target.threadId, text, sendId,
      onSent: () => { clearTimeout(timer); resolve(); },
      onError: (error) => { clearTimeout(timer); reject(error); return true; },
    });
  }), [chiefId, dispatch]);

  useEffect(() => {
    if (!head || !chiefId) return;
    const now = Date.now();
    if (!canStartNext({ firstJobFinished, chiefBusy: busy, sending: gate.sending, acceptedAt: gate.acceptedAt, sawBusySince: gate.sawBusySince, now })) {
      // Waiting out the settle window: look again when it ends.
      if (firstJobFinished && !busy && !gate.sending && gate.acceptedAt > 0 && !gate.sawBusySince) {
        const timer = setTimeout(bump, Math.max(50, QUEUE_SETTLE_MS - (now - gate.acceptedAt) + 50));
        return () => clearTimeout(timer);
      }
      return;
    }
    gate.sending = true;
    void startPendingJob(head, {
      send,
      request: api,
      onAccepted: () => {
        // The destination is kept until acceptance is recorded here, so a retry after a late receipt still goes to the same thread.
        sendTargets.delete(sendIdFor(head));
        gate.acceptedAt = Date.now();
        gate.sawBusySince = false;
      },
    })
      .catch((error: unknown) => {
        if ((error as { unresolved?: boolean } | null)?.unresolved === true) {
          // Not failed and not accepted: look again shortly, with the same send id.
          setTimeout(bump, 5_000);
          return;
        }
        // A failed job shows its line and the rest keep going. Both mounted copies hear about it.
        failedThisSession.add(head);
        setPendingLocal(pendingNow(), false);
      })
      .finally(() => {
        gate.sending = false;
        bump();
      });
  }, [head, chiefId, firstJobFinished, busy, send, ids, tick]);

  const stop = useCallback(async (id: FirstRunJobId) => {
    await mutatePending(api, (queue) => withoutJob(queue, id));
    failedThisSession.delete(id);
  }, []);
  const retry = useCallback((id: FirstRunJobId) => {
    failedThisSession.delete(id);
    sendTargets.delete(sendIdFor(id));
    forgetSendId(id);
    setPendingLocal(pendingNow(), false);
    bump();
  }, []);

  return { ids, failed: failedThisSession as ReadonlySet<FirstRunJobId>, stop, retry, firstJobFinished };
}
