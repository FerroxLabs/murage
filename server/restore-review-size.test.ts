// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 DOWNGRADE-TO6 rehearsal 5: a data copy with 10,184 skill shortcuts pointing outside the data folder restored, but
// its restore-review.json was 4.5 MB, over the 1 MiB its reader accepts, so every review refused RESTORE_REVIEW_REQUIRED.
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { activateInstallation, reviewInstallation } from "./installation-activation.ts";
import { MAX_RESTORE_REVIEW_BYTES, REVIEW_NOTE_EXAMPLES, RESTORE_UNRECOGNISED, foldReviewNotes } from "./installation-restore-preparation.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it.skipIf(process.platform === "win32")("10,000 shortcuts leading out of the data folder fold into one counted line, and the copy reviews, activates and opens", async () => {
  const f = backupFixture();
  const desk = join(f.data, "workspaces", "bot", "threads", "t", ".murage-procedures", "p", "skills");
  mkdirSync(join(desk, "lib"), { recursive: true }); writeFileSync(join(desk, "lib", "i.js"), "x");
  symlinkSync("lib/i.js", join(desk, "inside"));
  // A long absolute target, as on the data copy, so ten thousand lines each would be about 4 MB.
  const far = `/Users/someone/.murage/workspaces/${"a".repeat(36)}/threads/${"b".repeat(36)}/.murage-procedures/${"c".repeat(64)}/skills`;
  for (let index = 0; index < 10_000; index++) symlinkSync(`${far}/skill-${index}`, join(desk, `skill-${index}`));
  try {
    const saved = await writeInstallationArchive(f.data, join(f.parent, "x.zip"));
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    const markerFile = join(target, "restore-review.json");
    expect(statSync(markerFile).size).toBeLessThan(MAX_RESTORE_REVIEW_BYTES);
    const marker = JSON.parse(readFileSync(markerFile, "utf8")) as { modifications: Array<{ component: string; action: string }> };
    const outside = marker.modifications.filter(line => /outside Murage's data folder/.test(line.action));
    expect(outside).toHaveLength(1);
    expect(outside[0]!.action).toBe("10000 shortcuts left out: they pointed outside Murage's data folder");
    expect(outside[0]!.component.split(", ")).toHaveLength(REVIEW_NOTE_EXAMPLES);
    const review = reviewInstallation(target);
    expect(review.status).toBe("ready-for-review");
    expect(activateInstallation(target, review.reviewHash).status).toBe("reviewed-engines-disabled");
    expect(() => assertRestoreReviewed(target)).not.toThrow();
  } finally { f.db.close(); removeTempDirSync(f.parent); }
}, 240_000);

it("sharing repairs and left-out names fold too, and the deletion-ledger line is never folded", () => {
  const thread = (index: number) => `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const lines = [
    ...Array.from({ length: 6_000 }, (_, index) => ({ component: "bots.json/groups.json", action: `Quarantined work conversation ${thread(index)}.` })),
    ...Array.from({ length: 30 }, (_, index) => ({ component: `extra-${index}.json`, action: RESTORE_UNRECOGNISED })),
    ...Array.from({ length: 25 }, () => ({ component: "messages.db", action: "destination-ledger-unreadable: kept" })),
    { component: "config.json", action: "Provider/MCP credentials excluded; engine and experimental execution disabled" },
  ];
  const folded = foldReviewNotes(lines);
  expect(folded.filter(line => line.action.startsWith("Quarantined work conversation"))).toHaveLength(REVIEW_NOTE_EXAMPLES);
  expect(folded).toContainEqual({ component: "bots.json/groups.json", action: `${6_000 - REVIEW_NOTE_EXAMPLES} more changes like the ${REVIEW_NOTE_EXAMPLES} above` });
  expect(folded.filter(line => line.action === RESTORE_UNRECOGNISED)).toHaveLength(REVIEW_NOTE_EXAMPLES);
  expect(folded).toContainEqual({ component: "extra-4.json", action: `${30 - REVIEW_NOTE_EXAMPLES} more changes like the ${REVIEW_NOTE_EXAMPLES} above` });
  expect(folded.filter(line => line.action.includes("ledger"))).toHaveLength(25);
  expect(folded.at(-1)!.component).toBe("config.json");
  expect(Buffer.byteLength(JSON.stringify(folded))).toBeLessThan(MAX_RESTORE_REVIEW_BYTES);
  // Twenty of one kind still read one by one.
  expect(foldReviewNotes(lines.slice(0, 20))).toEqual(lines.slice(0, 20));
});
