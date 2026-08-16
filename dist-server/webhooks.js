import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
const MAX_DELIVERIES = 2_000;
const MAX_ATTEMPTS = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const MAX_PENDING_RUNS = 3;
function fail(status, message) {
    throw Object.assign(new Error(message), { status });
}
function hashSecret(secret) {
    return createHash("sha256").update(secret).digest("hex");
}
function secretMatches(secret, expectedHex) {
    if (!secret)
        return false;
    const actual = Buffer.from(hashSecret(secret), "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function newEndpointId() {
    return `wh_${randomBytes(12).toString("base64url")}`;
}
function newSecret() {
    return `whsec_${randomBytes(32).toString("base64url")}`;
}
function cleanInput(input) {
    const name = String(input.name ?? "").trim().slice(0, 80);
    const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
    const botId = String(input.botId ?? "").trim();
    const runOn = input.runOn ?? "maus";
    if (!name)
        fail(400, "Give the webhook a name");
    if (!botId)
        fail(400, "Choose a MAUS");
    if (runOn !== "maus" && runOn !== "cloud")
        fail(400, "Choose where this webhook runs");
    const eventTypes = Array.from(new Set((Array.isArray(input.eventTypes) ? input.eventTypes : [])
        .map((value) => String(value).trim().slice(0, 200))
        .filter(Boolean))).slice(0, 20);
    const enabled = input.enabled !== false;
    return {
        name,
        prompt,
        botId,
        runOn,
        enabled,
        verificationPending: enabled ? false : input.verificationPending === true,
        ...(eventTypes.length ? { eventTypes } : {}),
    };
}
function withoutLegacyDuration(trigger) {
    const { durationMinutes: _durationMinutes, ...current } = trigger;
    return current;
}
function publicTrigger(trigger) {
    const { secretHash: _secretHash, ...safe } = trigger;
    return { ...safe };
}
function serializePayload(payload) {
    let text;
    if (typeof payload === "string")
        text = payload;
    else {
        try {
            text = JSON.stringify(payload, null, 2);
        }
        catch {
            text = String(payload);
        }
    }
    if (text.length <= MAX_EVENT_CHARS)
        return text;
    return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by OpenMausBot]`;
}
function previewPayload(payload) {
    return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 2_000);
}
function taskFromPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return "";
    const record = payload;
    const task = typeof record.task === "string" ? record.task : typeof record.message === "string" ? record.message : "";
    return task.trim().slice(0, 20_000);
}
function eventPrompt(trigger, event, receivedAt, deliveryId) {
    const metadata = [
        `Received: ${new Date(receivedAt).toISOString()}`,
        `Delivery ID: ${deliveryId}`,
        event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
        event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
        event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
    ].filter(Boolean);
    const configured = trigger.prompt.trim();
    const requestedTask = configured ? "" : taskFromPayload(event.payload);
    const instructionBlock = configured
        ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
        : requestedTask
            ? ["[AUTHENTICATED WEBHOOK TASK]", requestedTask, "[/AUTHENTICATED WEBHOOK TASK]"]
            : [
                "[DEFAULT WEBHOOK INSTRUCTIONS]",
                "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
                "[/DEFAULT WEBHOOK INSTRUCTIONS]",
            ];
    return [
        ...instructionBlock,
        "",
        "[UNTRUSTED WEBHOOK EVENT DATA]",
        ...metadata,
        "",
        serializePayload(event.payload),
        "[/UNTRUSTED WEBHOOK EVENT DATA]",
    ].join("\n");
}
export class WebhookManager {
    file;
    now;
    options;
    webhooks = [];
    deliveries = [];
    attempts = [];
    rate = new Map();
    constructor(options) {
        this.options = options;
        this.file = options.file ?? join(DATA_DIR, "webhooks.json");
        this.now = options.now ?? Date.now;
        try {
            const disk = JSON.parse(readFileSync(this.file, "utf8"));
            this.webhooks = Array.isArray(disk.webhooks) ? disk.webhooks.map(withoutLegacyDuration) : [];
            this.deliveries = Array.isArray(disk.deliveries) ? disk.deliveries.slice(-MAX_DELIVERIES) : [];
            this.attempts = Array.isArray(disk.attempts) ? disk.attempts.slice(-MAX_ATTEMPTS) : [];
        }
        catch {
            this.webhooks = [];
            this.deliveries = [];
            this.attempts = [];
        }
    }
    list() {
        return this.webhooks.map(publicTrigger);
    }
    listAttempts() {
        return this.attempts.map((attempt) => ({ ...attempt }));
    }
    create(input) {
        const clean = cleanInput(input);
        if (this.options.botState(clean.botId) === "missing")
            fail(400, "That MAUS no longer exists");
        const now = this.now();
        const secret = newSecret();
        const trigger = {
            id: randomUUID(),
            endpointId: newEndpointId(),
            ...clean,
            secretHash: hashSecret(secret),
            createdAt: now,
            updatedAt: now,
            deliveryCount: 0,
        };
        this.webhooks.unshift(trigger);
        this.save();
        this.emit(trigger);
        return { webhook: publicTrigger(trigger), secret };
    }
    update(id, patch) {
        const trigger = this.webhooks.find((candidate) => candidate.id === id);
        if (!trigger)
            return null;
        const clean = cleanInput({
            name: patch.name ?? trigger.name,
            prompt: patch.prompt ?? trigger.prompt,
            botId: patch.botId ?? trigger.botId,
            runOn: patch.runOn ?? trigger.runOn,
            enabled: patch.enabled ?? trigger.enabled,
            verificationPending: patch.verificationPending ?? trigger.verificationPending,
            eventTypes: patch.eventTypes ?? trigger.eventTypes,
        });
        if (this.options.botState(clean.botId) === "missing")
            fail(400, "That MAUS no longer exists");
        Object.assign(trigger, clean, { updatedAt: this.now() });
        if (!clean.eventTypes?.length)
            delete trigger.eventTypes;
        if (patch.enabled === false) {
            this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
        }
        this.save();
        this.emit(trigger);
        return publicTrigger(trigger);
    }
    remove(id) {
        const at = this.webhooks.findIndex((candidate) => candidate.id === id);
        if (at === -1)
            return false;
        const [trigger] = this.webhooks.splice(at, 1);
        this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
        this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
        this.rate.delete(trigger.endpointId);
        this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
        this.save();
        this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
        return true;
    }
    rotateSecret(id) {
        const trigger = this.webhooks.find((candidate) => candidate.id === id);
        if (!trigger)
            return null;
        const secret = newSecret();
        trigger.secretHash = hashSecret(secret);
        trigger.updatedAt = this.now();
        this.save();
        this.emit(trigger);
        return { webhook: publicTrigger(trigger), secret };
    }
    disableForBot(botId) {
        let changed = false;
        for (const trigger of this.webhooks) {
            if (trigger.botId !== botId || !trigger.enabled)
                continue;
            trigger.enabled = false;
            trigger.updatedAt = this.now();
            this.options.cancelQueued?.(trigger.id, "The assigned MAUS was deleted");
            this.emit(trigger);
            changed = true;
        }
        if (changed)
            this.save();
    }
    authorize(endpointId, secret) {
        const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
        return Boolean(trigger && secretMatches(secret, trigger.secretHash));
    }
    receive(endpointId, secret, event) {
        const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
        if (!trigger || !secretMatches(secret, trigger.secretHash))
            fail(401, "Invalid webhook URL or secret");
        if (trigger.verificationPending && !trigger.enabled)
            return this.captureVerification(trigger, event);
        try {
            return this.dispatch(trigger, event);
        }
        catch (error) {
            this.recordRejectedForTrigger(trigger, Number(error?.status) || 500, error instanceof Error ? error.message : String(error), event);
            throw error;
        }
    }
    test(id, payload = { event: "openmaus.test", message: "Test webhook delivery" }) {
        const trigger = this.webhooks.find((candidate) => candidate.id === id);
        if (!trigger)
            return null;
        const eventName = trigger.eventTypes?.[0] ?? "openmaus.test";
        return this.dispatch(trigger, {
            payload,
            contentType: "application/json",
            eventName,
            userAgent: "OpenMausBot webhook tester",
            deliveryId: `test-${randomUUID()}`,
        });
    }
    recordRejected(endpointId, statusCode, reason, event = {}) {
        const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
        if (!trigger)
            return null;
        return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
    }
    dispatch(trigger, event) {
        if (!trigger.enabled)
            fail(409, "This webhook is paused");
        if (this.options.botState(trigger.botId) === "missing")
            fail(410, "The assigned MAUS no longer exists");
        const allowed = trigger.eventTypes ?? [];
        if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
            const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
            this.appendAttempt(trigger, event, {
                outcome: "ignored",
                statusCode: 202,
                deliveryId,
                reason: event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
            });
            this.save();
            return { deliveryId, duplicate: false, ignored: true };
        }
        const now = this.now();
        const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
        if (requestedDeliveryId) {
            const key = `${trigger.endpointId}:${requestedDeliveryId}`;
            const duplicate = this.deliveries.find((delivery) => delivery.key === key);
            if (duplicate) {
                this.appendAttempt(trigger, event, {
                    outcome: "duplicate",
                    statusCode: 202,
                    deliveryId: requestedDeliveryId,
                    runId: duplicate.runId,
                    reason: "Duplicate delivery ignored",
                });
                this.save();
                return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
            }
        }
        // A sender retrying an already-accepted delivery must remain idempotent
        // even while this webhook's queue is full. Only new work consumes a slot.
        if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING_RUNS) {
            fail(429, "This webhook already has too many unfinished tasks");
        }
        const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
        if (recent.length >= RATE_LIMIT)
            fail(429, "Webhook rate limit exceeded");
        recent.push(now);
        this.rate.set(trigger.endpointId, recent);
        const deliveryId = requestedDeliveryId || randomUUID();
        const run = this.options.enqueue({
            webhookId: trigger.id,
            webhookName: trigger.name,
            prompt: eventPrompt(trigger, event, now, deliveryId),
            botId: trigger.botId,
            runOn: trigger.runOn,
            deliveryId,
            receivedAt: now,
        });
        this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
        if (this.deliveries.length > MAX_DELIVERIES) {
            this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
        }
        trigger.lastReceivedAt = now;
        trigger.lastRunId = run.id;
        trigger.deliveryCount += 1;
        trigger.updatedAt = now;
        this.appendAttempt(trigger, event, {
            outcome: "accepted",
            statusCode: 202,
            deliveryId,
            runId: run.id,
        });
        this.save();
        this.emit(trigger);
        return { runId: run.id, deliveryId, duplicate: false };
    }
    captureVerification(trigger, event) {
        const receivedAt = this.now();
        const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
        trigger.verificationPending = false;
        trigger.verifiedAt = receivedAt;
        trigger.lastReceivedAt = receivedAt;
        trigger.updatedAt = receivedAt;
        trigger.verificationSample = {
            receivedAt,
            ...(event.eventName ? { eventName: event.eventName.slice(0, 200) } : {}),
            ...(event.contentType ? { contentType: event.contentType.slice(0, 200) } : {}),
            preview: previewPayload(event.payload),
        };
        this.appendAttempt(trigger, event, {
            outcome: "captured",
            statusCode: 202,
            deliveryId,
            reason: "Test event captured; enable the webhook to start MAUS tasks",
        });
        this.save();
        this.emit(trigger);
        return { deliveryId, duplicate: false, captured: true };
    }
    recordRejectedForTrigger(trigger, statusCode, reason, event) {
        const attempt = this.appendAttempt(trigger, event, {
            outcome: "rejected",
            statusCode,
            reason: reason.slice(0, 500),
            deliveryId: event.deliveryId,
        });
        this.save();
        return attempt;
    }
    appendAttempt(trigger, event, details) {
        const attempt = {
            id: randomUUID(),
            webhookId: trigger.id,
            receivedAt: this.now(),
            outcome: details.outcome,
            statusCode: details.statusCode,
            ...(event.eventName ? { eventName: event.eventName.slice(0, 200) } : {}),
            ...(event.payload !== undefined ? { preview: previewPayload(event.payload) } : {}),
            ...(details.deliveryId ? { deliveryId: details.deliveryId.slice(0, 200) } : {}),
            ...(details.runId ? { runId: details.runId } : {}),
            ...(details.reason ? { reason: details.reason } : {}),
        };
        this.attempts.push(attempt);
        if (this.attempts.length > MAX_ATTEMPTS)
            this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
        this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
        return attempt;
    }
    emit(trigger) {
        this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileAtomic(this.file, JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries, attempts: this.attempts }, null, 2), { mode: 0o600 });
    }
}
