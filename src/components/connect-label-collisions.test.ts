// One confirmed label form for every sign-in (#758), and labels that do not
// collide: the form fills in the first label no account on the app holds
// yet, and a label the server still refuses as taken is said on the form,
// where it can be changed, instead of as a general failure.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

const {
  CONNECT_APP_DEFAULT_LABEL,
  CONNECT_APP_LABEL_TAKEN,
  confirmedConnectLabel,
  connectLabelTaken,
  firstFreeConnectLabel,
  readConnectAppStatus,
} = await import("@/lib/connect-app");
const { ConnectLabelFormView, connectLabelProblem } = await import("./ConnectLabelForm");
const { FirstRunConnectView } = await import("./FirstRunJobsCard");
const { connectorCardAppName, connectorCardAuthorizeBody, connectorCardInitialLabel } = await import("./ConnectorCard");

function findElement(node: ReactNode, match: (el: ReactElement<any>) => boolean): ReactElement<any> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<any>;
  if (match(el)) return el;
  return findElement(el.props?.children, match);
}

const active = (alias: string) => ({ alias, status: "ACTIVE" });

describe("the first free label", () => {
  it("is personal when nothing holds it", () => {
    expect(CONNECT_APP_DEFAULT_LABEL).toBe("personal");
    expect(firstFreeConnectLabel(undefined)).toBe("personal");
    expect(firstFreeConnectLabel([])).toBe("personal");
    expect(firstFreeConnectLabel([active("work")])).toBe("personal");
  });

  it("skips a label an account already uses, without case", () => {
    expect(firstFreeConnectLabel([active("Personal")])).toBe("personal 2");
    expect(firstFreeConnectLabel([active("personal"), { alias: "personal 2", status: "INITIATED" }])).toBe("personal 3");
    expect(firstFreeConnectLabel([active("Work")], "work")).toBe("work 2");
  });

  it("counts a failed or expired attempt as free, as the harness clears those", () => {
    expect(firstFreeConnectLabel([{ alias: "personal", status: "FAILED" }, { alias: "personal 2", status: "expired" }])).toBe("personal");
  });

  it("stays inside the label length", () => {
    const long = "x".repeat(64);
    const label = firstFreeConnectLabel([active(long)], long);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith(" 2")).toBe(true);
    expect(confirmedConnectLabel(label)).toBe(label);
  });

  it("reads the labels the status route already reports", async () => {
    const request = async () => ({
      services: { gmail: { connected: true, accounts: [{ id: "a", alias: "personal", status: "ACTIVE" }, { id: "b" }] } },
    });
    const status = await readConnectAppStatus("gmail", request);
    expect(status?.accounts).toEqual([{ alias: "personal", status: "ACTIVE" }]);
    expect(firstFreeConnectLabel(status?.accounts)).toBe("personal 2");
  });
});

describe("a label the server refuses as taken", () => {
  const clash = Object.assign(new Error('Account alias "personal" is already in use for gmail'), { status: 409 });

  it("is told apart from every other failure", () => {
    expect(connectLabelTaken(clash)).toBe(true);
    expect(connectLabelTaken(Object.assign(new Error("Couldn't start the Gmail sign-in. Try again."), { status: 409 }))).toBe(false);
    expect(connectLabelTaken(Object.assign(new Error(clash.message), { status: 400 }))).toBe(false);
    expect(connectLabelTaken(new Error(clash.message))).toBe(false);
  });

  it("is said on the form while the field still holds it, and not after it changes", () => {
    expect(CONNECT_APP_LABEL_TAKEN).toBe("That label is already in use. Try another.");
    expect(connectLabelProblem({ problem: "", draft: "Personal ", takenLabel: "personal" })).toBe(CONNECT_APP_LABEL_TAKEN);
    expect(connectLabelProblem({ problem: "", draft: "home", takenLabel: "personal" })).toBe("");
    const form = (draft: string) => renderToStaticMarkup(ConnectLabelFormView({
      id: "gmail", service: "Gmail", initial: "personal", busy: false, takenLabel: "personal",
      onConfirm: () => {}, onCancel: () => {}, draft, setDraft: () => {}, problem: "", setProblem: () => {},
    }));
    expect(form("personal")).toContain(`role="alert" class="mt-1 text-[12.5px] text-danger">${CONNECT_APP_LABEL_TAKEN}</p>`);
    expect(form("personal")).toContain('aria-invalid="true"');
    expect(form("home")).not.toContain(CONNECT_APP_LABEL_TAKEN);
  });

  it("still confirms a new label from the same form", () => {
    const confirmed: string[] = [];
    const view = ConnectLabelFormView({
      id: "gmail", service: "Gmail", initial: "personal", busy: false, takenLabel: "personal",
      onConfirm: (alias) => confirmed.push(alias), onCancel: () => {}, draft: " home ", setDraft: () => {}, problem: "", setProblem: () => {},
    });
    findElement(view, (el) => el.type === "form")!.props.onSubmit({ preventDefault() {} });
    expect(confirmed).toEqual(["home"]);
  });
});

describe("the first-run connect screen fills in a free label", () => {
  const screen = {
    heading: "One thing first",
    lead: "Connect it and I can start.",
    rows: [{ need: "gmail" as const, bold: "Gmail", small: "so I can read your mail" }],
    skipToInput: null,
    elsewhere: "Something else",
    appsUnreadable: false,
  };
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(FirstRunConnectView, {
      screen, busy: "", failure: "", desktop: true, onConnect: () => {}, onSkipToInput: () => {}, onElsewhere: () => {},
      labelling: "gmail", ...extra,
    } as never));

  it("with the label it is given, and personal when it knows no accounts", () => {
    expect(render({ labelInitial: "personal 2" })).toContain('value="personal 2"');
    expect(render({})).toContain('value="personal"');
  });

  it("says a refused label on the form, not as the screen's failure line", () => {
    const markup = render({ labelInitial: "personal", takenLabel: "personal" });
    expect(markup).toContain(CONNECT_APP_LABEL_TAKEN);
    expect(markup).not.toContain("is already in use for");
  });
});

describe("the chat connect card asks for the label like everywhere else", () => {
  it("fills in the bot's suggestion only as a free label, and personal without one", () => {
    expect(connectorCardInitialLabel({ status: "required" }, [])).toBe("personal");
    expect(connectorCardInitialLabel({ status: "required", alias: "Work" }, [])).toBe("Work");
    expect(connectorCardInitialLabel({ status: "required", alias: "Work" }, [active("work")])).toBe("Work 2");
    expect(connectorCardInitialLabel({ status: "required" }, [active("personal")])).toBe("personal 2");
  });

  it("keeps a label the person already confirmed for Open again and Try again", () => {
    expect(connectorCardInitialLabel({ status: "authorizing", alias: "Home 2" }, [active("Home 2")])).toBe("Home 2");
    expect(connectorCardInitialLabel({ status: "failed", alias: "Home" }, undefined)).toBe("Home");
  });

  it("authorizes only with a confirmed label", () => {
    expect(JSON.parse(connectorCardAuthorizeBody("t1", confirmedConnectLabel(" home ")!))).toEqual({ threadId: "t1", alias: "home" });
    // @ts-expect-error the bot's suggestion, or any string nobody confirmed, does not fit
    connectorCardAuthorizeBody("t1", "Work");
  });

  it("names the app, not the label, in the form", () => {
    expect(connectorCardAppName({ label: "Gmail (Work)", alias: "Work" })).toBe("Gmail");
    expect(connectorCardAppName({ label: "Gmail" })).toBe("Gmail");
  });
});
