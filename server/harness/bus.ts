// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";

const INCOMPLETE_LOG_MESSAGE =
  "Canonical event history is incomplete: Murage could not write one or more events to disk. Live updates will continue.";

/** Provider image bytes, out of the on-disk log.
 *
 * `redactSecrets` scrubs CREDENTIAL-shaped content; nothing in it knows about
 * base64 payloads. So the ACP driver carefully kept generated-image bytes out
 * of native/<thread>.ndjson while the very same payload went verbatim into
 * events/<thread>.ndjson — the sibling file, and the one the comment below
 * calls "a file people paste into bug reports". Half the job.
 *
 * The shape is kept so the log still shows that an image happened and how big
 * it was; only the payload goes. Found by the sweep's own verifier after two
 * external audits called this lane clean. */
function withoutImageBytes(event: RuntimeEvent): RuntimeEvent {
  const candidate = event as unknown as { itemType?: unknown; data?: unknown };
  if (candidate.itemType !== "assistant_image" || typeof candidate.data !== "string") return event;
  return {
    ...event,
    data: `[image data: ${candidate.data.length} base64 chars]`,
  } as RuntimeEvent;
}

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private unsubscribes: Array<() => void> = [];
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  private readonly appendLog: typeof appendFileSync;

  constructor(appendLog: typeof appendFileSync = appendFileSync) {
    this.appendLog = appendLog;
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.push(unsub);
    }
  }

  publish(event: RuntimeEvent) {
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    const loggable = redactSecrets(withoutImageBytes(event));
    const persistedEvents = pendingWarning ? [pendingWarning, loggable] : [loggable];
    try {
      // the canonical log is a file people paste into bug reports; scrub
      // credential-shaped content (tool titles, request summaries, reply
      // text) the same way the native tee does
      this.appendLog(
        join(EVENTS_DIR, `${event.threadId}.ndjson`),
        persistedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { mode: 0o600 },
      );
      if (pendingWarning) this.pendingLogWarnings.delete(event.threadId);
    } catch (error) {
      // Never feed this warning back through publish(): that would retry the
      // same failed write and recurse. Deliver it once for this outage, then
      // persist the same marker before the first event written after recovery.
      if (!pendingWarning) {
        const warning: RuntimeEvent = {
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.error",
          message: INCOMPLETE_LOG_MESSAGE,
        };
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
        this.deliver(warning);
      }
    }
    this.deliver(event);
  }

  private deliver(event: RuntimeEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detachAll() {
    for (const unsub of this.unsubscribes.splice(0)) unsub();
  }
}
