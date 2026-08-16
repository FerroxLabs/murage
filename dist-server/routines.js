import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.js";
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;
function cleanDays(days) {
    if (!Array.isArray(days))
        return ALL_DAYS;
    const out = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return out.length ? out : ALL_DAYS;
}
function cleanSchedule(schedule) {
    if (schedule?.type === "once") {
        const at = Number(schedule.at);
        if (!Number.isFinite(at))
            throw new Error("Choose a valid date and time");
        return { type: "once", at };
    }
    if (schedule?.type === "daily") {
        const time = String(schedule.time ?? "");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
            throw new Error("Time must use HH:MM");
        return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
    }
    throw new Error("Choose a supported schedule");
}
/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule, after) {
    if (schedule.type === "once")
        return schedule.at > after ? schedule.at : null;
    const [hour, minute] = schedule.time.split(":").map(Number);
    const weekdays = new Set(cleanDays(schedule.weekdays));
    for (let offset = 0; offset <= 8; offset++) {
        const d = new Date(after);
        d.setDate(d.getDate() + offset);
        d.setHours(hour, minute, 0, 0);
        if (d.getTime() > after && weekdays.has(d.getDay()))
            return d.getTime();
    }
    return null;
}
function sanitizeInput(input) {
    const name = String(input.name ?? "").trim().slice(0, 80);
    const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
    const botId = String(input.botId ?? "").trim();
    if (!name)
        throw new Error("Give the routine a name");
    if (!prompt)
        throw new Error("Tell the bot what to do");
    if (!botId)
        throw new Error("Choose a bot");
    const runOn = input.runOn ?? "maus";
    if (runOn !== "maus" && runOn !== "cloud")
        throw new Error("Choose where this routine runs");
    return {
        name,
        prompt,
        botId,
        runOn,
        enabled: input.enabled !== false,
        schedule: cleanSchedule(input.schedule),
        durationMinutes: Math.min(240, Math.max(15, Math.round(Number(input.durationMinutes) || 30))),
    };
}
export class RoutineManager {
    file;
    now;
    options;
    routines = [];
    runs = [];
    timer = null;
    ticking = false;
    constructor(options) {
        this.options = options;
        this.file = options.file ?? join(DATA_DIR, "routines.json");
        this.now = options.now ?? Date.now;
        try {
            const disk = JSON.parse(readFileSync(this.file, "utf8"));
            this.routines = Array.isArray(disk.routines)
                ? disk.routines.map((routine) => ({ ...routine, runOn: routine.runOn ?? "maus" }))
                : [];
            this.runs = Array.isArray(disk.runs)
                ? disk.runs.map((run) => ({ ...run, runOn: run.runOn ?? "maus" }))
                : [];
        }
        catch {
            this.routines = [];
            this.runs = [];
        }
        // A local process cannot still own these turns after a full restart.
        let recovered = false;
        for (const run of this.runs) {
            if (run.status === "running" || run.status === "waiting") {
                run.status = "failed";
                run.error = "OpenMausBot restarted while this routine was running";
                run.finishedAt = this.now();
                recovered = true;
            }
        }
        if (recovered)
            this.save();
    }
    listRoutines() {
        return this.routines.map((r) => ({ ...r, schedule: { ...r.schedule } }));
    }
    listRuns(from, to) {
        return this.runs
            .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
            .sort((a, b) => b.scheduledFor - a.scheduledFor)
            .map((r) => ({ ...r }));
    }
    activeRunForBot(botId) {
        const run = this.runs.find((candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status));
        return run ? { ...run } : null;
    }
    isActiveThread(threadId) {
        return this.runs.some((run) => run.threadId === threadId && ["running", "waiting"].includes(run.status));
    }
    create(input) {
        const clean = sanitizeInput(input);
        if (this.options.botState(clean.botId) === "missing")
            throw new Error("That bot no longer exists");
        const at = this.now();
        const routine = {
            id: randomUUID(),
            ...clean,
            nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
            createdAt: at,
            updatedAt: at,
        };
        this.routines.unshift(routine);
        this.save();
        this.emitRoutine(routine);
        return { ...routine, schedule: { ...routine.schedule } };
    }
    update(id, patch) {
        const routine = this.routines.find((r) => r.id === id);
        if (!routine)
            return null;
        const clean = sanitizeInput({
            name: patch.name ?? routine.name,
            prompt: patch.prompt ?? routine.prompt,
            botId: patch.botId ?? routine.botId,
            runOn: patch.runOn ?? routine.runOn,
            enabled: patch.enabled ?? routine.enabled,
            schedule: patch.schedule ?? routine.schedule,
            durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
        });
        if (this.options.botState(clean.botId) === "missing")
            throw new Error("That bot no longer exists");
        Object.assign(routine, clean, {
            nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, this.now()) : null,
            updatedAt: this.now(),
        });
        if (patch.enabled === false) {
            for (const run of this.runs) {
                if (run.routineId !== routine.id || run.status !== "queued")
                    continue;
                run.status = "cancelled";
                run.finishedAt = this.now();
                run.error = "The routine was paused before this run started";
                this.emitRun(run);
            }
        }
        this.save();
        this.emitRoutine(routine);
        return { ...routine, schedule: { ...routine.schedule } };
    }
    remove(id) {
        const at = this.routines.findIndex((r) => r.id === id);
        if (at === -1)
            return false;
        this.routines.splice(at, 1);
        for (const run of this.runs) {
            if (run.routineId === id && run.status === "queued") {
                run.status = "cancelled";
                run.finishedAt = this.now();
                this.emitRun(run);
            }
        }
        this.save();
        this.options.emit?.({ kind: "routine.deleted", routineId: id });
        return true;
    }
    disableForBot(botId) {
        let changed = false;
        for (const routine of this.routines) {
            if (routine.botId !== botId || !routine.enabled)
                continue;
            routine.enabled = false;
            routine.nextRunAt = null;
            routine.updatedAt = this.now();
            this.emitRoutine(routine);
            changed = true;
        }
        for (const run of this.runs) {
            if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status))
                continue;
            run.status = "cancelled";
            run.finishedAt = this.now();
            run.error = "The assigned bot was deleted";
            this.emitRun(run);
            if (run.threadId)
                void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => { });
            changed = true;
        }
        if (changed)
            this.save();
    }
    runNow(id) {
        const routine = this.routines.find((r) => r.id === id);
        if (!routine)
            return null;
        const run = this.newRun(routine, this.now(), true);
        this.save();
        this.emitRun(run);
        queueMicrotask(() => void this.tick());
        return { ...run };
    }
    /** Queue an event-driven job without inventing a calendar schedule. Webhook
     * definitions live in their own store; the execution receipt deliberately
     * reuses this manager so busy-bot ordering, task creation and VM routing stay
     * identical for every unattended job. */
    enqueueWebhook(input) {
        if (this.options.botState(input.botId) === "missing") {
            throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
        }
        const run = {
            id: randomUUID(),
            routineId: input.webhookId,
            routineName: input.webhookName,
            prompt: input.prompt,
            botId: input.botId,
            runOn: input.runOn,
            scheduledFor: input.receivedAt,
            status: "queued",
            manual: false,
            triggerSource: "webhook",
            webhookId: input.webhookId,
            deliveryId: input.deliveryId,
            createdAt: this.now(),
        };
        this.runs.push(run);
        if (this.runs.length > MAX_RUNS)
            this.runs.splice(0, this.runs.length - MAX_RUNS);
        this.save();
        this.emitRun(run);
        queueMicrotask(() => void this.tick());
        return { ...run };
    }
    activeWebhookRunCount(webhookId) {
        return this.runs.filter((run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status)).length;
    }
    cancelQueuedWebhook(webhookId, message) {
        let changed = false;
        for (const run of this.runs) {
            if (run.webhookId !== webhookId || run.status !== "queued")
                continue;
            run.status = "cancelled";
            run.finishedAt = this.now();
            run.error = message.slice(0, 500);
            this.emitRun(run);
            changed = true;
        }
        if (changed)
            this.save();
    }
    async cancelRun(id) {
        const run = this.runs.find((r) => r.id === id);
        if (!run || !["queued", "running", "waiting"].includes(run.status))
            return null;
        run.status = "cancelled";
        run.finishedAt = this.now();
        this.save();
        this.emitRun(run);
        if (run.threadId)
            await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => { });
        queueMicrotask(() => void this.tick());
        return { ...run };
    }
    markSeen(id) {
        const run = this.runs.find((r) => r.id === id);
        if (!run)
            return null;
        if (!run.seenAt) {
            run.seenAt = this.now();
            this.save();
            this.emitRun(run);
        }
        return { ...run };
    }
    start() {
        if (this.timer)
            return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), 10_000);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async tick() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            const now = this.now();
            let changed = false;
            for (const routine of this.routines) {
                if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now)
                    continue;
                const scheduledFor = routine.nextRunAt;
                const late = now - scheduledFor;
                if (late > CATCH_UP_MS) {
                    const missed = this.newRun(routine, scheduledFor, false);
                    missed.status = "missed";
                    missed.finishedAt = now;
                    missed.error = "This computer was offline for more than 12 hours after the scheduled time";
                    this.emitRun(missed);
                }
                else {
                    const run = this.newRun(routine, scheduledFor, false);
                    this.emitRun(run);
                }
                routine.nextRunAt =
                    routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
                if (routine.schedule.type === "once")
                    routine.enabled = false;
                routine.updatedAt = now;
                this.emitRoutine(routine);
                changed = true;
            }
            if (changed)
                this.save();
            for (const run of [...this.runs].reverse()) {
                if (run.status !== "queued")
                    continue;
                const state = this.options.botState(run.botId);
                if (state === "busy")
                    continue;
                if (state === "missing") {
                    run.status = "failed";
                    run.error = "The assigned bot no longer exists";
                    run.finishedAt = this.now();
                    this.save();
                    this.emitRun(run);
                    continue;
                }
                // A webhook is an incoming message, so make its task the bot's live
                // chat immediately. Scheduled work remains detached and unobtrusive.
                const task = this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
                if (!task) {
                    run.status = "failed";
                    run.error = "Could not create a task for this run";
                    run.finishedAt = this.now();
                    this.save();
                    this.emitRun(run);
                    continue;
                }
                run.threadId = task.threadId;
                run.startedAt = this.now();
                run.status = "running";
                this.save();
                this.emitRun(run);
                try {
                    const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
                    if (!prompt) {
                        this.failThread(task.threadId, "The routine was deleted before it could start");
                        continue;
                    }
                    const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
                    await this.options.startTurn(run.botId, task.threadId, prompt, run.runOn ?? "maus", triggerSource, (message) => this.failThread(task.threadId, message));
                }
                catch (error) {
                    this.failThread(task.threadId, error instanceof Error ? error.message : String(error));
                }
            }
        }
        finally {
            this.ticking = false;
        }
    }
    handleRuntimeEvent(event) {
        const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
        if (!run)
            return;
        if (event.type === "request.opened") {
            run.status = "waiting";
        }
        else if (event.type === "request.resolved") {
            run.status = "running";
        }
        else if (event.type === "item.completed" && event.itemType === "assistant_text") {
            run.output = event.text.trim().slice(0, 2_000);
        }
        else if (event.type === "runtime.error") {
            run.error = event.message.slice(0, 500);
        }
        else if (event.type === "turn.completed") {
            run.status = event.ok ? "completed" : "failed";
            run.finishedAt = this.now();
            run.error = event.ok ? undefined : (event.stopReason ?? run.error ?? "The bot did not complete this run");
            run.cost = event.cost;
            run.denials = event.denials;
        }
        else {
            return;
        }
        this.save();
        this.emitRun(run);
        if (event.type === "turn.completed")
            queueMicrotask(() => void this.tick());
    }
    failThread(threadId, message) {
        const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
        if (!run)
            return;
        run.status = "failed";
        run.error = message.slice(0, 500);
        run.finishedAt = this.now();
        this.save();
        this.emitRun(run);
        queueMicrotask(() => void this.tick());
    }
    initialOccurrence(schedule, now) {
        if (schedule.type === "once")
            return Math.max(schedule.at, now);
        return nextOccurrence(schedule, now);
    }
    newRun(routine, scheduledFor, manual) {
        const run = {
            id: randomUUID(),
            routineId: routine.id,
            routineName: routine.name,
            prompt: routine.prompt,
            durationMinutes: routine.durationMinutes,
            botId: routine.botId,
            runOn: routine.runOn ?? "maus",
            scheduledFor,
            status: "queued",
            manual,
            triggerSource: manual ? "manual" : "schedule",
            createdAt: this.now(),
        };
        this.runs.push(run);
        if (this.runs.length > MAX_RUNS)
            this.runs.splice(0, this.runs.length - MAX_RUNS);
        return run;
    }
    emitRoutine(routine) {
        this.options.emit?.({ kind: "routine", routine: { ...routine, schedule: { ...routine.schedule } } });
    }
    emitRun(run) {
        this.options.emit?.({ kind: "routine.run", run: { ...run } });
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        writeFileSync(temp, JSON.stringify({ version: 1, routines: this.routines, runs: this.runs }, null, 2));
        renameSync(temp, this.file);
    }
}
