// A Claude bot's AskUserQuestion, end to end, against an isolated server and
// the fake CLI — the defect this lane exists for.
//
// Every bot in the live install runs with autoApprove on, and that is exactly
// the configuration that used to swallow the question: auto mode answered it,
// the proxy returned an allow with no answers, and the model was told "The
// user did not answer the questions" while nobody had been asked. So every
// bot here runs with autoApprove on and autoReview enforce.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let model: string;
let headers: Record<string, string> = {};

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const messages = async (threadId: string) =>
  (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const transcript = async (threadId: string) => JSON.stringify(await messages(threadId));
/** The open (or last) question card on a thread. */
const questionCard = async (threadId: string) =>
  (await messages(threadId)).filter((message) => message.card?.questions?.length).at(-1);
const decisions = (): any[] => {
  const path = join(fixture.info.dataDir, "decisions.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
const reviewCalls = (): number => {
  const path = join(fixture.info.dataDir, "review-calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
};

/** A bot in the configuration that used to lose the question: auto mode on,
 * and the AI reviewer set to the one mode that can answer a card by itself. */
const makeBot = async (name: string, instanceId = "verification") => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "enforce" })).status).toBe(200);
  return bot as { id: string; threadId: string };
};

/** Ask a question from the engine and wait for its card. */
const ask = async (bot: { id: string; threadId: string }) => {
  expect(
    (await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_ask_user_question__" })).status,
  ).toBe(202);
  await expect.poll(async () => Boolean(await questionCard(bot.threadId)), { timeout: 15000 }).toBe(true);
  return (await questionCard(bot.threadId))!;
};

const ANSWERS = [
  { id: "q1", selected: ["Summary"] },
  { id: "q2", selected: ["Intro", "Findings"] },
];

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // The AI permission reviewer runs as a one-shot child of the same fake
      // CLI. Logging every one of those is how this suite proves a question
      // was never handed to a model to answer.
      cfg.instances.verification.environment={...(cfg.instances.verification.environment||{}),FAKE_CLAUDE_REVIEW_LOG:path.join(dataDir,'review-calls.log')};
      // A second engine whose question wait is short enough to observe. The
      // shipped default is 30 minutes; the driver clamps a configured value
      // to one second, and nothing else about the engine changes.
      cfg.instances.expiring={...cfg.instances.verification,displayName:'Expiring questions',config:{...cfg.instances.verification.config,questionTimeoutMs:1000}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `,
  });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification")
    .models.options[0].id;
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

it("shows a question card in auto mode instead of auto-approving it", async () => {
  const bot = await makeBot("Question auto mode");
  const card = await ask(bot);

  // every question, with its header, option descriptions and multi-select
  expect(card.card.questions).toEqual([
    {
      id: "q1",
      question: "Which format should the report use?",
      header: "Format",
      options: [
        { label: "Summary", description: "A short overview" },
        { label: "Detailed", description: "Every finding with its evidence" },
      ],
      multiSelect: false,
      allowOther: true,
    },
    {
      id: "q2",
      question: "Which sections should it include?",
      header: "Sections",
      options: [
        { label: "Intro", description: "Opening context" },
        { label: "Findings", description: "What was found" },
        { label: "Outro", description: "Next steps" },
      ],
      multiSelect: true,
      allowOther: true,
    },
  ]);
  // the subtitle reads as a question, not as the raw JSON it used to be
  expect(card.card.subtitle).toBe("Which format should the report use?");
  expect(card.card.tool).toBeUndefined();
  // no remembered grant is ever offered for a question
  expect(card.card.allowKey).toBeUndefined();
  expect(card.card.answered).toBeUndefined();

  // no "auto-approved AskUserQuestion" chip, and no decision row claiming one
  const said = await transcript(bot.threadId);
  expect(said).not.toContain("auto-approved");
  // the audit keeps that the card was SHOWN, and nothing that says anyone or
  // anything approved it
  const rows = decisions().filter((row) => row.requestId === card.card.requestId);
  expect(rows.map((row) => row.decision)).toEqual(["card-shown"]);
  expect(rows[0]).toMatchObject({ source: "question", tool: "AskUserQuestion" });
  expect(decisions().some((row) => row.decision === "auto-approved")).toBe(false);
  // autoReview is "enforce", and it still never asked a model to answer this
  expect(reviewCalls()).toBe(0);

  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
}, 40000);

it("delivers the owner's answers to the engine exactly as they were chosen", async () => {
  const bot = await makeBot("Question answered");
  const card = await ask(bot);

  const responded = await api("POST", `/api/bots/${bot.id}/respond`, {
    threadId: bot.threadId,
    requestId: card.card.requestId,
    behavior: "answer",
    answers: ANSWERS,
  });
  expect(responded.status).toBe(200);
  expect(responded.body.outcome).toBe("answered");

  // The fake CLI builds the tool_result string Claude Code 2.1.268 builds
  // from updatedInput.answers, so this is the model-visible proof that the
  // picks arrived as answers and not as an empty allow.
  await expect
    .poll(async () => await transcript(bot.threadId), { timeout: 15000 })
    .toContain("Your questions have been answered");
  const said = await transcript(bot.threadId);
  expect(said).toContain('Which format should the report use?\\"=\\"Summary');
  expect(said).toContain('Which sections should it include?\\"=\\"Intro, Findings');
  expect(said).not.toContain("The user did not answer the questions");

  // the card keeps what was chosen, so the transcript shows it read-only
  const settled = (await messages(bot.threadId)).find((message) => message.card?.requestId === card.card.requestId);
  expect(settled.card.answered).toBe("answer");
  expect(settled.card.answers).toEqual(ANSWERS);
  expect(settled.card.expired).toBeFalsy();
  // An answer is conversation, not authorization. The audit keeps only that
  // the card was shown — never an approval, and never the answer itself.
  expect(decisions().filter((row) => row.requestId === card.card.requestId).map((row) => row.decision)).toEqual(["card-shown"]);
  expect(JSON.stringify(decisions())).not.toContain("Intro");
}, 40000);

it("refuses an answer the questions never offered, and refuses to approve one", async () => {
  const bot = await makeBot("Question validation");
  const card = await ask(bot);
  const respond = (body: unknown) =>
    api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, ...(body as object) });

  // a label nobody offered
  expect((await respond({ behavior: "answer", answers: [{ id: "q1", selected: ["Exhaustive"] }, ANSWERS[1]] })).status).toBe(400);
  // two picks on a single-select
  expect((await respond({ behavior: "answer", answers: [{ id: "q1", selected: ["Summary", "Detailed"] }, ANSWERS[1]] })).status).toBe(400);
  // a question left unanswered
  expect((await respond({ behavior: "answer", answers: [ANSWERS[0]] })).status).toBe(400);
  // free text past the cap
  expect(
    (await respond({ behavior: "answer", answers: [{ id: "q1", selected: [], other: "x".repeat(2_001) }, ANSWERS[1]] })).status,
  ).toBe(400);
  // and a question is never answered by approving it
  expect((await respond({ behavior: "allow" })).status).toBe(400);

  // nothing above settled the card, so the owner can still answer it
  expect((await questionCard(bot.threadId))!.card.answered).toBeUndefined();
  expect((await respond({ behavior: "answer", answers: ANSWERS })).body.outcome).toBe("answered");
}, 40000);

it("skips a question as soon as the card is closed, instead of leaving the bot waiting", async () => {
  // Regression: dismissing a question card sent behavior "deny", the broker
  // refused a deny on a question, and the engine waited out its whole
  // timeout while the card said "Couldn't deliver that answer".
  const bot = await makeBot("Question skipped");
  const card = await ask(bot);

  const responded = await api("POST", `/api/bots/${bot.id}/respond`, {
    threadId: bot.threadId,
    requestId: card.card.requestId,
    behavior: "skip",
  });
  expect(responded.status).toBe(200);
  expect(responded.body.outcome).toBe("rejected");

  await expect
    .poll(async () => (await questionCard(bot.threadId))!.card.answered, { timeout: 10000 })
    .toBe("skipped");
  const said = await transcript(bot.threadId);
  expect(said).not.toContain("Couldn't deliver that answer");
  // the engine hears a plain "nobody answered", never a guess in the owner's name
  expect(said).toContain("skipped this question");
  expect(said).not.toContain("best judgment");
  expect(decisions().some((row) => row.requestId === card.card.requestId && row.decision === "question-skipped")).toBe(true);
}, 40000);

it("expires a question nobody answered, and still gets a late answer to the bot", async () => {
  const bot = await makeBot("Question expiry", "expiring");
  const card = await ask(bot);
  const requestId = card.card.requestId;

  // the engine stops waiting on its own; the card does not vanish with it
  await expect.poll(async () => (await questionCard(bot.threadId))!.card.expired, { timeout: 15000 }).toBe(true);
  const expired = (await questionCard(bot.threadId))!;
  expect(expired.card.answered).toBe("expired");
  expect(expired.card.questions).toHaveLength(2);
  expect(expired.card.dismissed).toBeFalsy();
  expect(decisions().some((row) => row.requestId === requestId && row.decision === "question-expired")).toBe(true);

  // an expired question takes no engine answer — it says so, in a way the
  // card can act on rather than a flat failure
  const late = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "answer", answers: ANSWERS });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("question_expired");

  // "Send as a message": the answer goes out through the ordinary composer
  // route, then the card records that it did
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, {
    threadId: bot.threadId,
    text: "Q: Which format should the report use?\nA: Summary\nQ: Which sections should it include?\nA: Intro, Findings",
  });
  expect(sent.status).toBe(202);
  const recorded = await api("POST", `/api/threads/${bot.threadId}/respond`, {
    requestId,
    behavior: "answer",
    answers: ANSWERS,
    sentAsMessage: true,
  });
  expect(recorded.status).toBe(200);
  expect(recorded.body.outcome).toBe("sent-as-message");

  const after = (await messages(bot.threadId)).find((message) => message.card?.requestId === requestId);
  expect(after.card.sentAsMessage).toBe(true);
  expect(after.card.answers).toEqual(ANSWERS);
  // recording it twice would post the answer twice
  expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "answer", answers: ANSWERS, sentAsMessage: true })).status).toBe(409);
  expect(await transcript(bot.threadId)).toContain("A: Intro, Findings");

  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
}, 60000);

it("marks a question left open by a previous run as expired, never silently dropping it", async () => {
  // An engine's wait lives only in memory, so a question still open on disk
  // after a restart can never reach the engine that asked it. It must not
  // just disappear: the owner's answer can still go out as a message.
  const bot = await makeBot("Question restart");
  const card = await ask(bot);
  const requestId = card.card.requestId;
  expect(card.card.expired).toBeFalsy();

  await fixture.restart();

  const swept = (await messages(bot.threadId)).find((message) => message.card?.requestId === requestId);
  expect(swept.card.expired).toBe(true);
  expect(swept.card.answered).toBe("expired");
  // it kept its questions, so the card can still be filled in and sent
  expect(swept.card.questions).toHaveLength(2);
  expect(swept.card.dismissed).toBeFalsy();
  expect(decisions().some((row) => row.requestId === requestId && row.decision === "question-expired")).toBe(true);
}, 60000);
