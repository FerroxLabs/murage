// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDOMHarness, mount } from "../testing/dom-harness";
import { QuestionCard } from "./QuestionCard";
import type { Message } from "../state/store";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({ ...await original<object>(), useStore: () => ({ dispatch }) }));
let cleanup: () => void;
beforeEach(() => { cleanup = installDOMHarness(); dispatch.mockClear(); });
afterEach(() => cleanup());
const questions = [0, 1, 2, 3].map((i) => ({
  id: `q.${i}`, handle: `q.${i}`, question: `Question ${i + 1}`, multiSelect: i === 1,
  allowOther: i >= 2, secret: i === 3,
  options: i < 2 ? [0, 1].map((j) => ({ handle: `o.${i}.${j}`, label: `Option ${j + 1}` })) : [],
}));
function message(extra = {}): Message {
  return { id: "card-1", role: "bot", kind: "options", at: 1, card: {
    title: "Questions", subtitle: "Choose", options: [], requestId: "q.card-1", requestHandle: "q.card-1", questions,
    ...extra,
  } } as Message;
}
const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
}
describe("F8 question handles", () => {
  it("four-question submit sends one DisplayAction with byte-identical Other", () => {
    const { container } = mount(createElement(QuestionCard, { message: message(), threadId: "t1", botId: "b1" }));
    click(container.querySelectorAll('[role="radio"]')[0]!);
    const checks = container.querySelectorAll('[role="checkbox"]');
    click(checks[1]!); click(checks[0]!);
    const inputs = container.querySelectorAll("input");
    type(inputs[0]!, "  owner words\t "); type(inputs[1]!, "  private bytes  ");
    click(button(container, "Send answer"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].displayAction).toEqual({ requestHandle: "q.card-1", action: "answer", answers: [
      { questionHandle: "q.0", optionHandles: ["o.0.0"] },
      { questionHandle: "q.1", optionHandles: ["o.1.0", "o.1.1"] },
      { questionHandle: "q.2", optionHandles: [], other: "  owner words\t " },
      { questionHandle: "q.3", optionHandles: [], other: "  private bytes  " },
    ] });
  });
  it("expired card send-as-message uses stored-card handles", () => {
    const { container } = mount(createElement(QuestionCard, { message: message({ expired: true, questions: questions.slice(0, 1) }), threadId: "t1", groupId: "g1" }));
    click(container.querySelector('[role="radio"]')!);
    click(button(container, "Send as a message"));
    expect(dispatch.mock.calls[0]![0].displayAction).toEqual({ requestHandle: "q.card-1", action: "answer", sentAsMessage: true, answers: [{ questionHandle: "q.0", optionHandles: ["o.0.0"] }] });
  });
  it("identical masked labels remain distinct selectable options", () => {
    const masked = { ...questions[0]!, options: [{ handle: "o.0.0", label: "«redacted»" }, { handle: "o.0.1", label: "«redacted»" }] };
    const { container } = mount(createElement(QuestionCard, { message: message({ questions: [masked] }), threadId: "t1", botId: "b1" }));
    click(container.querySelectorAll('[role="radio"]')[1]!);
    expect(dispatch.mock.calls[0]![0].displayAction.answers).toEqual([{ questionHandle: "q.0", optionHandles: ["o.0.1"] }]);
  });
  it("secret and folder-trust expired cards retain the late-answer restriction", () => {
    for (const extra of [{ questions: questions.slice(3) }, { folderTrust: { key: "safe", folder: "safe", sources: [] } }]) {
      const view = mount(createElement(QuestionCard, { message: message({ expired: true, ...extra }), threadId: "t1" }));
      expect(view.container.textContent).not.toContain("Send as a message"); view.unmount();
    }
  });
});
