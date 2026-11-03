// PHONE-INTAKE-NOTICE (2026-11-03, Sean on Android, Mac 1.0.13): every
// message sent from the phone while a new bot's setup question was open
// showed "Your message was sent. It could not be added as your answer to the
// setup question." The composer sends the typed text to the setup
// conversation beside the send (POST /api/bots/:id/intake), and the
// companion's browser door forwards only the intake GETs, so from a phone
// that POST is always refused. Ruling (MurageMain): off the desktop, skip the
// alongside answer and so the notice; never widen the door.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { alongsideIntakeCard, intakePath, openIntakeCard, replyToIntake } from "./onboarding-intake";

const openCard = { id: "q1", kind: "options", card: { title: "t", subtitle: "s", options: [], intake: { step: "open", asked: 1 } } };
const transcript = [{ id: "m0", kind: "text" }, openCard];

/** The composer's send branch, as Composer.tsx runs it: which card the typed
 *  text also answers, then the alongside call and its notice. */
async function sendWhileQuestionOpen(phone: boolean) {
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => { throw new Error("403 from the door"); });
  let notice: string | null = null;
  const question = alongsideIntakeCard(openIntakeCard(transcript), phone);
  if (question) await replyToIntake("bot1", question.id, "First create a file", request, { alongside: true }).then(() => { notice = null; }, () => { notice = "INTAKE_NOT_RECORDED"; });
  return { request, notice };
}

describe("the setup question's alongside answer, by surface", () => {
  it("on the phone: no intake POST and no notice", async () => {
    const { request, notice } = await sendWhileQuestionOpen(true);
    expect(request).not.toHaveBeenCalled();
    expect(notice).toBeNull();
  });

  it("on the desktop: unchanged, the alongside answer is posted to the intake route", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => undefined);
    const question = alongsideIntakeCard(openIntakeCard(transcript), false);
    expect(question?.id).toBe("q1");
    await replyToIntake("bot1", question!.id, "First create a file", request, { alongside: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(intakePath("bot1"));
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ messageId: "q1", text: "First create a file", alongside: true });
  });

  it("on the desktop a refused answer still says so quietly (the notice is not removed there)", async () => {
    const { request, notice } = await sendWhileQuestionOpen(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(notice).toBe("INTAKE_NOT_RECORDED");
  });

  it("with no open question nothing is posted on either surface", () => {
    expect(alongsideIntakeCard(openIntakeCard([{ id: "m0", kind: "text" }]), false)).toBeNull();
    expect(alongsideIntakeCard(openIntakeCard([{ id: "m0", kind: "text" }]), true)).toBeNull();
  });

  it("Composer gates the alongside answer on the phone check, not on the error", () => {
    const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain("const question = alongsideIntakeCard(openIntakeCard(visibleMessages(bot)), isPhoneClient());");
    expect(composer).toContain('import { isPhoneClient } from "@/lib/phone-client";');
    // The notice is set only in the alongside call's failure handler, so no call means no notice.
    expect(composer.match(/setIntakeNotice\(INTAKE_NOT_RECORDED\)/g)).toHaveLength(1);
    expect(composer).toContain("if (question) replyToIntake(bot.id, question.id, requestText, api, { alongside: true })");
  });
});
