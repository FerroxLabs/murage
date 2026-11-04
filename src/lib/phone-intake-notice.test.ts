// PHONE-INTAKE-NOTICE (2026-11-03, Sean on Android, Mac 1.0.13): every
// message sent from the phone while a new bot's setup question was open
// showed "Your message was sent. It could not be added as your answer to the
// setup question." The composer sends the typed text to the setup
// conversation beside the send (POST /api/bots/:id/intake), and the
// companion's browser door forwards only the intake GETs, so through the door
// that POST is always refused. Ruling (MurageMain): skip the alongside answer
// where it can only fail; never widen the door.
//
// Round 2 (GrokBuild High, Astra Medium): the gate is the DOOR (surface
// "remote"), not the device. A Cloud home's paired phone reads as surface
// "desktop", its intake POST works, and it must keep recording its answer.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { intakePath, openIntakeCard, replyAlongside } from "./onboarding-intake";

const openCard = { id: "q1", kind: "options", card: { title: "t", subtitle: "s", options: [], intake: { step: "open", asked: 1 } } };
const transcript = [{ id: "m0", kind: "text" }, openCard];

const refused = () => vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => { throw new Error("403 from the door"); });
const accepted = () => vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => undefined);
const on = (answer: "desktop" | "remote") => async () => answer;

describe("the setup question's alongside answer, by door", () => {
  it("through the browser door (remote): no intake POST, so no notice", async () => {
    const request = refused();
    expect(await replyAlongside("bot1", openIntakeCard(transcript), "First create a file", request, on("remote"))).toBe("none");
    expect(request).not.toHaveBeenCalled();
  });

  it("on the desktop: the alongside answer is posted to the intake route, body unchanged", async () => {
    const request = accepted();
    expect(await replyAlongside("bot1", openIntakeCard(transcript), "First create a file", request, on("desktop"))).toBe("recorded");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(intakePath("bot1"));
    expect(request.mock.calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ messageId: "q1", text: "First create a file", alongside: true });
  });

  it("a Cloud home phone (surface desktop) still records its answer", async () => {
    const request = accepted();
    expect(await replyAlongside("bot1", openIntakeCard(transcript), "I want help with invoices", request, on("desktop"))).toBe("recorded");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("on the desktop a refused answer is reported, so the notice still shows there", async () => {
    const request = refused();
    expect(await replyAlongside("bot1", openIntakeCard(transcript), "First create a file", request, on("desktop"))).toBe("refused");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("with no open question nothing is posted and the surface is not even asked", async () => {
    const request = accepted();
    const which = vi.fn(on("desktop"));
    expect(await replyAlongside("bot1", openIntakeCard([{ id: "m0", kind: "text" }]), "hi", request, which)).toBe("none");
    expect(request).not.toHaveBeenCalled();
    expect(which).not.toHaveBeenCalled();
  });

  it("Composer gates on the surface answer, and only a refused POST sets the notice", () => {
    const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain('import { surface } from "@/lib/surface";');
    expect(composer).toContain("void replyAlongside(bot.id, question, requestText, api, surface).then((outcome) => {");
    expect(composer).toContain('else if (outcome === "refused") setIntakeNotice(INTAKE_NOT_RECORDED);');
    expect(composer.match(/setIntakeNotice\(INTAKE_NOT_RECORDED\)/g)).toHaveLength(1);
    // The device guess is gone from the send path; the door decides.
    expect(composer).not.toContain("isPhoneClient");
    expect(composer).not.toMatch(/replyToIntake\(/);
    // The send is dispatched before, and independent of, the alongside answer.
    expect(composer.indexOf('type: "send",')).toBeLessThan(composer.indexOf("void replyAlongside("));
  });
});
