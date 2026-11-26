import { vi } from "vitest";
// Pure regression lane only. No listener is needed by any test in its allowlist.
// The regular setup still supplies isolated HOME, database and cleanup guards.
vi.mock("../../../server/testing/ports.ts", () => ({ freePortBlock: async () => 0 }));
await import("../../../server/testing/setup.ts");
