// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The stop line: the three kinds of action Full access still stops before.
// Decided by what the action TOUCHES, never by which command spelled it.
import { describe, expect, it } from "vitest";

import { classifyStopLine, stopLineKey, stopLineKeyCovers, type StopLinePlace } from "./stop-line.ts";

const HOME = "/Users/ada";
const CWD = "/Users/ada/Projects/site";
const place = (extra: Partial<StopLinePlace> = {}): StopLinePlace => ({
  cwd: CWD,
  roots: [CWD, "/Users/ada/.murage/workspaces/bot-1", "/tmp"],
  home: HOME,
  knownRecipients: new Set(["#general", "c0123", "boss@example.com"]),
  ...extra,
});

type Row = [label: string, tool: string, input: unknown, expected: "pass" | "delete" | "pay" | "message"];

const shell = (command: string): [string, unknown] => ["Bash", { command }];

const rows: Row[] = [
  // ── deleting inside the folder it works in goes ahead ──
  ["rm -rf build/ inside cwd", ...shell("rm -rf build/"), "pass"],
  ["rm -rf ./dist node_modules/.cache", ...shell("rm -rf ./dist node_modules/.cache"), "pass"],
  ["rm with absolute path inside", ...shell(`rm -f ${CWD}/tmp/out.log`), "pass"],
  ["rm glob inside", ...shell("rm -rf ./*.o build/*"), "pass"],
  ["git clean -fdx inside", ...shell("git clean -fdx"), "pass"],
  ["find -delete inside", ...shell("find ./build -name '*.map' -delete"), "pass"],
  ["rmdir inside", ...shell("rmdir empty-dir"), "pass"],
  ["rm in its own workspace", ...shell("rm /Users/ada/.murage/workspaces/bot-1/scratch.txt"), "pass"],
  ["rm in temp", ...shell("rm -rf /tmp/murage-build-123"), "pass"],
  ["chained build then clean inside", ...shell("npm run build && rm -rf .cache"), "pass"],
  ["redirects are not targets", ...shell("rm -rf build 2>/dev/null > clean.log 2>&1"), "pass"],
  ["echo of a delete is not a delete", ...shell("echo 'rm -rf ~' && git commit -m 'rm old files'"), "pass"],
  ["plain command, no delete", ...shell("ls -la ~/Documents"), "pass"],
  ["git push (not forced)", ...shell("git push origin main"), "pass"],
  ["git branch -d (safe delete)", ...shell("git branch -d feature"), "pass"],
  ["SELECT is not a drop", ...shell("psql -c 'SELECT * FROM users'"), "pass"],
  ["edit tool is not a delete", "Edit", { file_path: "/Users/ada/Documents/x.md", old_string: "a", new_string: "" }, "pass"],
  ["delete_file inside", "delete_file", { path: `${CWD}/old.txt` }, "pass"],
  // ── deleting outside it stops ──
  ["rm -rf ~/Documents", ...shell("rm -rf ~/Documents"), "delete"],
  ["rm outside with a redirect", ...shell("rm -rf ~/x 2>/dev/null"), "delete"],
  ["rm ../other", ...shell("rm ../other"), "delete"],
  ["rm -rf /", ...shell("rm -rf /"), "delete"],
  ["rm $HOME/Desktop/x", ...shell("rm $HOME/Desktop/x"), "delete"],
  ["rm -r with unknown variable target", ...shell("rm -r \"$TARGET\""), "delete"],
  ["rm with command substitution", ...shell("rm -rf $(cat list.txt)"), "delete"],
  ["rm the working folder itself", ...shell(`rm -rf ${CWD}`), "delete"],
  ["rm -rf . is the folder itself", ...shell("rm -rf ."), "delete"],
  ["rm -rf ~/* home glob", ...shell("rm -rf ~/*"), "delete"],
  ["sudo rm outside", ...shell("sudo rm -f /etc/hosts"), "delete"],
  ["rm another volume", ...shell("rm -rf /Volumes/Backup/old"), "delete"],
  ["cd then relative rm outside", ...shell("cd .. && rm -rf other"), "delete"],
  ["git -C outside clean", ...shell("git -C /Users/ada/Other clean -fdx"), "delete"],
  ["find ~ -delete", ...shell("find ~/Downloads -name '*.dmg' -delete"), "delete"],
  ["find -exec rm outside", ...shell("find /Users/ada/Documents -exec rm {} \\;"), "delete"],
  ["trash outside", ...shell("trash ~/Desktop/notes.txt"), "delete"],
  ["unlink outside", ...shell("unlink /Users/ada/.zshrc"), "delete"],
  ["mv to /dev/null", ...shell("mv ~/Documents/report.pdf /dev/null"), "delete"],
  ["mv to the Trash", ...shell("mv ~/Documents/report.pdf ~/.Trash/"), "delete"],
  ["xargs rm has no knowable target", ...shell("ls | xargs rm -rf"), "delete"],
  ["bash -c wraps an outside rm", ...shell("bash -c 'rm -rf ~/Pictures'"), "delete"],
  ["python rmtree outside", ...shell("python3 -c \"import shutil; shutil.rmtree('/Users/ada/Documents')\""), "delete"],
  ["no cwd: relative rm is unknown", "Bash", { command: "rm -rf build" }, "delete"],
  ["delete_file outside", "delete_file", { path: "/Users/ada/Documents/old.txt" }, "delete"],
  ["git push --force", ...shell("git push --force origin main"), "delete"],
  ["git push -f", ...shell("git push -f"), "delete"],
  ["git push +refspec", ...shell("git push origin +main"), "delete"],
  ["git push --delete", ...shell("git push origin --delete feature"), "delete"],
  ["git push :branch", ...shell("git push origin :feature"), "delete"],
  ["git reset --hard", ...shell("git reset --hard HEAD~3"), "delete"],
  ["git branch -D", ...shell("git branch -D feature"), "delete"],
  ["DROP TABLE in psql", ...shell("psql -c 'DROP TABLE users'"), "delete"],
  ["TRUNCATE via sql tool", "mcp__supabase__execute_sql", { project_id: "p1", query: "truncate table orders" }, "delete"],
  ["DELETE FROM via sql tool", "mcp__db__query", { sql: "DELETE FROM customers WHERE 1=1" }, "delete"],
  ["mkfs disk wipe", ...shell("mkfs.ext4 /dev/sdb1"), "delete"],
  ["diskutil eraseDisk", ...shell("diskutil eraseDisk APFS Blank disk4"), "delete"],
  ["dd onto a device", ...shell("dd if=/dev/zero of=/dev/disk2 bs=1m"), "delete"],
  ["gmail trash via MCP", "mcp__gmail__trash_message", { message_id: "m1" }, "delete"],
  ["drive delete via MCP", "mcp__google_drive__delete_file", { file_id: "f1" }, "delete"],
  ["composio gmail delete", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_DELETE_MESSAGE", account: "a", arguments: { message_id: "m1" } }] }, "delete"],
  ["gh repo delete", ...shell("gh repo delete ada/site --yes"), "delete"],
  ["removing a label is not deleting mail", "mcp__gmail__remove_label", { label: "x" }, "pass"],
  // ── paying ──
  ["stripe create_charge MCP", "mcp__stripe__create_charge", { customer: "cus_1", amount: 500 }, "pay"],
  ["stripe refund MCP", "mcp__stripe__create_refund", { charge: "ch_1" }, "pay"],
  ["paypal payout", "mcp__paypal__create_payout", { receiver: "bob@example.com" }, "pay"],
  ["composio stripe payment intent", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "STRIPE_CREATE_PAYMENT_INTENT", account: "a", arguments: { customer: "cus_9", amount: 100 } }] }, "pay"],
  ["listing charges is not paying", "mcp__stripe__list_charges", { limit: 10 }, "pass"],
  ["curl POST to stripe", ...shell("curl https://api.stripe.com/v1/charges -u $STRIPE -d amount=500 -d customer=cus_1"), "pay"],
  ["curl GET to stripe", ...shell("curl https://api.stripe.com/v1/charges -u key"), "pass"],
  ["stripe cli payout", ...shell("stripe payouts create --amount 100"), "pay"],
  ["buy something", "mcp__shop__purchase_item", { sku: "x" }, "pay"],
  // ── messaging ──
  ["slack send to existing channel", "mcp__slack__send_message", { channel: "#general", text: "hi" }, "pass"],
  ["slack send to known channel id", "mcp__slack__chat_post_message", { channel: "C0123", text: "hi" }, "pass"],
  ["slack send to new user", "mcp__slack__send_message", { channel: "@newperson", text: "hi" }, "message"],
  ["slack reply in thread", "mcp__slack__send_message", { channel: "C999", thread_ts: "123.4", text: "done" }, "pass"],
  ["email to the known boss", "mcp__gmail__send_email", { to: "Boss <boss@example.com>", subject: "x" }, "pass"],
  ["email to a new person", "mcp__gmail__send_email", { to: "stranger@example.com", subject: "x" }, "message"],
  ["email with a new cc", "mcp__gmail__send_email", { to: "boss@example.com", cc: ["new@example.com"] }, "message"],
  ["email reply in a thread", "mcp__gmail__reply_to_thread", { thread_id: "t1", body: "ok" }, "pass"],
  ["message with no recipient", "mcp__telegram__send_message", { text: "hello" }, "message"],
  ["draft is not a send", "mcp__gmail__create_draft", { to: "stranger@example.com" }, "pass"],
  ["tweet", "mcp__twitter__create_tweet", { text: "hello world" }, "message"],
  ["post publicly on linkedin", "mcp__linkedin__create_post", { text: "news" }, "message"],
  ["composio gmail send new", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "a", arguments: { recipient_email: "new@x.com" } }] }, "message"],
  ["curl to slack api", ...shell("curl -X POST https://slack.com/api/chat.postMessage -d channel=C1"), "message"],
  ["sendmail to someone", ...shell("sendmail someone@example.com < note.txt"), "message"],
  ["Murage's own peer tool is not an outside message", "mcp__agents__ask_bot", { to: "Planner", message: "hi" }, "pass"],
];

describe("classifyStopLine", () => {
  for (const [label, tool, input, expected] of rows) {
    it(`${expected === "pass" ? "passes" : `stops (${expected})`}: ${label}`, () => {
      const noCwd = label.startsWith("no cwd");
      const hit = classifyStopLine(tool, input, "", noCwd ? place({ cwd: undefined, roots: [] }) : place());
      if (expected === "pass") expect(hit, JSON.stringify(hit)).toBeNull();
      else expect(hit?.kind, label).toBe(expected);
    });
  }

  it("says in plain words what and why", () => {
    const hit = classifyStopLine("Bash", { command: "rm -rf ~/Documents/a ~/Documents/b ~/Documents/c" }, "", place())!;
    expect(hit.what).toMatch(/^Delete 3 items outside its folder: ~\/Documents\/a/);
    expect(hit.what).not.toMatch(/—/);
    expect(classifyStopLine("mcp__stripe__create_charge", { customer: "cus_1" }, "", place())!.what).toMatch(/payment/i);
    expect(classifyStopLine("mcp__gmail__send_email", { to: "new@x.com" }, "", place())!.what).toContain("new@x.com");
  });

  it("reads the command from the card summary when the tool input has none", () => {
    expect(classifyStopLine("shell", undefined, "rm -rf ~/Documents", place())?.kind).toBe("delete");
    expect(classifyStopLine("shell", undefined, "rm -rf build", place())).toBeNull();
  });

  it("a working folder that is the home folder or a disk root does not count", () => {
    expect(classifyStopLine("Bash", { command: "rm -rf Documents" }, "", place({ cwd: HOME, roots: [HOME] }))?.kind).toBe("delete");
    expect(classifyStopLine("Bash", { command: "rm -rf etc" }, "", place({ cwd: "/", roots: ["/"] }))?.kind).toBe("delete");
  });

  it("follows a link out of the folder when a resolver is given", () => {
    const realpath = (p: string) => (p.startsWith(`${CWD}/docs-link`) ? p.replace(`${CWD}/docs-link`, "/Users/ada/Documents") : p);
    expect(classifyStopLine("Bash", { command: "rm -rf docs-link/*" }, "", place({ realpath }))?.kind).toBe("delete");
  });
});

describe("stop line keys", () => {
  it("scopes a delete to the folder it touches, and covers that subtree only", () => {
    const hit = classifyStopLine("Bash", { command: "rm -rf ~/Projects/other/build" }, "", place())!;
    const key = stopLineKey(hit)!;
    expect(key).toBe("stop:delete:/Users/ada/Projects/other");
    expect(stopLineKeyCovers(key, classifyStopLine("Bash", { command: "rm ~/Projects/other/a/b.txt" }, "", place())!)).toBe(true);
    expect(stopLineKeyCovers(key, classifyStopLine("Bash", { command: "rm ~/Projects/otherwise.txt" }, "", place())!)).toBe(false);
    expect(stopLineKeyCovers(key, classifyStopLine("Bash", { command: "rm ~/Documents/x" }, "", place())!)).toBe(false);
  });

  it("never scopes a key to the home folder or a disk root", () => {
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm ~/notes.txt" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf /" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf $X" }, "", place())!)).toBeUndefined();
  });

  it("scopes a message to its recipient and a payment to its payee", () => {
    const msg = classifyStopLine("mcp__slack__send_message", { channel: "@newperson" }, "", place())!;
    expect(stopLineKey(msg)).toBe("stop:message:@newperson");
    expect(stopLineKeyCovers("stop:message:@newperson", msg)).toBe(true);
    expect(stopLineKeyCovers("stop:message:@other", msg)).toBe(false);
    const pay = classifyStopLine("mcp__stripe__create_charge", { customer: "cus_1" }, "", place())!;
    expect(stopLineKey(pay)).toBe("stop:pay:stripe:cus_1");
    expect(stopLineKeyCovers("stop:pay:stripe:cus_2", pay)).toBe(false);
  });

  it("gives no key when it cannot say where", () => {
    expect(stopLineKey(classifyStopLine("mcp__telegram__send_message", { text: "hi" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("mcp__stripe__create_charge", { amount: 1 }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "diskutil eraseDisk APFS X disk4" }, "", place())!)).toBeUndefined();
  });
});
