// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The stop line: the three kinds of action Full access still stops before.
// Decided by what the action TOUCHES, never by which command spelled it.
import { describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { classifyStopLine, stopLineKey, stopLineKeyCovers, type StopLinePlace } from "./stop-line.ts";

const HOME = "/Users/ada";
const CWD = "/Users/ada/Projects/site";
const place = (extra: Partial<StopLinePlace> = {}): StopLinePlace => ({
  cwd: CWD,
  roots: [CWD, "/Users/ada/.murage/workspaces/bot-1", "/tmp"],
  home: HOME,
  knownRecipients: new Set(["#general", "c0123", "boss@example.com", "github:ada/known"]),
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
  // 2026-09-24 live bug: a bot on Auto trashed a Downloads file through Finder
  ["osascript Finder delete via a variable (live regression)", ...shell(`f="/Users/owner/Downloads/Image - Removed.png"; rtk ls -la "$f" && osascript -e "tell application \\"Finder\\" to delete POSIX file \\"$f\\"" && rtk ls -la "$f" 2>&1`), "delete"],
  ["osascript Finder delete, literal path", ...shell(`osascript -e 'tell application "Finder" to delete POSIX file "/Users/ada/Desktop/a.txt"'`), "delete"],
  ["osascript move to trash", ...shell(`osascript -e 'tell application "Finder" to move POSIX file "/Users/ada/Documents/x" to trash'`), "delete"],
  ["osascript empty the trash", ...shell(`osascript -e 'tell application "Finder" to empty the trash'`), "delete"],
  ["osascript JXA delete", ...shell(`osascript -l JavaScript -e 'Application("Finder").delete(Path("/Users/ada/Desktop/a"))'`), "delete"],
  ["osascript Finder delete inside its folder", ...shell(`osascript -e 'tell application "Finder" to delete POSIX file "/Users/ada/Projects/site/tmp.txt"'`), "pass"],
  ["osascript that deletes nothing", ...shell(`osascript -e 'display notification "done"'`), "pass"],
  ["swift trashItem", ...shell(`swift -e 'import Foundation; try FileManager.default.trashItem(at: URL(fileURLWithPath: "/Users/ada/Documents/x"), resultingItemURL: nil)'`), "delete"],
  ["python os.remove through a variable", ...shell(`p=/Users/ada/Documents/x; python3 -c "import os; os.remove('$p')"`), "delete"],
  ["python send2trash inside", ...shell(`python3 -c "from send2trash import send2trash; send2trash('./old.log')"`), "pass"],
  ["rm through an assigned variable, outside", ...shell(`f="$HOME/Documents/old"; rm -rf "$f"`), "delete"],
  ["rm through an assigned variable, inside", ...shell(`d=build; rm -rf "$d"`), "pass"],
  ["export then rm", ...shell(`export T=/Users/ada/Desktop/x && rm "$T"`), "delete"],
  ["rtk rm outside", ...shell("rtk rm -rf ~/Documents/old"), "delete"],
  ["rtk proxy rm outside", ...shell("rtk proxy rm ~/Desktop/x"), "delete"],
  ["rtk rm inside", ...shell("rtk rm -rf build"), "pass"],
  // 0.1.60 Linux pass: a mktemp file is placed (in temp); any other command's output is not
  ["a variable set from mktemp is placed in temp", ...shell(`f=$(mktemp); rm "$f"`), "pass"],
  ["a variable set from another command is unknown", ...shell(`f=$(cat list.txt); rm "$f"`), "delete"],
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
  ["gh issue comment", ...shell("gh issue comment 12 --body done -R ada/site"), "message"],
  ["gh pr create", ...shell("gh pr create --title x --body y --repo ada/site"), "message"],
  ["gh pr review", ...shell("gh pr review 3 --approve -R ada/site"), "message"],
  ["gh release create", ...shell("gh release create v1.0 -R ada/site"), "message"],
  ["gh api POST a comment", ...shell("gh api repos/ada/site/issues/1/comments -f body=hi"), "message"],
  ["gh pr list is reading", ...shell("gh pr list -R ada/site"), "pass"],
  ["gh post to a repo it already posted to", ...shell("gh issue comment 1 -R Ada/Known --body x"), "pass"],
  ["plain git push is not a post", ...shell("git push origin feature"), "pass"],
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

  it("knows the home folder by its linked spelling too", () => {
    const realpath = (p: string) => p.replace(/^\/Users\/ada/, "/private/Users/ada");
    const hit = classifyStopLine("Bash", { command: "rm -rf ~/Documents/old" }, "", place({ realpath, roots: [CWD] }))!;
    expect(stopLineKey(hit)).toBe("stop:delete:/private/Users/ada/Documents/old");
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
    // a file straight in the home folder or Documents is scoped to itself
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm ~/notes.txt" }, "", place())!)).toBe("stop:delete:/Users/ada/notes.txt");
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf ~/Documents/old" }, "", place())!)).toBe("stop:delete:/Users/ada/Documents/old");
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm ~/Documents/a ~/Desktop/b" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf ~/Documents" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf /" }, "", place())!)).toBeUndefined();
    // a delete it cannot place is keyed on the command itself, never a folder
    expect(stopLineKey(classifyStopLine("Bash", { command: "rm -rf $X" }, "", place())!)).toMatch(/^stop:delete:unplaced:\[/);
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

  it("keys a gh post per repository, and reads the repository from the folder when no --repo", () => {
    const hit = classifyStopLine("Bash", { command: "gh pr comment 3 --body ok -R ada/Site" }, "", place())!;
    expect(stopLineKey(hit)).toBe("stop:public:github:ada/site");
    expect(hit.recipients).toEqual(["github:ada/site"]);
    expect(stopLineKeyCovers("stop:public:github:ada/site", hit)).toBe(true);
    expect(stopLineKeyCovers("stop:public:github:ada/other", hit)).toBe(false);
    const fromFolder = classifyStopLine("Bash", { command: "gh issue create --title t --body b" }, "", place({ repoOf: () => "ada/site" }))!;
    expect(stopLineKey(fromFolder)).toBe("stop:public:github:ada/site");
    expect(stopLineKey(classifyStopLine("Bash", { command: "gh issue create --title t" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("mcp__twitter__create_tweet", { text: "x" }, "", place())!)).toBe("stop:public:twitter");
  });

  it("gives no key when it cannot say where", () => {
    expect(stopLineKey(classifyStopLine("mcp__telegram__send_message", { text: "hi" }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("mcp__stripe__create_charge", { amount: 1 }, "", place())!)).toBeUndefined();
    expect(stopLineKey(classifyStopLine("Bash", { command: "diskutil eraseDisk APFS X disk4" }, "", place())!)).toBeUndefined();
  });
});

describe("the live Finder delete (2026-09-24)", () => {
  const command = `f="/Users/owner/Downloads/Image - Removed.png"; rtk ls -la "$f" && osascript -e "tell application \\"Finder\\" to delete POSIX file \\"$f\\"" && rtk ls -la "$f" 2>&1`;
  const home = { ...place(), home: "/Users/owner", cwd: "/Users/owner/.murage/workspaces/b/threads/t", roots: ["/Users/owner/.murage/workspaces/b/threads/t"] };

  it("names the file it would delete", () => {
    const hit = classifyStopLine("Bash", { command }, "", home)!;
    expect(hit.what).toBe("Delete 1 item outside its folder: ~/Downloads/Image - Removed.png");
  });

  it("stops under Auto, where it was auto-approved, and under Full access", () => {
    const stopLine = classifyStopLine("Bash", { command }, command, home);
    expect(autoVerdict({ autoApprove: true }, "Bash", command, { stopLine }).source).toBe("stop-line");
    expect(autoVerdict({ autoApprove: true, fullAccess: true }, "Bash", command, { stopLine }).source).toBe("stop-line");
  });
});

// Windows engines run commands in PowerShell (or cmd), where a backslash is a
// path separator, not an escape. The customer pass on 0.1.59 sent these two
// and got "$p" and a mangled "…/C:UsersownerDocuments…" instead of the file,
// so the card could only offer "Allow once".
describe("PowerShell and cmd on Windows", () => {
  const WIN_HOME = "C:\\Users\\owner";
  const WIN_CWD = "C:\\app\\data\\workspaces\\ws-1\\threads\\t-1";
  const win = (extra: Partial<StopLinePlace> = {}): StopLinePlace => ({
    cwd: WIN_CWD,
    roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
    home: WIN_HOME,
    knownRecipients: new Set(),
    ...extra,
  });
  const run = (command: string, extra?: Partial<StopLinePlace>) => classifyStopLine("shell", { command }, command, win(extra));
  // a file straight in Documents is scoped to itself, never to Documents
  const DOCS = "/C:/Users/owner/Documents/throwaway-0159.txt";
  const SITE = "/C:/Users/owner/Projects/site";

  // 0.1.60 Windows pass D1: a here-string piped to python, whose text only
  // mentions "rm trash", was read as a delete nobody could place, with only
  // Allow once. A body fed to an interpreter is judged by its real delete
  // calls; one fed to a file or a variable is data.
  describe("here-strings", () => {
    const setup = `Set-Location -LiteralPath '${WIN_CWD}'; if (-not (Test-Path -LiteralPath 'notes')) { New-Item -ItemType Directory -Path 'notes' | Out-Null }; `;
    const pyWrite = (path: string) => `@'\nwith open(r"${path}", "a") as f:\n    f.write("rm trash\\n")\n'@ | python`;
    it.each([
      ["the owner's exact repro", pyWrite("notes\\pipeline.md")],
      ["forward slash", pyWrite("notes/pipeline.md")],
      ["the Windows run's full command", setup + pyWrite("notes\\pipeline.md")],
      ["python -", `@'\nprint("rm -rf is not run here")\n'@ | python -`],
      ["a double-quoted here-string to py", `@"\nopen("notes/a.md","a").write("del stuff")\n"@ | py -3 -`],
      ["data to a file", `@'\nrm trash\nRemove-Item C:\\Users\\owner\\Documents\\x\n'@ | Set-Content -Path notes\\todo.md`],
      ["data into a variable", `$text = @'\nRemove-Item everything\n'@; $text | Out-File notes\\a.md`],
    ])("text only: %s", (_label, command) => {
      expect(run(command)).toBeNull();
    });

    it("still stops a real delete inside one", () => {
      expect(run(`@'\nimport os\nos.remove(r"C:\\Users\\owner\\Documents\\x.txt")\n'@ | python -`)).toMatchObject({ kind: "delete", what: "Delete 1 item outside its folder: ~\\Documents\\x.txt" });
      expect(run(`@'\nRemove-Item -LiteralPath "C:\\Users\\owner\\Documents\\y.txt"\n'@ | Invoke-Expression`)).toMatchObject({ kind: "delete", what: "Delete 1 item outside its folder: ~\\Documents\\y.txt" });
    });

    it("an interpreter delete it cannot place still offers this task and this routine", () => {
      const hit = run(`@'\nimport os, sys\nos.remove(sys.argv[1])\n'@ | python - $target`)!;
      expect(hit.what).toMatch(/cannot place/);
      expect(stopLineKey(hit)).toMatch(/^stop:delete:unplaced:/);
    });
  });

  it("places the variable delete the Windows run sent", () => {
    const hit = run(`$p = "C:\\Users\\owner\\Documents\\throwaway-0159.txt"; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; if (Test-Path -LiteralPath $p) { "STILL_EXISTS" } else { "DELETED" } } else { "NOT_FOUND" }`);
    expect(hit).toMatchObject({ kind: "delete", place: DOCS, what: "Delete 1 item outside its folder: ~\\Documents\\throwaway-0159.txt" });
    expect(stopLineKey(hit!)).toBe(`stop:delete:${DOCS}`);
  });

  it("places the literal delete the Windows run sent", () => {
    const hit = run(`Remove-Item -LiteralPath "C:\\Users\\owner\\Documents\\throwaway-0159.txt"`);
    expect(hit).toMatchObject({ kind: "delete", place: DOCS, what: "Delete 1 item outside its folder: ~\\Documents\\throwaway-0159.txt" });
    // Allow for this task covers the same folder, and only that folder
    const key = stopLineKey(hit!)!;
    expect(stopLineKeyCovers(key, run(`Remove-Item C:\\Users\\owner\\Documents\\throwaway-0159.txt`)!)).toBe(true);
    expect(stopLineKeyCovers(key, run(`Remove-Item "C:\\Users\\owner\\Documents\\other.txt"`)!)).toBe(false);
    const folder = stopLineKey(run(`Remove-Item -Recurse "C:\\Users\\owner\\Projects\\site\\build"`)!)!;
    expect(folder).toBe(`stop:delete:${SITE}`);
    expect(stopLineKeyCovers(folder, run(`del C:\\Users\\owner\\Projects\\site\\sub\\b.txt`)!)).toBe(true);
    expect(stopLineKeyCovers(folder, run(`del C:\\Users\\owner\\Projects\\other\\b.txt`)!)).toBe(false);
    expect(stopLineKeyCovers(folder, run(`del c:\\users\\OWNER\\projects\\site\\b.txt`)!)).toBe(true);
  });

  const places: Array<[label: string, command: string, place: string]> = [
    ["-Path with spaces in quotes", `Remove-Item -Path "C:\\Users\\owner\\My Files\\old notes.txt"`, "/C:/Users/owner/My Files"],
    ["single quotes", `Remove-Item 'C:\\Users\\owner\\Projects\\site\\a.txt' -Force`, SITE],
    ["colon-bound -LiteralPath", `Remove-Item -LiteralPath:"C:\\Users\\owner\\Projects\\site\\a.txt"`, SITE],
    ["del alias with ~", `del ~\\Projects\\site\\x.txt`, SITE],
    ["rm alias -Recurse", `rm C:\\Users\\owner\\Projects\\site\\old -Recurse -Force`, SITE],
    ["ri alias", `ri C:\\Users\\owner\\Projects\\site\\x.txt`, SITE],
    ["erase alias", `erase C:\\Users\\owner\\Projects\\site\\x.txt`, SITE],
    ["rmdir alias", `rmdir C:\\Users\\owner\\Projects\\site\\old -Recurse`, SITE],
    ["rd alias", `rd C:\\Users\\owner\\Projects\\site\\old`, SITE],
    ["$env:USERPROFILE", `Remove-Item "$env:USERPROFILE\\Projects\\site\\setup.exe"`, SITE],
    ["$HOME", `Remove-Item $HOME\\Projects\\site\\setup.exe`, SITE],
    ["-ErrorAction takes a value, not a path", `Remove-Item -ErrorAction SilentlyContinue C:\\Users\\owner\\Projects\\site\\a.txt`, SITE],
    ["cmd del with %USERPROFILE%", `cmd /c del /f /q "%USERPROFILE%\\Projects\\site\\a.txt"`, SITE],
    ["cmd rd /s", `cmd.exe /c rd /s /q C:\\Users\\owner\\Projects\\site\\old`, SITE],
    ["cmd /c with a quoted line", `cmd /c "rd /s /q C:\\Users\\owner\\Projects\\site\\old"`, SITE],
    ["[System.IO.File]::Delete", `[System.IO.File]::Delete("C:\\Users\\owner\\Projects\\site\\a.txt")`, SITE],
    ["[IO.Directory]::Delete through a variable", `$d = 'C:\\Users\\owner\\Projects\\site\\old'; [IO.Directory]::Delete($d, $true)`, SITE],
    ["Join-Path assignment", `$p = Join-Path $env:USERPROFILE "Projects\\site\\a.txt"; Remove-Item $p`, SITE],
    ["Set-Location then relative", `Set-Location C:\\Users\\owner; Remove-Item Projects\\site\\a.txt`, SITE],
    ["gci piped to Remove-Item", `Get-ChildItem "C:\\Users\\owner\\Projects\\site" -Filter *.tmp | Remove-Item`, SITE],
    ["powershell -Command", `powershell -NoProfile -Command "Remove-Item 'C:\\Users\\owner\\Projects\\site\\a.txt'"`, SITE],
    ["forward slashes", `Remove-Item C:/Users/owner/Projects/site/a.txt`, SITE],
    ["lower-case drive letter", `Remove-Item c:\\Users\\owner\\Projects\\site\\a.txt`, SITE],
  ];
  it.each(places)("places a delete outside: %s", (_label, command, expected) => {
    const hit = run(command);
    expect(hit?.kind).toBe("delete");
    expect(hit?.place).toBe(expected);
    expect(stopLineKey(hit!)).toBe(`stop:delete:${expected}`);
  });

  const passes: Array<[label: string, command: string]> = [
    ["relative inside its folder", "Remove-Item -Recurse -Force build"],
    ["dot-relative inside", "rm .\\dist -Recurse -Force"],
    ["absolute inside its thread folder", `Remove-Item -LiteralPath "C:\\app\\data\\workspaces\\ws-1\\threads\\t-1\\out.log"`],
    ["inside temp", `Remove-Item "C:\\Users\\owner\\AppData\\Local\\Temp\\murage-123" -Recurse`],
    ["inside, different letter case", `Remove-Item "c:\\APP\\data\\workspaces\\ws-1\\scratch.txt"`],
    ["cmd rd inside", `cmd /c "rd /s /q build"`],
    ["reading is not deleting", `Get-ChildItem -Path C:\\Users\\owner\\Documents -Recurse`],
    ["a string that mentions a delete", `Write-Output "Remove-Item C:\\Users\\owner\\Documents\\a.txt"`],
  ];
  it.each(passes)("passes: %s", (_label, command) => {
    expect(run(command)).toBeNull();
  });

  const unknown: Array<[label: string, command: string]> = [
    ["a variable it never saw set", "Remove-Item $target -Recurse"],
    ["a pipeline of unknown items", "Get-Content list.txt | ForEach-Object { Remove-Item $_ }"],
    ["an unknown environment variable", `Remove-Item "$env:APPDATA\\Old"`],
    ["a .Delete() method on an object", `(Get-Item "x").Delete()`],
    ["a subexpression", `Remove-Item "$(Get-Location)\\..\\x"`],
  ];
  it.each(unknown)("stops, placed only by the command itself, when it cannot read the target: %s", (_label, command) => {
    const hit = run(command);
    expect(hit?.kind).toBe("delete");
    // no folder: the card's task and routine grants cover this command only
    expect(hit?.place).toMatch(/^unplaced:\[/);
    expect(hit?.what).toMatch(/cannot place/);
  });

  it("still stops outside its folder through ..", () => {
    expect(run("Remove-Item ..\\..\\..\\other -Recurse")).toMatchObject({ kind: "delete", place: "/C:/app/data/workspaces" });
    expect(run("Remove-Item ..\\..\\build -Recurse")).toBeNull();
  });

  it("reads a PowerShell argv the engine sent as a list", () => {
    const hit = classifyStopLine("shell", { command: ["powershell.exe", "-Command", `Remove-Item "C:\\Users\\owner\\Projects\\site\\a.txt"`] }, "", win());
    expect(hit?.place).toBe(SITE);
  });

  it("keeps git, payment and message checks in PowerShell", () => {
    expect(run("git push --force origin main")?.kind).toBe("delete");
    expect(run("Invoke-RestMethod -Method Post -Uri https://api.stripe.com/v1/charges -Body @{ amount = 500 }")?.kind).toBe("pay");
    expect(run("Send-MailMessage -To stranger@example.com -Subject hi -SmtpServer smtp.example.com")?.kind).toBe("message");
  });

  it("leaves a POSIX machine's reading unchanged", () => {
    expect(classifyStopLine("Bash", { command: "rm -rf ~/Documents/old" }, "", place())).toMatchObject({ place: "/Users/ada/Documents/old", what: "Delete 1 item outside its folder: ~/Documents/old" });
  });
});

// Kessler, 2026-09-25, on Auto: three cards reading "Delete something Murage
// cannot place" over commands that only appended notes to a ledger. The
// parser split the heredoc body on its newlines and judged every line of the
// NOTES as a command, so a word like "trash" in the text, or an apostrophe
// opening a quote across lines, looked like a delete it could not place.
describe("a heredoc body is the command's input, not more commands", () => {
  const notes = [
    "## GO PACKET 14 — CLAIMED 2026-09-25T00:38Z (Kessler). Sean's Gos, relayed by Dax.",
    "",
    "Nothing relabelled, moved, marked read or deleted. Two threads were in SPAM, not trash.",
    "rm the old draft later; unlink nothing; shred nothing.",
    "| 1 | Daniel | S1 | sent |",
  ].join("\n");
  const pass = [
    `cat >> ~/notes/work/log.md <<'EOF'\n\n---\n\n${notes}\nEOF`,
    `cat > ~/notes/queue/REPORT-SENT.md <<'EOF'\n${notes}\nEOF`,
    `cd ~/notes/work && cp log.md log.md.bak && cat >> log.md <<'EOF'\n${notes}\nEOF`,
    `tee -a notes.md <<EOF\n${notes}\nEOF\necho done`,
    `cat <<-'END' > out.md\n\t${notes}\n\tEND`,
  ];
  for (const command of pass) {
    it(`lets notes through: ${command.slice(0, 40).replace(/\n/g, " ")}`, () => {
      expect(classifyStopLine("Bash", { command }, command, place())).toBeNull();
    });
  }
  it("still judges a command after the body", () => {
    const hit = classifyStopLine("Bash", { command: `cat >> notes.md <<'EOF'\n${notes}\nEOF\nrm -rf ~/Documents` }, "", place());
    expect(hit?.kind).toBe("delete");
  });
  it("still judges a body fed to code as code", () => {
    for (const command of [
      "python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/Users/ada/Documents')\nEOF",
      "bash <<'EOF'\nrm -rf ~/Documents\nEOF",
      "osascript <<'EOF'\ntell application \"Finder\" to delete POSIX file \"/Users/ada/Downloads/a.png\"\nEOF",
      "sqlite3 app.db <<'EOF'\nDELETE FROM users;\nEOF",
      "xargs rm <<'EOF'\n/Users/ada/Documents/a\nEOF",
    ]) expect(classifyStopLine("Bash", { command }, "", place())?.kind, command).toBe("delete");
  });
});

// Dax's RWA routine, 2026-09-25: a python snippet editing the pipeline
// sheet was held as "Delete something Murage cannot place" because the plain
// shell words ("rm", "trash") were searched for in the Python it fed, where
// they were only text being written. Code is judged by what it calls.
describe("a script fed to an interpreter is judged by its delete calls, not its words", () => {
  it("lets a snippet that writes notes mentioning rm and trash through", () => {
    const command = "cd ~/notes/work\npython3 - <<'PY'\np='pipeline.md'\ns=open(p).read()\ns+='\\n- moved to trash, rm the old draft later\\n'\nopen(p,'w').write(s)\nPY";
    expect(classifyStopLine("Bash", { command }, command, place())).toBeNull();
  });
  it("still stops a snippet that deletes", () => {
    const command = "python3 - <<'PY'\nimport os\nos.remove('/Users/ada/Documents/a.txt')\nPY";
    expect(classifyStopLine("Bash", { command }, command, place())?.kind).toBe("delete");
  });
});
