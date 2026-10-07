// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins a local fake engine and inert shadow
// entries so the suite is deterministic with or without agent CLIs installed
// and exercises the shadow-instance behavior end to end.
// Part 2 of 4.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readBotPackageArchive } from "./bot-package-archive.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSse } from "./testing/sse.ts";
import { connectorSystemPrompt, requiredAppsSystemPrompt } from "./composio.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseBotPackage } from "./bot-package.ts";
import { BASE, DESKTOP_HEADERS, PAIRED_PHONE, SERVER_DIR, STATE_ONLY_SELECTION, api, delayedJsonBody, desktopApi, fakeClaudeDump, home, readJsonFileWhenReady, startInternalFixtureTurn } from "./testing/index-harness.ts";


describe("harness HTTP API", () => {
  it("exports every visible bot and imports the team without creating a room", async () => {
    const first = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const second = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const hidden = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    await desktopApi("PATCH", `/api/bots/${first.id}`, {
      name: "Mira",
      title: "Project Lead",
      description: "Coordinates the crew",
      color: "purple",
      mascotExpression: "focused",
      autoApprove: true,
      // AUTOOP2: a bot that never chose a computer mounts this Mac, so profile-level Auto needs the acknowledgement (harmless elsewhere).
      acknowledgeLocalAuto: true,
      alwaysAllow: ["Bash:git"],
    });
    await desktopApi("PATCH", `/api/bots/${second.id}`, {
      name: "Scout",
      title: "Researcher",
      description: "Finds evidence",
      color: "cyan",
    });
    await desktopApi("PATCH", `/api/bots/${hidden.id}`, { name: "Archived", hidden: true });

    const stateBefore = (await api("GET", "/api/bots")).body;
    const roomsBefore = stateBefore.groups.length;
    const visibleNames = stateBefore.bots
      .filter((bot: { hidden?: boolean }) => !bot.hidden)
      .map((bot: { name: string }) => bot.name);
    const exported = await desktopApi("POST", "/api/teams/export", { name: "Field Team" });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: "murage.team", version: 2, team: { name: "Field Team" } });
    expect(exported.body.team.members.map((member: { name: string }) => member.name)).toEqual(visibleNames);
    expect(exported.body.team.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mira", name: "Mira", title: "Project Lead", appearance: { color: "purple", mascotExpression: "focused" } }),
      expect.objectContaining({ key: "scout", name: "Scout", title: "Researcher", appearance: { color: "cyan" } }),
    ]));
    expect(exported.body.team).not.toHaveProperty("room");
    expect(JSON.stringify(exported.body)).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    const options = await desktopApi("POST", "/api/teams/export", { name: "Field Team", format: "package", action: "options" });
    expect(options.status).toBe(200);
    const selection = {
      botIds: options.body.bots.map((bot: { id: string }) => bot.id),
      playbookKeys: options.body.playbooks.map((playbook: { key: string }) => playbook.key),
      routineIds: options.body.routines.filter((routine: { supported: boolean }) => routine.supported).map((routine: { id: string }) => routine.id),
    };
    const preview = await desktopApi("POST", "/api/teams/export", { name: "Field Team", format: "package", action: "preview", selection });
    expect(preview.status).toBe(200);
    expect(preview.body.scan.blocked).toBe(false);
    const markdownExport = await desktopApi("POST", "/api/teams/export", { name: "Field Team", format: "package", action: "download", selection, previewHash: preview.body.previewHash, acknowledgeWarnings: true });
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.body).toMatchObject({ name: "Field Team", members: visibleNames.length });
    expect(markdownExport.body.markdown).toContain("## Activation");
    // 863cb947: exported Markdown is an inert blueprint; it never appoints the reader.
    expect(markdownExport.body.markdown).toContain("Selected bot blueprint");
    expect(markdownExport.body.markdown).not.toContain("Give this file to your Chief of Staff");
    expect(markdownExport.body.markdown).not.toContain("You are the Chief of Staff");
    expect(markdownExport.body.markdown).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);
    expect((await desktopApi("POST", "/api/teams/export", {})).body.team.name).toBe("My Murage Team");

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const imported = await desktopApi("POST", "/api/teams/import", exported.body);
      expect(imported.status).toBe(201);
      // the originals still exist, so every member arrives visibly numbered
      // rather than wearing a name that already resolves to another bot. The
      // starter name is intentionally random, so it can duplicate a member
      // name and advance that member to the next available suffix.
      const importedNames = imported.body.bots.map((bot: { name: string }) => bot.name);
      const namesBefore = new Set(stateBefore.bots.map((bot: { name: string }) => bot.name.toLowerCase()));
      expect(importedNames).toHaveLength(visibleNames.length);
      expect(new Set(importedNames.map((name: string) => name.toLowerCase())).size).toBe(importedNames.length);
      for (const [index, name] of importedNames.entries()) {
        const base = visibleNames[index]!;
        expect(name.startsWith(`${base} `)).toBe(true);
        expect(Number(name.slice(base.length + 1))).toBeGreaterThanOrEqual(2);
        expect(namesBefore.has(name.toLowerCase())).toBe(false);
      }
      expect(imported.body.bots.every((bot: { id: string }) => ![first.id, second.id].includes(bot.id))).toBe(true);
      expect(imported.body.bots[0]).not.toHaveProperty("alwaysAllow");
      // imported bots arrive quiet and without reach: no seeded greeting
      // in their name, and no access to the workspace's connected apps
      // until the user grants it per bot
      expect(imported.body.bots.every((bot: { messages: unknown[] }) => bot.messages.length === 0)).toBe(true);
      expect(imported.body.bots.every((bot: { composio?: boolean }) => bot.composio === false)).toBe(true);
      expect(imported.body).not.toHaveProperty("group");

      const lastImported = imported.body.bots.at(-1)!;
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === lastImported.id);
      const importedBotIds = new Set(imported.body.bots.map((bot: { id: string }) => bot.id));
      const importFrames = stream.frames.filter(
        (frame) => frame.kind === "bot" && importedBotIds.has(frame.bot?.id),
      );
      // every imported bot is announced to other windows. The store emits
      // on every write now, so a bot may produce more than one frame —
      // the invariant is coverage, not an exact count.
      for (const id of importedBotIds) expect(importFrames.some((frame) => frame.bot?.id === id)).toBe(true);
      expect(importFrames.every((frame) => frame.kind === "bot")).toBe(true);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const invalid = await desktopApi("POST", "/api/teams/import", { ...exported.body, version: 3 });
      expect(invalid.status).toBe(400);
      expect((await desktopApi("POST", "/api/teams/import?mode=erase", exported.body)).status).toBe(400);

      const beforeReplace = (await api("GET", "/api/bots")).body.bots.filter(
        (bot: { hidden?: boolean }) => !bot.hidden,
      );
      const replaced = await desktopApi("POST", "/api/teams/import?mode=replace", exported.body);
      expect(replaced.status).toBe(201);
      expect(replaced.body.archived.map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace.map((bot: { id: string }) => bot.id).sort(),
      );
      expect(replaced.body.archivedBots.every((bot: { hidden?: boolean }) => bot.hidden)).toBe(true);
      const afterReplace = (await api("GET", "/api/bots")).body.bots;
      expect(afterReplace.filter((bot: { hidden?: boolean }) => !bot.hidden).map((bot: { id: string }) => bot.id).sort()).toEqual(
        replaced.body.bots.map((bot: { id: string }) => bot.id).sort(),
      );
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      // Put the shared test harness back exactly as it was before exercising
      // replace. This mirrors the UI's Undo action and preserves the seeded bot.
      for (const bot of replaced.body.bots) await desktopApi("DELETE", `/api/bots/${bot.id}`);
      for (const bot of replaced.body.archived.filter((item: { chiefOfStaff: boolean }) => !item.chiefOfStaff)) {
        await desktopApi("PATCH", `/api/bots/${bot.id}`, { hidden: false });
      }
      const previousChief = replaced.body.archived.find((bot: { chiefOfStaff: boolean }) => bot.chiefOfStaff);
      if (previousChief) await desktopApi("PATCH", `/api/bots/${previousChief.id}`, { hidden: false, chiefOfStaff: true });

      for (const bot of [first, second, hidden, ...imported.body.bots]) {
        expect((await desktopApi("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      }
    } finally {
      stream.close();
    }
  });

  it("selective package export includes only chosen bots and paused routines and rejects stale previews", async () => {
    const selected = (await desktopApi("POST", "/api/bots", { name: "Portable Scout", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const omitted = (await desktopApi("POST", "/api/bots", { name: "Unselected Writer", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    let routineId: string | undefined;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${selected.id}`, { description: "Selected research instructions." })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${omitted.id}`, { description: "UNSELECTED-INSTRUCTION-MARKER" })).status).toBe(200);
      const routine = await desktopApi("POST", "/api/routines", { name: "Portable future check", prompt: "Check the selected work.", target: "bot", botId: selected.id, runOn: "ember", enabled: true, schedule: { type: "once", at: Date.now() + 86_400_000 } });
      expect(routine.status).toBe(201);
      routineId = routine.body.routine.id;
      const options = await desktopApi("POST", "/api/teams/export", { format: "package", action: "options" });
      expect(options.status).toBe(200);
      expect(options.body.routines).toEqual(expect.arrayContaining([expect.objectContaining({ id: routineId, supported: true })]));
      const selection = { botIds: [selected.id], playbookKeys: [], routineIds: [routineId] };
      const request = { format: "package", name: "Selected package", selection };
      const preview = await desktopApi("POST", "/api/teams/export", { ...request, action: "preview" });
      expect(preview.status).toBe(200);
      expect(preview.body.summary).toEqual({ agents: 1, playbooks: 0, routines: 1 });
      expect(preview.body.markdown).not.toContain("UNSELECTED-INSTRUCTION-MARKER");
      const parsed = parseBotPackage(preview.body.markdown);
      expect(parsed.package.agents.map((bot) => bot.name)).toEqual(["Portable Scout"]);
      expect(parsed.package.routines).toHaveLength(1);
      expect(parsed.package.routines![0]!.enabledAfterInstall).toBe(false);
      expect((await desktopApi("POST", "/api/teams/export", { ...request, action: "download", previewHash: preview.body.previewHash })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${selected.id}`, { description: "Changed selected instructions." })).status).toBe(200);
      const stale = await desktopApi("POST", "/api/teams/export", { ...request, action: "download", previewHash: preview.body.previewHash });
      expect(stale.status).toBe(409);
      expect(stale.body.markdown).toBeUndefined();
      const fresh = await desktopApi("POST", "/api/teams/export", { ...request, action: "preview" });
      expect(fresh.body.previewHash).not.toBe(preview.body.previewHash);
    } finally {
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`);
      for (const bot of [selected, omitted]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("exports selected installed skill files as a reviewed ZIP through the actual API", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "ZIP Scout", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const root = mkdtempSync(join(home, "zip-export-api-"));
    const workspace = join(home, ".murage", "workspaces", bot.id);
    const skillRoot = join(workspace, "skills", "research");
    const markdown = "---\nname: research\ndescription: Review supplied notes.\nlicense: MIT\n---\nUse the supplied notes.\n";
    try {
      mkdirSync(join(skillRoot, "references"), { recursive: true });
      writeFileSync(join(skillRoot, "SKILL.md"), markdown);
      const supporting = join(skillRoot, "references", "guide.md");
      writeFileSync(supporting, "Selected supporting instructions.");
      writeFileSync(join(workspace, "MEMORY.md"), "UNSELECTED_PRIVATE_MEMORY");
      const stateRoot = join(home, ".murage", "skill-state", bot.id);
      mkdirSync(stateRoot, { recursive: true });
      writeFileSync(join(stateRoot, "skills.json"), JSON.stringify({ research: {
        description: "Review supplied notes.", enabled: false, source: "fixture", sha256: createHash("sha256").update(markdown).digest("hex"),
        importedAt: new Date().toISOString(), license: "MIT", warnings: [], skippedFiles: [],
      } }));
      expect((await api("POST", "/api/packages/export", { action: "options" })).status).toBe(404);
      const options = await desktopApi("POST", "/api/packages/export", { action: "options" });
      expect(options.status).toBe(200);
      expect(options.body.skills).toContainEqual(expect.objectContaining({ id: `${bot.id}:research`, botId: bot.id, dependencies: null }));
      const request = { name: "ZIP fixture", selection: { botIds: [bot.id], playbookKeys: [], routineIds: [], skillIds: [`${bot.id}:research`] } };
      const preview = await desktopApi("POST", "/api/packages/export", { ...request, action: "preview" });
      expect(preview.status).toBe(200);
      expect(preview.body.scan.blocked).toBe(false);
      expect(preview.body.reviewWarnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(preview.body)).not.toContain("UNSELECTED_PRIVATE_MEMORY");
      const download = { ...request, action: "download", previewHash: preview.body.previewHash };
      expect((await desktopApi("POST", "/api/packages/export", download)).status).toBe(409);
      const response = await fetch(`${BASE}/api/packages/export`, { method: "POST", headers: { ...DESKTOP_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ ...download, acknowledgeWarnings: true }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      const archive = join(root, "download.zip");
      writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      const intake = await readBotPackageArchive(archive);
      expect([...intake.payloads.keys()].sort()).toEqual(["skills/research/SKILL.md", "skills/research/references/guide.md"]);
      expect(intake.payloads.get("skills/research/references/guide.md")?.toString()).toBe("Selected supporting instructions.");
      expect(intake.manifest.definition.package.agents[0].skills).toEqual(["research"]);
      const importOptions = await desktopApi("POST", "/api/packages/import", { action: "options", archivePath: archive });
      expect(importOptions.status).toBe(200);
      expect(importOptions.body.scan.blocked).toBe(false);
      writeFileSync(supporting, "Changed supporting instructions.");
      expect((await desktopApi("POST", "/api/packages/export", { ...download, acknowledgeWarnings: true })).status).toBe(409);
      writeFileSync(supporting, "Bearer fake_secret_canary_1234567890");
      const blocked = await desktopApi("POST", "/api/packages/export", { ...request, action: "preview" });
      expect(blocked.status).toBe(200);
      expect(blocked.body.scan.blocked).toBe(true);
      expect(JSON.stringify(blocked.body)).not.toContain("fake_secret_canary");
      expect((await desktopApi("POST", "/api/packages/export", { ...download, previewHash: blocked.body.previewHash, acknowledgeWarnings: true })).status).toBe(422);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selective package export blocks embedded credentials without returning preview markdown", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Credential scanner fixture", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const fakeToken = "sk-" + "FixtureOnlyNotARealCredential".repeat(2);
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { description: `Do not share this fake token: ${fakeToken}` })).status).toBe(200);
      const request = { format: "package", name: "Scanner fixture", selection: { botIds: [bot.id], playbookKeys: [], routineIds: [] } };
      const preview = await desktopApi("POST", "/api/teams/export", { ...request, action: "preview" });
      expect(preview.status).toBe(200);
      expect(preview.body.scan.blocked).toBe(true);
      expect(preview.body.markdown).toBeUndefined();
      expect(JSON.stringify(preview.body)).not.toContain(fakeToken);
      const download = await desktopApi("POST", "/api/teams/export", { ...request, action: "download", previewHash: preview.body.previewHash, acknowledgeWarnings: true });
      expect(download.status).toBe(422);
      expect(download.body.markdown).toBeUndefined();
      expect(JSON.stringify(download.body)).not.toContain(fakeToken);
      const legacy = await desktopApi("POST", "/api/teams/export", { name: "Legacy credential fixture" });
      expect(legacy.status).toBe(422);
      expect(legacy.body.team).toBeUndefined();
      expect(JSON.stringify(legacy.body)).not.toContain(fakeToken);
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("selective package export requires desktop authority and explicit acknowledgement of ambiguous warnings", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Warning scanner fixture", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { description: "Example source location: /Users/fixture/private-source" })).status).toBe(200);
      const request = { format: "package", name: "Warning fixture", selection: { botIds: [bot.id], playbookKeys: [], routineIds: [] } };
      for (const action of ["options", "preview", "download"]) {
        const denied = await api("POST", "/api/teams/export", { ...request, action });
        expect(denied.status).toBe(404);
        expect(denied.body.markdown).toBeUndefined();
      }
      expect((await desktopApi("POST", "/api/teams/export", { format: "package" })).status).toBe(400);
      const preview = await desktopApi("POST", "/api/teams/export", { ...request, action: "preview" });
      expect(preview.status).toBe(200);
      expect(preview.body.scan).toMatchObject({ blocked: false, reviewRequired: true });
      const download = { ...request, action: "download", previewHash: preview.body.previewHash };
      expect((await desktopApi("POST", "/api/teams/export", download)).status).toBe(409);
      const acknowledged = await desktopApi("POST", "/api/teams/export", { ...download, acknowledgeWarnings: true });
      expect(acknowledged.status).toBe(200);
      expect(acknowledged.body.markdown).toContain("/Users/fixture/private-source");
      const legacy = await desktopApi("POST", "/api/teams/export", { name: "Legacy warning fixture" });
      expect(legacy.status).toBe(422);
      expect(legacy.body.team).toBeUndefined();
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("imports a team as a project: one room, on a folder", async () => {
    // The manifest still describes only people. Room name and folder come
    // from the CALLER, so a manifest fetched from the library cannot create
    // structure in someone's workspace — the property v2 established by
    // dropping its `room` block.
    const seed = await desktopApi("POST", "/api/bots", { name: "Planner", title: "Lead", description: "Plans", color: "purple" });
    const exported = await desktopApi("POST", "/api/teams/export", { name: "Client XY" });
    expect(exported.body.team).not.toHaveProperty("room");

    const roomsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const folder = mkdtempSync(join(tmpdir(), "murage-project-"));

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");

      // A folder that does not exist must not leave half a project behind.
      const bogus = await desktopApi("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(join(folder, "nope"))}`, exported.body);
      expect(bogus.status).toBe(400);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const created = await desktopApi("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}`, exported.body);
      expect(created.status).toBe(201);
      expect(created.body.group).toMatchObject({ name: "Client XY", cwd: folder });
      // the room is made of exactly the bots this import created
      expect(created.body.group.memberIds.sort()).toEqual(created.body.bots.map((bot: { id: string }) => bot.id).sort());
      // the folder is the room's WISH; the store pins it on the first turn
      expect(created.body.group).not.toHaveProperty("pinnedCwd");
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore + 1);
      await stream.until((frame) => frame.kind === "group" && frame.group?.id === created.body.group.id);

      // an explicit name wins over the team name, and the folder is optional
      const named = await desktopApi("POST", "/api/teams/import?mode=project&room=Client%20XY%20-%20Ads", exported.body);
      expect(named.body.group).toMatchObject({ name: "Client XY - Ads" });
      expect(named.body.group.cwd).toBeUndefined();

      for (const room of [created.body.group, named.body.group]) {
        expect((await desktopApi("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
      }
      for (const bot of [seed.body, ...created.body.bots, ...named.body.bots]) {
        await desktopApi("DELETE", `/api/bots/${bot.id}`);
      }
    } finally {
      stream.close();
    }
  });

  it("installs a complete bot package with a Chief, room, playbook, connector intent, and paused routine", async () => {
    const packageFile = {
      format: "murage.package",
      version: 1,
      package: {
        id: "signal-desk",
        release: "1.0.0",
        name: "Signal Desk",
        tagline: "Find and explain the signal.",
        summary: "A complete two-bot signal workflow.",
        category: "Research",
        author: { name: "Murage" },
        license: "MIT",
        outcomes: ["Produce a concise signal brief."],
        setupMinutes: 4,
        requirements: {
          apps: [{ slug: "reddit", label: "Reddit", reason: "Read approved communities." }],
          capabilities: ["computer"],
        },
        agents: [
          {
            key: "scout",
            name: "Package Scout",
            title: "Researcher",
            description: "Find evidence.",
            appearance: { color: "cyan" },
            playbooks: ["signal-check"],
            autoApprove: true,
          },
          {
            key: "editor",
            name: "Package Editor",
            title: "Editor",
            description: "Explain the result.",
            appearance: { color: "green" },
          },
        ],
        chiefOfStaff: "scout",
        rooms: [{
          key: "signals",
          name: "Signal Room",
          members: ["scout", "editor"],
          bulletin: "Separate direct evidence from inference.",
          defaultResponder: { kind: "agent", agent: "scout" },
        }],
        routines: [{
          key: "morning-signals",
          name: "Morning signals",
          agent: "scout",
          prompt: "Prepare the approved morning signal brief.",
          runOn: "ember",
          schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
        playbooks: [{
          key: "signal-check",
          name: "Signal Check",
          summary: "Verify a public signal.",
          triggers: ["signal brief"],
          instructions: "Keep the source URL and confidence.",
        }],
      },
    };

    const installed = await desktopApi("POST", "/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    expect(installed.body.bots).toHaveLength(2);
    expect(installed.body.groups).toHaveLength(1);
    expect(installed.body.routines).toHaveLength(1);

    const scout = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Scout"));
    const editor = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Editor"));
    expect(scout).toMatchObject({
      chiefOfStaff: true,
      composio: false,
      playbooks: [{ key: "signal-check", instructions: "Keep the source URL and confidence." }],
      installedPackage: {
        id: "signal-desk",
        release: "1.0.0",
        requiredApps: [{ slug: "reddit", label: "Reddit", reason: "Read approved communities." }],
      },
    });
    expect(scout).not.toHaveProperty("autoApprove");
    expect(editor.playbooks).toBeUndefined();
    expect(scout.section).toBe(editor.section);
    expect(installed.body.groups[0]).toMatchObject({
      name: "Signal Room",
      memberIds: expect.arrayContaining([scout.id, editor.id]),
      defaultResponder: { kind: "member", botId: scout.id },
      bulletin: "Separate direct evidence from inference.",
      setupCompletedAt: expect.any(Number),
    });
    expect(installed.body.routines[0]).toMatchObject({
      name: "Morning signals",
      botId: scout.id,
      enabled: false,
      nextRunAt: null,
    });

    await desktopApi("DELETE", `/api/routines/${installed.body.routines[0].id}`);
    await desktopApi("DELETE", `/api/groups/${installed.body.groups[0].id}`);
    for (const bot of installed.body.bots) await desktopApi("DELETE", `/api/bots/${bot.id}`);
  });

  // A bad skill id must not sink a nine-bot import — and it did not, but
  // the only trace was a console line in the harness's own stderr, so the
  // user was told the import succeeded and quietly got fewer skills than
  // the profile advertised. The failure now rides back on the response.
  it("reports the skills a package import could not deliver", async () => {
    const packageOf = (skills: string[]) => ({
      format: "murage.package",
      version: 1,
      package: {
        id: "short-desk",
        release: "1.0.0",
        name: "Short Desk",
        tagline: "A profile that asks for more than it gets.",
        summary: "One bot, one impossible skill.",
        category: "Work",
        author: { name: "Murage" },
        license: "MIT",
        outcomes: ["Do the work."],
        setupMinutes: 1,
        requirements: { apps: [], capabilities: [] },
        agents: [{
          key: "clerk",
          name: "Short Clerk",
          title: "Assistant",
          description: "Does the work.",
          appearance: { color: "green" },
          ...(skills.length ? { skills } : {}),
        }],
      },
    });

    const short = await desktopApi("POST", "/api/teams/import", packageOf(["no-such-library-skill"]));
    try {
      // one bad id does not fail the import: the team still lands
      expect(short.status).toBe(201);
      expect(short.body.bots).toHaveLength(1);
      // ... and the discrepancy is reported rather than logged
      expect(short.body.skillErrors).toHaveLength(1);
      expect(short.body.skillErrors[0]).toMatchObject({
        botId: short.body.bots[0].id,
        botName: short.body.bots[0].name,
        skillId: "no-such-library-skill",
        stage: "install",
      });
      // the reason is carried through rather than invented here
      expect(typeof short.body.skillErrors[0].error).toBe("string");
      expect(short.body.skillErrors[0].error.length).toBeGreaterThan(0);
      // and the owner sees it where they will look: the bot's own
      // conversation says which skill is missing, not only a toast that
      // goes away (0.1.60 Linux customer pass, D7)
      const thread = short.body.bots[0].threadId;
      const messages = (await desktopApi("GET", `/api/threads/${thread}/messages?limit=50`)).body.messages as Array<{ role: string; kind?: string; text?: string }>;
      const note = messages.find(message => message.role === "bot" && message.text?.includes("no-such-library-skill"));
      expect(note?.text).toBe("One skill I came with is not switched on yet: no-such-library-skill (it could not be installed). You can check my skills in my settings, under Skills.");
    } finally {
      for (const bot of short.body.bots ?? []) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }

    // and a clean import answers with an empty list, not a missing field: a
    // caller that has to test for the field is a caller that will forget
    const clean = await desktopApi("POST", "/api/teams/import", packageOf([]));
    try {
      expect(clean.status).toBe(201);
      expect(clean.body.skillErrors).toEqual([]);
      const cleanMessages = (await desktopApi("GET", `/api/threads/${clean.body.bots[0].threadId}/messages?limit=50`)).body.messages as Array<{ text?: string }>;
      expect(cleanMessages.some(message => message.text?.includes("not switched on"))).toBe(false);
    } finally {
      for (const bot of clean.body.bots ?? []) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  // The undo used to demote her. `archived` carried `chiefOfStaff` alone, so
  // the only election it could ever replay was a tier-less one — which the
  // chart reads as a section lead — and the workspace Chief came back from
  // Undo one rung down with nothing said.
  it("restores the workspace Chief to the workspace chair, and refuses to seat a second one", async () => {
    const chief = (await desktopApi("POST", "/api/bots", { name: "Undo Chief" })).body.bot;
    const promoted = await desktopApi("PATCH", `/api/bots/${chief.id}`, {
      chiefOfStaff: true,
      chiefScope: "workspace",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.bot).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });

    const exported = await desktopApi("POST", "/api/teams/export", { name: "Undo Team" });
    const beforeReplace = (await api("GET", "/api/bots")).body.bots.filter(
      (bot: { hidden?: boolean }) => !bot.hidden,
    );
    const replaced = await desktopApi("POST", "/api/teams/import?mode=replace", exported.body);
    expect(replaced.status).toBe(201);
    try {
      // the record the undo works from now carries the TIER, not just the role
      const archivedChief = replaced.body.archived.find((bot: { id: string }) => bot.id === chief.id);
      expect(archivedChief).toMatchObject({ chiefOfStaff: true, chiefTier: "workspace" });
      // every entry answers the tier question, one way or the other: a bot
      // that led nothing says so, rather than leaving the undo to guess
      for (const entry of replaced.body.archived) {
        expect(entry.chiefOfStaff ? ["workspace", "section"] : [null]).toContain(entry.chiefTier);
      }

      const workspaceChiefIds = async (): Promise<string[]> =>
        (await api("GET", "/api/bots")).body.bots
          .filter(
            (bot: { chiefOfStaff?: boolean; chiefScope?: string; hidden?: boolean }) =>
              !bot.hidden && bot.chiefOfStaff && bot.chiefScope === "workspace",
          )
          .map((bot: { id: string }) => bot.id);

      // The body the SHIPPED undo sends names no tier at all. It lands her
      // back in the workspace chair anyway, because archiving strips the
      // role and leaves the tier on the record for exactly this.
      const bare = await desktopApi("PATCH", `/api/bots/${chief.id}`, { hidden: false, chiefOfStaff: true });
      expect(bare.status).toBe(200);
      expect(bare.body.bot).toMatchObject({ hidden: false, chiefOfStaff: true, chiefScope: "workspace" });
      expect(await workspaceChiefIds()).toEqual([chief.id]);

      // Put her away again exactly as the import does, and let a DIFFERENT
      // bot take the chair in the meantime.
      expect(
        (await desktopApi("PATCH", `/api/bots/${chief.id}`, { hidden: true, chiefOfStaff: false })).status,
      ).toBe(200);
      const usurper = replaced.body.bots[0];
      expect(
        (await desktopApi("PATCH", `/api/bots/${usurper.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status,
      ).toBe(200);

      // Now the undo is refused outright rather than seating two Chiefs or
      // quietly filing her as a section lead. 409 because the request is
      // well-formed and the workspace is simply in a state that will not
      // accept it — and the message names who has to stand down.
      const refused = await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        ...archivedChief.chiefTier ? { chiefScope: archivedChief.chiefTier } : {},
        hidden: false,
        chiefOfStaff: true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain(usurper.name);
      expect(await workspaceChiefIds()).toEqual([usurper.id]);

      // Stand the incumbent down and the same request lands.
      expect((await desktopApi("PATCH", `/api/bots/${usurper.id}`, { chiefOfStaff: false })).status).toBe(200);
      const restored = await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        ...archivedChief.chiefTier ? { chiefScope: archivedChief.chiefTier } : {},
        hidden: false,
        chiefOfStaff: true,
      });
      expect(restored.status).toBe(200);
      expect(restored.body.bot).toMatchObject({ hidden: false, chiefOfStaff: true, chiefScope: "workspace" });
      expect(await workspaceChiefIds()).toEqual([chief.id]);
    } finally {
      // put the shared harness back: the imported team goes, everything the
      // replace archived comes back with the role it went away with
      for (const bot of replaced.body.bots) await desktopApi("DELETE", `/api/bots/${bot.id}`);
      for (const entry of replaced.body.archived) {
        if (entry.id === chief.id) continue;
        await desktopApi("PATCH", `/api/bots/${entry.id}`, {
          hidden: false,
          ...(entry.chiefOfStaff ? { chiefOfStaff: true } : {}),
        });
      }
      await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
      await desktopApi("DELETE", `/api/bots/${chief.id}`);
      const after = (await api("GET", "/api/bots")).body.bots.filter((bot: { hidden?: boolean }) => !bot.hidden);
      expect(after.map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace
          .map((bot: { id: string }) => bot.id)
          .filter((id: string) => id !== chief.id)
          .sort(),
      );
    }
  });

  // Three gates can drop the user's connected apps and every one of them
  // used to end in the same silence, which is how an assistant came to deny
  // access to a Gmail that was connected the whole time. The contract is
  // that the turn's system prompt says WHICH — asserted against the shared
  // builder rather than a sentence, so rewording the copy cannot fail this.
  it("tells the assistant why it has no connectors, and what the profile says its job needs", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Connector Report" })).body.bot;
    const packageFile = {
      format: "murage.package",
      version: 1,
      package: {
        id: "inbox-desk",
        release: "1.0.0",
        name: "Inbox Desk",
        tagline: "Keep the inbox moving.",
        summary: "A one-bot inbox workflow.",
        category: "Work",
        author: { name: "Murage" },
        license: "MIT",
        outcomes: ["Clear the inbox."],
        setupMinutes: 2,
        requirements: {
          apps: [{ slug: "gmail", label: "Gmail", reason: "Read and reply to the inbox." }],
          capabilities: [],
        },
        agents: [{
          key: "clerk",
          name: "Inbox Clerk",
          title: "Assistant",
          description: "Works the inbox.",
          appearance: { color: "green" },
        }],
      },
    };
    const installed = await desktopApi("POST", "/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    const packaged = installed.body.bots[0];
    // the declared services already reach the renderer on the bot payload
    expect(packaged.installedPackage.requiredApps).toEqual([
      { slug: "gmail", label: "Gmail", reason: "Read and reply to the inbox." },
    ]);

    const systemFor = async (botId: string, text: string): Promise<string> => {
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
      // 20 s like roomSystemFor below: every call after the first sends into
      // a bot this helper just stopped, so its turn launches only once the
      // driver's resetSession has closed the previous child. On Windows that
      // close is an asynchronous taskkill, and under a loaded runner it can
      // outrun the 5 s default before the dump is written.
      const seen = await readJsonFileWhenReady<{ systemPrompt?: string }>(fakeClaudeDump, 20_000);
      expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);
      // Stop acknowledges cancellation before provider teardown finishes.
      // Do not remove the shared dump and change the next turn's config
      // while this one can still own the retained process/queued sends.
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === botId,
      )?.busy, { timeout: 5_000 }).toBe(false);
      return seen.systemPrompt ?? "";
    };

    try {
      for (const id of [bot.id, packaged.id]) {
        expect((await desktopApi("PATCH", `/api/bots/${id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        })).status).toBe(200);
      }

      // this harness has no project key and no broker: nothing here can
      // reach connected apps, and the assistant is told that rather than
      // being left to invent a reason
      const unconfigured = await systemFor(bot.id, "check my mail");
      expect(unconfigured).toContain(connectorSystemPrompt("unconfigured"));
      expect(unconfigured).not.toContain(connectorSystemPrompt("mounted"));

      // the per-bot switch is a different fact and gets a different sentence
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: false })).status).toBe(200);
      const botOff = await systemFor(bot.id, "check my mail again");
      expect(botOff).toContain(connectorSystemPrompt("bot-off"));
      expect(botOff).not.toContain(connectorSystemPrompt("unconfigured"));

      // and a packaged assistant, switched off by the installer rather than
      // by anyone's choice, is told that AND what its profile said it needs
      const packagedTurn = await systemFor(packaged.id, "work the inbox");
      expect(packagedTurn).toContain(connectorSystemPrompt("package-off"));
      expect(packagedTurn).not.toContain(connectorSystemPrompt("bot-off"));
      expect(packagedTurn).toContain(
        requiredAppsSystemPrompt(packageFile.package.requirements.apps),
      );
      // a bot from no package says nothing about required services
      expect(botOff).not.toContain(requiredAppsSystemPrompt(packageFile.package.requirements.apps));
    } finally {
      for (const id of [bot.id, packaged.id]) {
        await api("POST", `/api/bots/${id}/interrupt`);
        await desktopApi("DELETE", `/api/bots/${id}`);
      }
    }
  }, 40_000);

  // …and the same thing again in a ROOM, which had none of it.
  //
  // The fix for the silent denial above was scoped to the 1:1 call site, so
  // the room path kept the original defect: a bot answering in a room denied
  // holding tools it did have, and said nothing when it genuinely lacked
  // them. Rooms mount connectors on exactly the same three gates as a 1:1
  // turn, so all five outcomes are reachable here and none of them may be
  // silent. Asserted against the shared builders, not against a sentence, so
  // room copy and 1:1 copy cannot drift.
  //
  // The two per-bot outcomes are the ones driven here. The `unconfigured`
  // sentence cannot be driven through a room turn in this harness: see the
  // note in the lane report — a room turn whose system prompt contains that
  // exact sentence never reaches the CLI, deterministically, with the
  // production change reverted as well as applied. That is a pre-existing
  // dispatch problem rather than anything this contract asserts, and the two
  // outcomes below exercise the same builder on the same call site.
  it("tells a bot answering in a ROOM why it has no connectors, and what its profile needs", async () => {
    const packageFile = {
      format: "murage.package",
      version: 1,
      package: {
        id: "room-desk",
        release: "1.0.0",
        name: "Room Desk",
        tagline: "Keep the room moving.",
        summary: "A one-bot room workflow.",
        category: "Work",
        author: { name: "Murage" },
        license: "MIT",
        outcomes: ["Clear the room."],
        setupMinutes: 2,
        requirements: {
          apps: [{ slug: "gmail", label: "Gmail", reason: "Read and reply to the inbox." }],
          capabilities: [],
        },
        agents: [{
          key: "clerk",
          name: "Room Clerk",
          title: "Assistant",
          description: "Works the room.",
          appearance: { color: "green" },
        }],
      },
    };
    const plain = (await desktopApi("POST", "/api/bots", { name: "Room Connector Report" })).body.bot;
    const installed = await desktopApi("POST", "/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    const packaged = installed.body.bots[0];
    let plainRoom: any;
    let packagedRoom: any;

    const roomSystemFor = async (roomId: string, text: string): Promise<string> => {
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${roomId}/messages`, { text })).status).toBe(202);
      const seen = await readJsonFileWhenReady<{ systemPrompt?: string }>(fakeClaudeDump, 20_000);
      return seen.systemPrompt ?? "";
    };

    try {
      for (const id of [plain.id, packaged.id]) {
        expect((await desktopApi("PATCH", `/api/bots/${id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        })).status).toBe(200);
      }
      plainRoom = (await api("POST", "/api/groups", { name: "Room Connectors", memberIds: [plain.id] })).body.group;
      packagedRoom = (await api("POST", "/api/groups", {
        name: "Packaged Connectors",
        memberIds: [packaged.id],
      })).body.group;
      for (const room of [plainRoom, packagedRoom]) {
        expect((await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      }

      // the per-bot switch, which the room prompt used to say nothing about
      expect((await desktopApi("PATCH", `/api/bots/${plain.id}`, { composio: false })).status).toBe(200);
      const botOff = await roomSystemFor(plainRoom.id, "check my mail");
      expect(botOff).toContain(connectorSystemPrompt("bot-off"));
      // and it never claims the tools it does not hold
      expect(botOff).not.toContain(connectorSystemPrompt("mounted"));
      // a bot from no package says nothing about required services
      expect(botOff).not.toContain(requiredAppsSystemPrompt(packageFile.package.requirements.apps));

      // a packaged assistant is switched off by the installer rather than by
      // anyone's choice, and is told that AND what its profile said it needs
      const packagedTurn = await roomSystemFor(packagedRoom.id, "work the inbox");
      expect(packagedTurn).toContain(connectorSystemPrompt("package-off"));
      expect(packagedTurn).not.toContain(connectorSystemPrompt("bot-off"));
      expect(packagedTurn).toContain(requiredAppsSystemPrompt(packageFile.package.requirements.apps));
    } finally {
      for (const id of [plain.id, packaged.id]) {
        await api("POST", `/api/bots/${id}/interrupt`);
      }
      for (const room of [plainRoom, packagedRoom]) {
        if (room) await desktopApi("DELETE", `/api/groups/${room.id}`);
      }
      for (const id of [plain.id, packaged.id]) {
        await desktopApi("DELETE", `/api/bots/${id}`);
      }
    }
  }, 60_000);

  it("the scout reads a folder, proposes an importable team, and creates nothing until the human imports", async () => {
    const folder = mkdtempSync(join(tmpdir(), "murage-scout-"));
    writeFileSync(join(folder, "README.md"), "# Demo Shop\n\nA storefront demo.\n");
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
    );

    const before = (await api("GET", "/api/bots")).body;

    expect((await desktopApi("GET", "/api/teams/scout")).status).toBe(400);
    expect((await desktopApi("GET", `/api/teams/scout?cwd=${encodeURIComponent(join(folder, "nope"))}`)).status).toBe(400);

    const scouted = await desktopApi("GET", `/api/teams/scout?cwd=${encodeURIComponent(folder)}`);
    expect(scouted.status).toBe(200);
    expect(scouted.body.profile).toMatchObject({ name: "Demo Shop", summary: "A storefront demo." });
    expect(scouted.body.profile.stacks).toContain("React");
    expect(scouted.body.suggestion.roomName).toBe("Demo Shop");
    const keys = scouted.body.suggestion.manifest.team.members.map((member: { key: string }) => member.key);
    expect(keys).toEqual(["lead", "frontend", "testing"]);
    expect(Object.keys(scouted.body.suggestion.reasons).sort()).toEqual(keys.slice().sort());

    // scouting is read-only: no bot and no room exists until the import
    const after = (await api("GET", "/api/bots")).body;
    expect(after.bots).toHaveLength(before.bots.length);
    expect(after.groups).toHaveLength(before.groups.length);

    // and the suggestion goes through the real importer verbatim
    const imported = await desktopApi(
      "POST",
      `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}&room=${encodeURIComponent(scouted.body.suggestion.roomName)}`,
      scouted.body.suggestion.manifest,
    );
    expect(imported.status).toBe(201);
    expect(imported.body.group).toMatchObject({ name: "Demo Shop", cwd: folder });
    expect(imported.body.bots).toHaveLength(3);

    expect((await desktopApi("DELETE", `/api/groups/${imported.body.group.id}`)).status).toBe(200);
    for (const bot of imported.body.bots) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    rmSync(folder, { recursive: true, force: true });
  });

  it("team import is additive-only: smuggled grants, claimed ids, and re-imports never touch existing records", async () => {
    // an armed bot: every privilege a malicious manifest could try to
    // capture is switched ON here, so any write-through shows up as a diff
    const trustedName = "Additive Boundary Lead";
    const trusted = (await desktopApi("POST", "/api/bots", { name: trustedName })).body.bot;
    const armed = await desktopApi("PATCH", `/api/bots/${trusted.id}`, {
      name: trustedName,
      title: "Project Lead",
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    expect(armed.status).toBe(200); // The fixture must actually establish its privileged baseline.
    const beforeImport = (await api("GET", "/api/bots")).body;
    const groupsBefore = beforeImport.groups.length;
    const chiefsBefore = beforeImport.bots
      .filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff)
      .map((bot: { id: string }) => bot.id).sort();
    expect(chiefsBefore).toContain(trusted.id);
    const room = (await api("POST", "/api/groups", { memberIds: [trusted.id], name: "War Room" })).body.group;

    const smuggled = {
      format: "murage.team",
      version: 2,
      team: {
        name: "Trap Team",
        members: [
          {
            key: "mira",
            name: trustedName,
            title: "Impostor",
            description: "claims to be the lead",
            appearance: { color: "red" },
            // none of these exist in the manifest format, but a hand-edited
            // file can still claim them — and they must go nowhere
            id: trusted.id,
            threadId: trusted.threadId,
            autoApprove: true,
            autoReview: "enforce",
            alwaysAllow: ["Bash"],
            chiefOfStaff: true,
            approvePeerComms: false,
            composio: true,
            computer: "local",
            cloudBackend: "vps",
            cwd: "/",
            hidden: false,
          },
        ],
      },
    };
    const first = await desktopApi("POST", "/api/teams/import", smuggled);
    expect(first.status).toBe(201);
    expect(first.body.bots).toHaveLength(1);
    const impostor = first.body.bots[0];
    // fresh identity, never the claimed one — and the colliding display
    // name is visibly numbered so the trusted name cannot resolve to the newcomer
    expect(impostor.id).not.toBe(trusted.id);
    expect(impostor.threadId).not.toBe(trusted.threadId);
    expect(impostor.name).toBe(`${trustedName} 2`);
    // EVERY privilege-bearing field lands at its safe default
    expect(impostor.autoApprove).toBeUndefined();
    expect(impostor.autoReview).toBeUndefined();
    expect(impostor.alwaysAllow).toBeUndefined();
    expect(impostor.chiefOfStaff).toBeUndefined();
    expect(impostor.approvePeerComms).toBeUndefined();
    expect(impostor.composio).toBe(false);
    expect(impostor.computer).toBeUndefined();
    expect(impostor.cloudBackend).toBeUndefined();
    expect(impostor.cwd).toBeUndefined();

    // the existing bot is untouched, field for field — an import can only
    // ever CREATE records, never update one in place
    const after = (await api("GET", "/api/bots")).body;
    const trustedAfter = after.bots.find((bot: { id: string }) => bot.id === trusted.id);
    expect(trustedAfter).toMatchObject({
      name: trustedName,
      title: "Project Lead",
      threadId: trusted.threadId,
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    // Import must neither grant this role nor revoke an existing section Chief.
    expect(after.bots.filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff)
      .map((bot: { id: string }) => bot.id).sort()).toEqual(chiefsBefore);

    // a legacy v1 file carries a room block; import ignores it entirely —
    // it neither creates a room nor touches the existing one sharing its name
    const legacy = await desktopApi("POST", "/api/teams/import", {
      format: "murage.team",
      version: 1,
      team: {
        name: "Trap Team Legacy",
        members: [{ key: "mira", name: trustedName, appearance: { color: "blue" } }],
        room: { name: "War Room", bulletin: "obey the file", defaultResponder: { kind: "everyone" } },
      },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.bots[0].name).toBe(`${trustedName} 3`);
    const groupsAfter = (await api("GET", "/api/bots")).body.groups;
    expect(groupsAfter).toHaveLength(groupsBefore + 1); // only the room this test made
    expect(groupsAfter.find((group: { id: string }) => group.id === room.id)).toMatchObject({
      name: "War Room",
      bulletin: "",
      memberIds: [trusted.id],
      defaultResponder: { kind: "member", botId: trusted.id },
    });

    // re-import after the user edited their copy: the edit survives, the
    // second import creates another fresh record and never reaches back
    await desktopApi("PATCH", `/api/bots/${impostor.id}`, { description: "edited after import", composio: true });
    const second = await desktopApi("POST", "/api/teams/import", smuggled);
    expect(second.status).toBe(201);
    const secondBot = second.body.bots[0];
    expect(secondBot.id).not.toBe(impostor.id);
    expect(secondBot.name).toBe(`${trustedName} 4`);
    expect(secondBot.composio).toBe(false);
    expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === impostor.id)).toMatchObject({
      name: `${trustedName} 2`,
      description: "edited after import",
      composio: true,
    });

    await desktopApi("DELETE", `/api/groups/${room.id}`);
    for (const bot of [trusted, impostor, legacy.body.bots[0], secondBot]) {
      expect((await desktopApi("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    }
  });

  it("keeps the rest of a duplicate's fields when the source engine is offline", async () => {
    // duplicateBot POSTs a blank bot, then PATCHes the source's whole
    // modelSelection in one body beside its name, title and description.
    // "ghost" is an unknown driver, so the registry resolves nothing and the
    // level cannot be verified — which must not cost the copy everything
    // else in the request.
    const copy = (await desktopApi("POST", "/api/bots")).body.bot;

    const patched = await desktopApi("PATCH", `/api/bots/${copy.id}`, {
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });
  });

  it("rejects an unknown effort value even while the engine is offline", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "turbo" },
    });

    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("not recognized");
  });

  /** Ordering barrier for the three zero-buzz cases below.
   *
   * A suppressed buzz would be emitted BEFORE the call that triggered it
   * returns, but it still has to cross the SSE socket, so `frames` read
   * straight after that call proves nothing. This fails a SEPARATE, plainly
   * attended bot's dispatch on the same stream and waits for ITS buzz.
   * Frames on one stream are ordered, so once the barrier's buzz has landed,
   * a suppressed one could only have landed earlier — and it is a different
   * bot, so `until` cannot resolve on the frame we are trying to disprove. */
  const buzzBarrier = async (stream: Awaited<ReturnType<typeof openSse>>): Promise<string> => {
    const canary = (await desktopApi("POST", "/api/bots")).body.bot;
    expect((await desktopApi("PATCH", `/api/bots/${canary.id}`, { computer: "cloud" })).status).toBe(200);
    expect((await desktopApi("POST", `/api/bots/${canary.id}/messages`, { text: "barrier" })).status).toBe(202);
    const buzz = await stream.until(
      (frame) =>
        frame.kind === "notify" &&
        frame.notification?.kind === "turn-failed" &&
        frame.notification?.botId === canary.id,
      10_000,
    );
    expect(buzz.notification.botId).toBe(canary.id);
    return canary.id;
  };

  // ── a turn that dies before it starts ────────────────────────────────
  //
  // Every one of these forces the SAME async dispatch failure — a bot whose
  // computer is "cloud" while no Box token is configured throws inside the
  // turn's own try block, without touching the network — and then varies
  // only who started the turn. Three of the four assert a COUNT of zero, not
  // an absence of a particular frame, because the bug they guard is a second
  // buzz for one failure.

  it("buzzes when an attended turn dies before it can start", async () => {
    let botId: string | undefined;
    let stream: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      expect((await desktopApi("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
      const bot = (await desktopApi("POST", "/api/bots")).body.bot;
      botId = bot.id;
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      stream = await openSse(`${BASE}/api/events`);
      await stream.until((frame) => frame.kind === "hello");
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "go" })).status).toBe(202);
      const buzz = await stream.until(
        (frame) => frame.kind === "notify" && frame.notification?.kind === "turn-failed",
        10_000,
      );
      expect(buzz.notification).toMatchObject({
        botId: bot.id,
        threadId: bot.threadId,
        title: `${bot.name} couldn't start`,
      });
      expect(String(buzz.notification.body)).toMatch(/box|cloud/i);

      // the error row the chat already renders stays exactly as it was
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=20")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        return Boolean(current?.messages.at(-1)?.tool?.name?.startsWith("error: "));
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      stream?.close();
      if (botId) await desktopApi("DELETE", `/api/bots/${botId}`);
      // the token is write-only, so there is no prior value to restore —
      // leave the box unconfigured rather than half-set for whatever runs next
      await desktopApi("PUT", "/api/config", { box: { token: "" } });
    }
  }, 40_000);

  it("reports a failed routine once, not twice", async () => {
    // predicate 1 of 3: automationSource. A routine reaches the same dispatch
    // catch and then reports through onDispatchError, which raises
    // routine-failed. Without the guard the person is buzzed twice for one
    // failure, so this pins the count rather than merely the presence.
    let botId: string | undefined;
    let routineId: string | undefined;
    let stream: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      expect((await desktopApi("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
      const bot = (await desktopApi("POST", "/api/bots")).body.bot;
      botId = bot.id;
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const created = await desktopApi("POST", "/api/routines", {
        name: "Cloud check",
        prompt: "look at the cloud desktop",
        target: "bot",
        botId: bot.id,
        runOn: "ember",
        enabled: true,
        schedule: { type: "daily", time: "10:00", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(created.status).toBe(201);
      routineId = created.body.routine.id;
      stream = await openSse(`${BASE}/api/events`);
      await stream.until((frame) => frame.kind === "hello");
      expect((await desktopApi("POST", `/api/routines/${routineId}/run`)).status).toBe(201);
      await stream.until(
        (frame) =>
          frame.kind === "notify" &&
          frame.notification?.kind === "routine-failed" &&
          frame.notification?.botId === bot.id,
        10_000,
      );
      const buzzes = stream.frames.filter(
        (frame: { kind?: string; notification?: { kind?: string; botId?: string } }) =>
          frame.kind === "notify" && frame.notification?.botId === bot.id,
      );
      expect(buzzes.map((frame: { notification: { kind: string } }) => frame.notification.kind)).toEqual([
        "routine-failed",
      ]);
    } finally {
      stream?.close();
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`);
      if (botId) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("PUT", "/api/config", { box: { token: "" } });
    }
  }, 40_000);

  it("stays silent when a delegated sub-turn is the thing that could not start", async () => {
    // predicate 2 of 3: commsDepth. The failure is reported to the bot that
    // asked, in its own thread — a second, user-facing channel for the same
    // event would buzz for work the person never started.
    let askerId: string | undefined;
    let targetId: string | undefined;
    let canaryId: string | undefined;
    let stream: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      expect((await desktopApi("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
      const asker = (await desktopApi("POST", "/api/bots")).body.bot;
      askerId = asker.id;
      const target = (await desktopApi("POST", "/api/bots")).body.bot;
      targetId = target.id;
      expect((await desktopApi("PATCH", `/api/bots/${asker.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${target.id}`, { computer: "cloud" })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${asker.id}/messages`, { text: "delegate this" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { MURAGE_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      stream = await openSse(`${BASE}/api/events`);
      await stream.until((frame) => frame.kind === "hello");
      const asked = await fetch(`${BASE}/api/internal/ask-bot`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          fromBotId: asker.id,
          fromThreadId: asker.threadId,
          toBotId: target.id,
          message: "look at the cloud desktop",
        }),
      });
      expect(asked.status).toBe(200);
      // the asker learns about it the way it is supposed to: in its own reply
      expect(JSON.stringify(await asked.json())).toMatch(/couldn't start that bot/i);
      // the pair channel says so as Murage, never as the target's own words
      // (0.1.61, O3)
      const pair = (await desktopApi("GET", "/api/bots?messages=50")).body.groups.find((group: { dm?: boolean; memberIds: string[] }) =>
        group.dm && group.memberIds.includes(asker.id) && group.memberIds.includes(target.id));
      expect(pair.messages.some((message: { kind: string; text?: string; from?: { botId: string } }) =>
        message.kind === "text" && message.from?.botId === target.id && /couldn.t start/i.test(message.text ?? ""))).toBe(false);
      expect(pair.messages.some((message: { kind: string; from?: unknown; tool?: { name: string; ok?: boolean } }) =>
        message.kind === "activity" && !message.from && message.tool?.ok === false && message.tool.name.startsWith(`${target.name} could not start: `))).toBe(true);

      canaryId = await buzzBarrier(stream);
      // and the person is not buzzed for a turn they did not start
      expect(
        stream.frames.filter(
          (frame: { kind?: string; notification?: { kind?: string; botId?: string } }) =>
            frame.kind === "notify" &&
            frame.notification?.kind === "turn-failed" &&
            frame.notification?.botId === target.id,
        ),
      ).toEqual([]);
    } finally {
      stream?.close();
      if (askerId) await api("POST", `/api/bots/${askerId}/interrupt`).catch(() => undefined);
      if (canaryId) await desktopApi("DELETE", `/api/bots/${canaryId}`);
      if (targetId) await desktopApi("DELETE", `/api/bots/${targetId}`);
      if (askerId) await desktopApi("DELETE", `/api/bots/${askerId}`);
      await desktopApi("PUT", "/api/config", { box: { token: "" } });
      rmSync(fakeClaudeDump, { force: true });
    }
  }, 60_000);

  it("leaves a failed credential-card continuation on the card without buzzing", async () => {
    // predicate 3 of 3: cardContinuation. The person is looking at the card
    // that failed to resume, and the card itself carries the error.
    let botId: string | undefined;
    let canaryId: string | undefined;
    let stream: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      expect((await desktopApi("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
      const bot = (await desktopApi("POST", "/api/bots")).body.bot;
      botId = bot.id;
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "stay active" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { MURAGE_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed for the task",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = (await requested.json()) as { messageId: string };

      stream = await openSse(`${BASE}/api/events`);
      await stream.until((frame) => frame.kind === "hello");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/secret-cards/${messageId}/dismiss`, {
        threadId: bot.threadId,
      })).status).toBe(200);

      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=20")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        return current?.messages.find((message: { id: string }) => message.id === messageId)?.secret?.error;
      }, { timeout: 10_000 }).toMatch(/box|cloud/i);
      canaryId = await buzzBarrier(stream);
      expect(
        stream.frames.filter(
          (frame: { kind?: string; notification?: { kind?: string; botId?: string } }) =>
            frame.kind === "notify" &&
            frame.notification?.kind === "turn-failed" &&
            frame.notification?.botId === bot.id,
        ),
      ).toEqual([]);
    } finally {
      if (botId) await api("POST", `/api/bots/${botId}/interrupt`).catch(() => undefined);
      stream?.close();
      if (canaryId) await desktopApi("DELETE", `/api/bots/${canaryId}`);
      if (botId) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("PUT", "/api/config", { box: { token: "" } });
      rmSync(fakeClaudeDump, { force: true });
    }
  }, 60_000);

  it("redacts the failure before it becomes a notification banner", () => {
    // A dispatch failure can carry a provider's verbatim stderr, and this
    // body goes to an OS notification. server/index.ts boots a server on
    // import, so it cannot be pulled into a unit test — same wiring-pin shape
    // as server/flux-surface.test.ts. The behaviour of the wrapper itself is
    // asserted here too, so this is not a purely syntactic pin.
    const indexSource = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    const notifyAt = indexSource.indexOf('buildNotification("turn-failed"');
    expect(notifyAt).toBeGreaterThan(-1);
    expect(indexSource.slice(notifyAt, notifyAt + 200)).toContain("redactSecretsInText(message)");
    expect(redactSecretsInText("engine refused: Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"))
      .not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAA");
  });

  it("creates a fully configured bot in one request and greets with its final name", async () => {
    const created = await desktopApi("POST", "/api/bots", {
      name: "  Pathfinder  ",
      title: "Researcher",
      description: "Maps the problem before acting.",
      section: "  Work  ",
      modelSelection: { instanceId: "  ghost  ", model: "  ghost-1  ", effort: "high" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    try {
      expect(bot).toMatchObject({
        name: "Pathfinder",
        title: "Researcher",
        description: "Maps the problem before acting.",
        section: "Work",
        modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "high" },
      });
      expect(bot.messages[0].text).toContain("Pathfinder");
      expect(bot.messages[0].text).not.toContain("Ember");
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("opts MCP-style model writes into the current live catalog without narrowing general writes", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const customModel = `${claude.models.default}-custom`;
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const general = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
      });
      expect(general.status).toBe(200);
      expect(general.body.bot.modelSelection.model).toBe(customModel);

      const strictPatch = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictPatch.status).toBe(400);
      expect(strictPatch.body.error).toMatch(/not offered/i);

      const beforeIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      const strictCreate = await desktopApi("POST", "/api/bots", {
        name: "Should not exist",
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictCreate.status).toBe(400);
      const afterIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      expect(afterIds).toEqual(beforeIds);

      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        requireAvailableModel: "yes",
      })).status).toBe(400);
      expect((await desktopApi("POST", "/api/bots", {
        name: "Missing selection",
        requireAvailableModel: true,
      })).status).toBe(400);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects incomplete model selections instead of persisting a broken bot", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const missingModel = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost" },
      });
      expect(missingModel.status).toBe(400);
      expect(missingModel.body.error).toContain("modelSelection.model");

      const missingInstance = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { model: "ghost-1" },
      });
      expect(missingInstance.status).toBe(400);
      expect(missingInstance.body.error).toContain("modelSelection.instanceId");

      const reread = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(reread.modelSelection).toEqual(bot.modelSelection);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  // Independent threads (N7, 05cce991): selecting another task never stops or
  // re-targets a running turn, and an ambiguous send must name its thread.
  it("switches the selected task while another thread's turn keeps running", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      const originalTask = bot.threadId;
      const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Running task" });
      expect(created.status).toBe(201);
      const runningTask = created.body.task.threadId;
      const ambiguous = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" });
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.error).toMatch(/choose a thread explicitly/i);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: runningTask, text: "keep running" })).status).toBe(202);

      const taskState = async (threadId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      )?.tasks.find((task: { threadId: string }) => task.threadId === threadId);
      await expect.poll(async () => (await taskState(runningTask))?.busy).toBe(true);

      const switched = await api("POST", `/api/bots/${bot.id}/tasks/${originalTask}`);
      expect(switched.status).toBe(200);
      expect(switched.body.bot.threadId).toBe(originalTask);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(originalTask);
      expect(current.busy).toBe(true);
      expect((await taskState(runningTask)).busy).toBe(true);
      expect(Boolean((await taskState(originalTask)).busy)).toBe(false);
      // The selected task is not the running one: a Stop must still name it.
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: runningTask })).status).toBe(200);
      await expect.poll(async () => (await taskState(runningTask))?.busy).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rechecks bot state after a delayed body for active-branch", async () => {
    const instance = (await api("GET", "/api/instances")).body.instances.find(
      (candidate: { instanceId: string }) => candidate.instanceId === "claude",
    );
    const created = await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: instance.models.default },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const before = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === bot.id,
    );
    const held = await delayedJsonBody("POST", `/api/bots/${bot.id}/active-branch`, { messageId: before.messages[0].id });
    try {
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      )?.busy).toBe(true);
      const rejected = await held.finish();
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toMatch(/working/i);
      const current = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(before.threadId);
      expect(current.tasks).toHaveLength(before.tasks.length);
      expect(current.activeLeafId).not.toBe(before.messages[0].id);
      expect(current.messages.some((message: { text?: string }) => message.text === "keep running")).toBe(true);
    } finally {
      held.close();
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  // Independent threads (N7, 05cce991): a new task is admitted while a
  // sibling thread runs; the running thread and its transcript are untouched.
  it("admits a new task after a delayed body while a sibling thread is running", async () => {
    const instance = (await api("GET", "/api/instances")).body.instances.find(
      (candidate: { instanceId: string }) => candidate.instanceId === "claude",
    );
    const created = await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: instance.models.default },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const before = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === bot.id,
    );
    const held = await delayedJsonBody("POST", `/api/bots/${bot.id}/tasks`, { title: "Delayed task" });
    try {
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      )?.busy).toBe(true);
      // busy is set at dispatch, before the provider accepts the turn. A new
      // task changes the bot's thread set, which the memory roster policy
      // treats as a revocation (p02: "existing-task" still revokes), so a
      // task created inside that window refuses the sibling turn at
      // acceptance and it settles. The task record's lastInstanceId is
      // written only after acceptance: wait for it before admitting the task.
      await expect.poll(() => {
        try {
          const bots = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; tasks?: Array<{ threadId: string; lastInstanceId?: string }> }>;
          return bots.find((candidate) => candidate.id === bot.id)?.tasks?.find((task) => task.threadId === before.threadId)?.lastInstanceId;
        } catch { return undefined; }
      }, { timeout: 5_000 }).toBe("claude");
      const admitted = await held.finish();
      expect(admitted.status).toBe(201);
      expect(admitted.body.task).toMatchObject({ title: "Delayed task", busy: false });
      expect(admitted.body.task.threadId).not.toBe(before.threadId);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.tasks).toHaveLength(before.tasks.length + 1);
      expect(current.tasks.find((task: { threadId: string }) => task.threadId === before.threadId)).toMatchObject({ busy: true });
      expect(current.busy).toBe(true);
      const running = (await api("GET", `/api/threads/${before.threadId}/messages?limit=100`)).body.messages;
      expect(running.some((message: { text?: string }) => message.text === "keep running")).toBe(true);
    } finally {
      held.close();
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: before.threadId });
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each(["POST", "PATCH"])("rechecks room state after a delayed body for %s tasks", async (method) => {
    const instance = (await api("GET", "/api/instances")).body.instances.find(
      (candidate: { instanceId: string }) => candidate.instanceId === "claude",
    );
    const created = await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: instance.models.default },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const grouped = await api("POST", "/api/groups", {
      name: "Delayed task changes",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(grouped.status).toBe(201);
    const room = grouped.body.group;
    const held = await delayedJsonBody(method,
      `/api/groups/${room.id}/tasks${method === "PATCH" ? `/${room.threadId}` : ""}`,
      { title: "Delayed task" });
    try {
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "keep running" })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      )?.working).toBe(true);
      const rejected = await held.finish();
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toMatch(/working/i);
      const current = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(current.threadId).toBe(room.threadId);
      expect(current.tasks).toHaveLength(1);
      expect(current.tasks[0].title).not.toBe("Delayed task");
    } finally {
      held.close();
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      )?.working, { timeout: 5_000 }).toBe(false);
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each(["bots", "groups"])("updates only read metadata through the remote %s read route", async (kind) => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const group = kind === "groups"
      ? (await api("POST", "/api/groups", { name: "Read state fixture", memberIds: [bot.id] })).body.group
      : undefined;
    const id = group?.id ?? bot.id;
    const singular = kind === "bots" ? "bot" : "group";
    const path = `/api/${kind}/${id}/read`;
    try {
      const unread = await api("POST", path, { unread: true });
      expect(unread.status).toBe(200);
      expect(unread.body[singular].unread).toBe(true);
      for (const body of [null, [], { unread: "true" }, { unread: true, alwaysAllow: ["Bash:sh"] }, { unread: true, cwd: "/untrusted" }]) {
        // Send literal JSON null too; the legacy api helper omits falsy bodies.
        const rejected = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(rejected.status).toBe(400);
        const current = (await api("GET", "/api/bots?messages=0")).body[kind].find((value: { id: string }) => value.id === id);
        expect(current.unread).toBe(true);
        expect(current.alwaysAllow ?? []).not.toContain("Bash:sh");
      }
      // Preserve old clients that POST an empty body to mark a chat read.
      const read = await api("POST", path);
      expect(read.status).toBe(200);
      expect(read.body[singular].unread).toBe(false);
      expect((await api("PATCH", `/api/${kind}/${id}`, { unread: true })).status).toBe(404);
    } finally {
      if (group) await desktopApi("DELETE", `/api/groups/${group.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("does not expose or mutate a hidden bot through its read marker", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Hidden read-marker canary" })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { hidden: true, unread: true })).status).toBe(200);
      const denied = await api("POST", `/api/bots/${bot.id}/read`);
      expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain("Hidden read-marker canary");
      const hidden = (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((value: { id: string }) => value.id === bot.id);
      expect(hidden.unread).toBe(true);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/read`)).body.bot.unread).toBe(false);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("does not expose or mutate a private bot-to-bot room through its read marker", async () => {
    const room = (await desktopApi("GET", "/api/bots?messages=0")).body.groups.find((value: { id: string }) => value.id === "test-read-dm");
    expect(room).toBeTruthy();
    try {
      expect((await desktopApi("PATCH", "/api/groups/test-read-dm", { unread: true })).status).toBe(200);
      const denied = await api("POST", "/api/groups/test-read-dm/read");
      expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain(room.name);
      const current = (await desktopApi("GET", "/api/bots?messages=0")).body.groups.find((value: { id: string }) => value.id === room.id);
      expect(current.unread).toBe(true);
      expect((await desktopApi("POST", "/api/groups/test-read-dm/read")).body.group.unread).toBe(false);
    } finally {
      await desktopApi("DELETE", "/api/groups/test-read-dm");
    }
  });

  it.each(["computer", "cloudBackend"])("rejects coerced %s destinations without applying any profile fields", async (field) => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Destination type sentinel" })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", cloudBackend: "box" })).status).toBe(200);
      const arrays = field === "computer" ? [["cloud"], ["off"]] : [["box"], ["vps"]];
      for (const value of [...arrays, {}, 1, false, "unknown"]) {
        const rejected = await desktopApi("PATCH", `/api/bots/${bot.id}`, { [field]: value, name: "Must not land" });
        expect(rejected.status, JSON.stringify({ field, value, response: rejected.body })).toBe(400);
        expect(rejected.body.error).toContain(field);
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
        expect(current.name).toBe("Destination type sentinel");
        expect(current.computer).toBe("off");
        expect(current.cloudBackend).toBe("box");
      }
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to interrupt a conversation after its active task changed", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Exact stop", memberIds: [bot.id] })).body.group;
    try {
      // N7 (05cce991): a bot's threads are independent, so an unknown explicit
      // target is "no such thread", never a switch that could be retried.
      const wrongBot = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "old-task" });
      expect(wrongBot.status).toBe(404);
      expect(wrongBot.body.error).toMatch(/no such thread/i);
      const wrongRoom = await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: "old-task" });
      expect(wrongRoom.status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      for (const route of [`/api/bots/${bot.id}/interrupt`, `/api/groups/${room.id}/interrupt`]) {
        const compatibleNull = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(compatibleNull.status).toBe(200);
        const rejectedArray = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        });
        expect(rejectedArray.status).toBe(400);
      }
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("pins sends to the expected task and offers compact switch responses", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Pinned sends", memberIds: [bot.id] })).body.group;
    try {
      // N7 (05cce991): an explicit unknown bot thread is refused as missing;
      // it never falls through to another run.
      const wrongBot = await desktopApi("POST", `/api/bots/${bot.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongBot.status).toBe(404);
      expect(wrongBot.body.error).toMatch(/no such thread/i);

      const wrongRoom = await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongRoom.status).toBe(409);
      expect(wrongRoom.body.error).toMatch(/switched tasks/i);

      const botOriginal = bot.threadId;
      const botTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second" });
      expect(botTask.status).toBe(201);
      const compactBot = await api("POST", `/api/bots/${bot.id}/tasks/${botOriginal}?messages=0`, {});
      expect(compactBot.status).toBe(200);
      expect(compactBot.body.bot.threadId).toBe(botOriginal);
      expect(compactBot.body.bot.tasks).toHaveLength(2);
      expect(compactBot.body.bot).not.toHaveProperty("messages");
      expect(compactBot.body.bot).not.toHaveProperty("activeLeafId");

      const roomOriginal = room.threadId;
      const roomTask = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Second" });
      expect(roomTask.status).toBe(201);
      const compactRoom = await api("POST", `/api/groups/${room.id}/tasks/${roomOriginal}?messages=0`, {});
      expect(compactRoom.status).toBe(200);
      expect(compactRoom.body.group.threadId).toBe(roomOriginal);
      expect(compactRoom.body.group.tasks).toHaveLength(2);
      expect(compactRoom.body.group).not.toHaveProperty("messages");
      expect(compactRoom.body.group).not.toHaveProperty("activeLeafId");
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("leaves a bot with no effort level untouched", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    expect(bot.modelSelection.effort).toBeUndefined();

    const renamed = await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Plain" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.bot.modelSelection.effort).toBeUndefined();
  });

  // This fixture pins a single unknown driver, so no instance here ever
  // resolves: these cover the gate's pass-through and the store's replace
  // semantics, NOT the comparison against a live engine's declared list.
  // That branch has no coverage at this layer, and manufacturing a live
  // instance in this fixture would cost it its no-probe determinism.
  it("round-trips an effort level and clears it when the key is dropped", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const selection = { instanceId: "ghost", model: "ghost-1" };

    const set = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { ...selection, effort: "high" },
    });
    expect(set.status).toBe(200);
    expect(set.body.bot.modelSelection.effort).toBe("high");

    const reread = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(reread.modelSelection.effort).toBe("high");

    // The panel's "Default" button spreads the selection with effort:
    // undefined, and JSON.stringify drops the key — so clearing reaches the
    // server as a modelSelection carrying no effort at all.
    const cleared = await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });
    expect(cleared.status).toBe(200);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.modelSelection).toEqual(selection);
    expect(after.modelSelection.effort).toBeUndefined();
  });

  it("P08 sidebar hiding preserves bot roles and routing eligibility", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Sidebar presentation fixture" })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "Sidebar fixture", chiefOfStaff: true, computer: "off", autoApprove: false })).status).toBe(200);
      for (const sidebarHidden of [true, false]) {
        const changed = await desktopApi("PATCH", `/api/bots/${bot.id}`, { sidebarHidden });
        expect(changed.status).toBe(200);
        expect(changed.body.bot).toMatchObject({ sidebarHidden, chiefOfStaff: true, computer: "off", autoApprove: false });
        expect(changed.body.bot.hidden).not.toBe(true);
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === bot.id);
        expect(current).toMatchObject({ sidebarHidden, chiefOfStaff: true });
      }
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { sidebarHidden: "yes" })).status).toBe(400);
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("P07 computer destinations round trip through the API and clear persisted Auto", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false })).status).toBe(200);
      for (const computer of ["off", "cloud", "vm", "local", "browser", null]) {
        const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer });
        expect(patched.status).toBe(200);
        const expected = computer ?? undefined;
        expect(patched.body.bot.computer).toBe(expected);
        const reread = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
        expect(reread.computer).toBe(expected);
        const stored = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")).find((entry: { id: string }) => entry.id === bot.id);
        if (computer === null) expect(stored).not.toHaveProperty("computer");
        else expect(stored.computer).toBe(computer);
      }
      for (const computer of ["auto", "unknown", 7, {}, []]) {
        expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer })).status).toBe(400);
      }
      const stored = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")).find((entry: { id: string }) => entry.id === bot.id);
      expect(stored).not.toHaveProperty("computer");
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("P07 explicit browser suppresses desktop mounts despite stale VPS autostart preference", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: false, cloudBackend: "vps", autoStartVps: true })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      expect(turn.dump.mcpConfig.mcpServers.agents).toBeTruthy();
      expect(turn.dump.mcpConfig.mcpServers).not.toHaveProperty("computer");
      // Browser engine enablement is a separate preference; this assertion
      // proves destination isolation, not a real desktop/browser session.
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("P07 Auto reset requires acknowledgement when unattended host control is possible", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "browser", autoApprove: true })).status).toBe(200);
      const blind = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: null });
      expect(blind.status).toBe(process.platform === "darwin" ? 400 : 200);
      if (process.platform === "darwin") {
        expect(blind.body.error).toContain("acknowledgeLocalAuto");
        const unchanged = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
        expect(unchanged.computer).toBe("browser");
      }
      const approved = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: null, acknowledgeLocalAuto: true });
      expect(approved.status).toBe(200);
      expect(approved.body.bot.computer).toBeUndefined();
      expect(approved.body.bot.autoApprove).toBe(true);
      const stored = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")).find((entry: { id: string }) => entry.id === bot.id);
      expect(stored).not.toHaveProperty("computer");
      expect(stored).not.toHaveProperty("acknowledgeLocalAuto");
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("requires the warning acknowledgement for profile-level Auto on a bot that never chose a computer (AUTOOP2 finding 1)", async () => {
    // A fresh bot has no `computer`, which resolves to THIS computer on
    // macOS (the "Auto" destination). The thread route already refused Auto
    // there without the acknowledgement; the profile route only looked at an
    // explicit "local" or null, so the settings-panel switch (and any script
    // curling loopback) could put a fresh Mac bot in Auto on the person's
    // own desktop with no warning at all. One rule now, on the RESOLVED
    // destination, for every path to Auto.
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect(bot.computer).toBeUndefined();
      expect(bot.autoApprove).toBeFalsy();
      const mountsThisComputer = process.platform === "darwin";
      // FOLLOW5: the rule below runs on THIS process's platform, and the
      // renderer's copy must run on the same one rather than on the
      // browser's UA (a Linux tab through the browser door on a Mac harness
      // got a bare 400 and no dialog). The harness announces it on the
      // config route the renderer already reads at startup, on both doors.
      for (const get of [api, desktopApi]) expect((await get("GET", "/api/config")).body.harness).toEqual({ platform: process.platform });
      // A bot curling loopback has no desktop proof and is refused first,
      // on every platform — before any destination rule is consulted.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(404);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(404);
      const blind = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
      const blindTask = await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: true });
      const afterBlind = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
      if (mountsThisComputer) {
        expect(blind.status).toBe(400);
        expect(blind.body.error).toContain("acknowledgeLocalAuto");
        // The thread route and the profile route agree on the same bot.
        expect(blindTask.status).toBe(400);
        expect(blindTask.body.error).toContain("acknowledgeLocalAuto");
        expect(afterBlind.autoApprove).toBeFalsy();
        expect(afterBlind.tasks[0].autoApprove).toBeFalsy();
      } else {
        // Linux and Windows never mount the desktop for a default
        // destination, so Auto there needs no warning on either route.
        expect(blind.status).toBe(200);
        expect(blindTask.status).toBe(200);
        expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false })).status).toBe(200);
      }
      // The dialog's acknowledgement grants it; the flag is never stored.
      const acked = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, acknowledgeLocalAuto: true });
      expect(acked.status).toBe(200);
      expect(acked.body.bot).toMatchObject({ autoApprove: true });
      expect(acked.body.bot.computer).toBeUndefined();
      expect(acked.body.bot.acknowledgeLocalAuto).toBeUndefined();
      const stored = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")).find((entry: { id: string }) => entry.id === bot.id);
      expect(stored).not.toHaveProperty("acknowledgeLocalAuto");
      // Once granted, unrelated PATCHes and re-asserting Auto need no re-ack:
      // the granted combination is the persisted proof.
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Acknowledged" })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
      // Naming this computer explicitly is the same desktop the person
      // already acknowledged on macOS; on a host whose default destination
      // never mounted it, "local" is a new grant and asks again.
      // An explicit "local" mounts the desktop on macOS and Linux, never on
      // Windows (server/local-routing.ts). On macOS it is the same desktop
      // already acknowledged above, so no new warning; on Linux the blind
      // grant above never mounted a computer, so naming "local" is a new
      // local grant that asks; on Windows "local" mounts nothing, so there
      // is nothing to warn about.
      const localMountsHere = process.platform === "darwin" || process.platform === "linux";
      const explicit = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
      const explicitAsks = localMountsHere && !mountsThisComputer;
      expect(explicit.status).toBe(explicitAsks ? 400 : 200);
      if (explicitAsks) expect(explicit.body.error).toContain("acknowledgeLocalAuto");
      // Leaving this computer ends the grant; coming back to the default
      // destination with Auto still on needs the warning again on macOS.
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
      const back = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: null });
      expect(back.status).toBe(mountsThisComputer ? 400 : 200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: null, acknowledgeLocalAuto: true })).status).toBe(200);
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  // The subject — the local-computer Auto warning on an explicit "local" —
  // exists only where a local computer can be mounted. Windows never mounts
  // one (server/local-routing.ts: shouldMountLocalComputer is false for every
  // setting on win32), so there is no desktop to gate and computer:"local"
  // is a no-op; the macOS/Linux acknowledgement flow below cannot arise. The
  // AUTOOP2 test above keeps Windows coverage of the resolved-destination
  // rule (no warning, because nothing mounts).
  it.skipIf(process.platform === "win32")("grants Auto on this computer only through the warning acknowledgement", async () => {
    const created = await desktopApi("POST", "/api/bots");
    const bot = created.body.bot;
    // Auto with the computer OFF needs no warning on any host. (A fresh
    // bot's default destination is this computer on macOS, so Auto there
    // would already be the acknowledged grant — AUTOOP2 finding 1 — and
    // this test is about the explicit "local" path.)
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", autoApprove: true })).body.bot.autoApprove).toBe(
      true,
    );

    // (A loopback caller's 404 — no desktop proof — is platform-independent
    // and asserted in the AUTOOP2 test above, which Windows runs too.)
    // Even an authenticated renderer must supply the warning acknowledgement.
    const blind = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(blind.status).toBe(400);
    const oneShot = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local", autoApprove: true });
    expect(oneShot.status).toBe(400);
    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.computer).not.toBe("local");

    // The dialog's acknowledgement grants it, and the flag is not persisted.
    const local = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local", acknowledgeLocalAuto: true });
    expect(local.status).toBe(200);
    expect(local.body.bot).toMatchObject({ computer: "local", autoApprove: true });
    expect(local.body.bot.acknowledgeLocalAuto).toBeUndefined();

    // Once granted, re-asserting auto and unrelated PATCHes need no re-ack.
    const enabled = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.bot.autoApprove).toBe(true);

    // The other direction needs the warning too: local first, then auto.
    await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false });
    const autoBlind = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(autoBlind.status).toBe(400);
    const autoAcked = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, acknowledgeLocalAuto: true });
    expect(autoAcked.status).toBe(200);

    // Leaving local ends the grant; coming back needs the warning again.
    await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    const back = await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(back.status).toBe(400);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  });

  it("stores only known approval-review modes", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    for (const autoReview of ["off", "shadow", "enforce"]) {
      const response = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoReview });
      expect(response.status).toBe(200);
      expect(response.body.bot.autoReview).toBe(autoReview);
    }
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoReview: "always" })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoReview: true })).status).toBe(400);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  });

  it("offers an idempotent stop boundary for active local turns", async () => {
    const unsupported = await desktopApi("POST", "/api/local-computer/interrupt");
    expect(unsupported).toEqual({
      status: 415,
      body: { error: "content-type must be application/json" },
    });
    const stopped = await desktopApi("POST", "/api/local-computer/interrupt", {});
    // `stopped` names every thread this call stopped on this machine's screen, which
    // on macOS includes every bot that never chose a computer — the sweep and
    // the host RPC gate now ask one predicate (botUsesHostComputer), so the
    // panic control can no longer skip the default bot and still say ok.
    expect(stopped.status).toBe(200);
    expect(stopped.body.ok).toBe(true);
    expect(stopped.body.failed).toBeUndefined();
    expect(Array.isArray(stopped.body.stopped)).toBe(true);
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await desktopApi("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("lets the paired phone save its own choice on a card, and nobody who proved nothing", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const route = `${BASE}/api/bots/${bot.id}/cards/${card.id}`;
    const patch = async (headers: Record<string, string>, dismissed: boolean) => {
      const res = await fetch(route, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ dismissed }) });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    expect((await patch({ "x-murage-companion": "1" }, true)).status).toBe(404);
    expect((await patch({ "x-murage-companion": "1", "x-murage-companion-token": "e".repeat(64) }, true)).status).toBe(404);
    const phone = await patch(PAIRED_PHONE, true);
    expect(phone.status).toBe(200);
    expect(phone.body.message.card.dismissed).toBe(true);
    expect((await patch(DESKTOP_HEADERS, false)).body.message.card.dismissed).toBe(false);
  });

  it("validates approval decisions and reports a request that is no longer open", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const invalid = await desktopApi("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "approve-everything",
    });
    expect(invalid.status).toBe(400);

    const unavailable = await desktopApi("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "allow",
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ ok: true, outcome: "unavailable" });

    const reread = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(reread.messages.at(-1).tool).toMatchObject({ ok: false });
    expect(reread.messages.at(-1).tool.name).toContain("request is no longer open");
  });

  it("answers a room approval whose turn is already over instead of stranding the room", async () => {
    // busyBotId lives in memory only, so a card that outlives its turn (or the
    // process) has no speaker. The room must still be answerable: a pending
    // approval takes over the composer, so a dead end locks the room for good.
    const answered = await desktopApi("POST", "/api/threads/test-stranded-room-thread/respond", {
      requestId: "stranded-request",
      behavior: "allow",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ ok: true, outcome: "unavailable" });

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-stranded-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "stranded-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");

    // a room with nothing pending still reports that plainly
    const nothing = await desktopApi("POST", "/api/threads/test-pinned-room-thread/respond", {
      requestId: "never-existed",
      behavior: "allow",
    });
    expect(nothing.status).toBe(404);
  });

  it("closes the approvals a cancelled turn can no longer answer", async () => {
    // "Cancel turn" is a button ON the approval card, and a pending approval
    // owns the composer. Stopping the turn without closing its card leaves the
    // room blocked by a question whose asker is already gone.
    const stopped = await api("POST", "/api/groups/test-cancel-room/interrupt");
    expect(stopped.status).toBe(200);

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-cancel-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "cancel-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const empty = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // Point this bot at the ghost engine (an unknown driver the registry
    // resolves to nothing) so the send fails loudly on every host. The
    // seeded starter's own selection is defaultSelection() at boot, which is
    // the available fake engine wherever it probes ready in time (Windows CI
    // did; a cold macOS/Linux boot did not) — an unstable precondition this
    // test used to lean on. Setting it here makes the "unavailable" path the
    // subject, not an accident of boot timing.
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: STATE_ONLY_SELECTION })).status).toBe(200);
    // sending a real message must fail loudly, not 202-and-hang
    const send = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
    // a failed send never landed a user message, so the first-run quiz stays
    const afterFail = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(afterFail.messages.find((m: { kind: string }) => m.kind === "options")?.card.dismissed).toBeFalsy();
  });

  it("refuses to fork a message when the provider is unavailable, without mutating", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const before = bot.messages.length;

    // greeting is a bot message — not editable
    const greeting = bot.messages.find((m: { role: string }) => m.role === "bot");
    const notUser = await desktopApi("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "x" });
    expect(notUser.status).toBe(404);

    // no user message exists yet, so fabricate the check via the card id
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await desktopApi("POST", `/api/bots/${bot.id}/messages/${card.id}/edit`, { text: "x" });
    expect(res.status).toBe(404); // options card, not a user text message

    const empty = await desktopApi("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "  " });
    expect(empty.status).toBe(400);

    const after = await api("GET", "/api/bots");
    expect(after.body.bots[0].messages.length).toBe(before);
  });

  it("switches the active branch and reports the new leaf", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    expect(bot.activeLeafId).toBe(bot.messages.at(-1).id);

    // pointing at the first message descends back to the newest leaf on
    // that (only) branch — a no-op switch, but it exercises the descent
    const res = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: bot.messages[0].id });
    expect(res.status).toBe(200);
    expect(res.body.activeLeafId).toBe(bot.messages.at(-1).id);

    const missing = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: "nope" });
    expect(missing.status).toBe(404);
  });

  it("refuses a box token the provider rejects, at the point of pasting", async () => {
    // the stub answers 401 for anything but the good token
    const bad = await desktopApi("PUT", "/api/config", { box: { token: "box_wrong" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/rejected/i);
    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: false });
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await desktopApi("PUT", "/api/config", { box: { token: "box_good" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("box_good");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("box_good");

    const nothing = await desktopApi("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("round-trips the UI language and clears it back to system", async () => {
    const set = await desktopApi("PUT", "/api/config", { language: "de" });
    expect(set.status).toBe(200);
    expect(set.body.language).toBe("de");
    const after = await api("GET", "/api/config");
    expect(after.body.language).toBe("de");

    const cleared = await desktopApi("PUT", "/api/config", { language: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.language).toBe("");
  });

  it("keeps an active turn alive when the UI language changes", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "stay active" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const saved = await desktopApi("PATCH", "/api/config", { language: "de" });
      expect(saved.status).toBe(200);
      expect(saved.body.language).toBe("de");

      const active = (await api("GET", "/api/bots?messages=50")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(active?.busy).toBe(true);
      expect(active?.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { language: "" }).catch(() => undefined);
    }
  });

  it("validates and persists the room silence limit", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    // under 20 was an absolute ceiling before 0.1.61; as a silence limit it
    // would stop work the direct path lets run
    for (const turnTimeoutMinutes of [0, 5, 19, 1.5, 1441, "20", null]) {
      const invalid = await desktopApi("PUT", "/api/config", { rooms: { turnTimeoutMinutes } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("rooms.turnTimeoutMinutes");
    }

    const saved = await desktopApi("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 45 } });
    expect(saved.status).toBe(200);
    expect(saved.body.rooms).toEqual({ turnTimeoutMinutes: 45 });

    const after = await api("GET", "/api/config");
    expect(after.body.rooms).toEqual({ turnTimeoutMinutes: 45 });

    const disk = JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8"));
    expect(disk.rooms).toEqual({ turnTimeoutMinutes: 45 });

    await desktopApi("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
  });

  it("mounts the verification skill into a real turn when its trigger appears", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {})).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", {
        features: { skillRecorder: true },
      })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, {
        text: "/create-verification-skill for my notes app",
      })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const seen = JSON.parse(readFileSync(fakeClaudeDump, "utf8"));
      const system = seen.systemPrompt ?? "";
      // the skill's instructions ride the system prompt the agent receives
      expect(system).toContain('<murage-skill id="create-verification-skill"');
      expect(system).toContain("skill_manage");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("PATCH", "/api/config", { features: { skillRecorder: false } });
    }
  });

  it("mounts the verification skill only for the latest channel request", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    let room: any;
    try {
      expect((await desktopApi("PATCH", "/api/config", {
        features: { skillRecorder: true },
      })).status).toBe(200);
      room = (await api("POST", "/api/groups", {
        name: "Verification skill room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
      })).body.group;

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "/create-verification-skill for my mobile app",
      })).status).toBe(202);
      let seen = await readJsonFileWhenReady<{ systemPrompt?: string }>(fakeClaudeDump);
      let system = seen.systemPrompt ?? "";
      expect(system).toContain('<murage-skill id="create-verification-skill"');
      expect(system).toContain('<murage-skill id="phone-harness"');
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "now give me a short status update",
      })).status).toBe(202);
      seen = await readJsonFileWhenReady<{ systemPrompt?: string }>(fakeClaudeDump);
      system = seen.systemPrompt ?? "";
      expect(system).not.toContain('<murage-skill id="create-verification-skill"');
      expect(system).toContain('<murage-skill id="phone-harness"');
    } finally {
      if (room) {
        expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body;
          const currentRoom = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
          const currentBot = state.bots.find((candidate: { id: string }) => candidate.id === bot.id);
          return {
            working: currentRoom?.working,
            busyBotId: currentRoom?.busyBotId,
            botBusy: currentBot?.busy,
          };
        }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, botBusy: false });
        expect((await desktopApi("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
      }
      expect((await desktopApi("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      expect((await desktopApi("PATCH", "/api/config", { features: { skillRecorder: false } })).status).toBe(200);
    }
  });

  it("keeps Teach a skill off by default and persists an explicit opt-in", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    // the turn-engine switches are served with their defaults (lane E1)
    // Lane D flag, SPEC-P 14: the served learning default stays off.
    const learning = { learningDefaultOn: false };
    const engine = { roomsThreadAdmission: true, roomsQueue: true, roomsMentionChain: true, projectsAutonomy: true, projectsAutoWake: true, projectsParallelCards: true };
    expect(before.body.features).toEqual({ browser: false, projectsLead: true, projectsGoals: true, projectsBudgets: true, projectsWorkProfile: true, projectsBoard: true, projectsDigest: true, skillRecorder: false, showToolCalls: false, ...engine, ...learning });

    const saved = await desktopApi("PATCH", "/api/config", {
      features: { skillRecorder: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.features).toEqual({ botsSharedAcrossTeams: true, browser: false, projectsLead: true, projectsGoals: true, projectsBudgets: true, projectsWorkProfile: true, projectsBoard: true, projectsDigest: true, skillRecorder: true, showToolCalls: false, ...engine, ...learning });

    const disk = JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8"));
    expect(disk.features).toEqual({ skillRecorder: true });

    const tools = await desktopApi("PATCH", "/api/config", { features: { showToolCalls: true } });
    expect(tools.status).toBe(200);
    expect(tools.body.features).toEqual({ botsSharedAcrossTeams: true, browser: false, projectsLead: true, projectsGoals: true, projectsBudgets: true, projectsWorkProfile: true, projectsBoard: true, projectsDigest: true, skillRecorder: true, showToolCalls: true, ...engine, ...learning });

    await desktopApi("PATCH", "/api/config", { features: { skillRecorder: false, showToolCalls: false } });
  });

  it("refuses to delete a bot while it owns an active channel turn", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Deletion safety",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "keep working" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const deletion = await desktopApi("DELETE", `/api/bots/${bot.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/stop.*channel/i);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.some(
        (candidate: { id: string }) => candidate.id === bot.id,
      )).toBe(true);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it("creates, edits, lists, and deletes scheduled multi-bot calls", async () => {
    const first = (await desktopApi("POST", "/api/bots", { name: "Call host" })).body.bot;
    const second = (await desktopApi("POST", "/api/bots", { name: "Call guest" })).body.bot;
    let callId = "";
    try {
      const invalidCreate = await desktopApi("POST", "/api/calendar-calls", {
        name: "",
        botIds: [],
        schedule: { type: "once", at: Date.now() + 60_000 },
      });
      expect(invalidCreate.status).toBe(400);

      const created = await desktopApi("POST", "/api/calendar-calls", {
        name: "Weekly bot sync",
        description: "Review priorities.",
        botIds: [first.id, second.id],
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
        attachments: [],
      });
      expect(created.status).toBe(201);
      callId = created.body.call.id;
      expect(created.body.call).toMatchObject({
        name: "Weekly bot sync",
        botIds: [first.id, second.id],
        durationMinutes: 30,
      });

      const edited = await desktopApi("PATCH", `/api/calendar-calls/${callId}`, {
        schedule: { type: "daily", time: "11:15", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(edited.status).toBe(200);
      expect(edited.body.call.schedule).toEqual({ type: "daily", time: "11:15", weekdays: [1, 2, 3, 4, 5] });
      const fiveMinutePatch = await desktopApi("PATCH", `/api/calendar-calls/${callId}`, { durationMinutes: 5 });
      expect(fiveMinutePatch.status).toBe(200);
      expect(fiveMinutePatch.body.call.durationMinutes).toBe(5);
      const invalidPatch = await desktopApi("PATCH", `/api/calendar-calls/${callId}`, { durationMinutes: 4 });
      expect(invalidPatch.status).toBe(400);
      expect((await desktopApi("GET", "/api/calendar-calls")).body.calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: callId, name: "Weekly bot sync", durationMinutes: 5 })]),
      );

      expect((await desktopApi("DELETE", `/api/calendar-calls/${callId}`)).status).toBe(200);
      callId = "";
      expect((await desktopApi("PATCH", "/api/calendar-calls/missing", { name: "Nope" })).status).toBe(404);
    } finally {
      if (callId) await desktopApi("DELETE", `/api/calendar-calls/${callId}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${first.id}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${second.id}`).catch(() => undefined);
    }
  });

});
