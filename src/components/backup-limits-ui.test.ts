// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-05: the size limit setup fills in, and the largest one the
// page accepts, are both sizes restore accepts (shared/backup-limits.ts).
import { expect, it } from "vitest";
import { FIRST_SETUP_LIMITS } from "./backup-schedule-ui";
import { MAX_BACKUP_BYTES } from "../../shared/backup-limits";
import { backupScheduleSchema } from "../../shared/backup-schedule";

it("setup's default size limit and the page's largest are sizes restore accepts", () => {
  expect(Number(FIRST_SETUP_LIMITS.size) * 1024 ** 3).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
  expect(backupScheduleSchema.safeParse({ maxBytes: 1024 * 1024 ** 3 }).success).toBe(true);
  expect(1024 * 1024 ** 3).toBe(MAX_BACKUP_BYTES);
});
