// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type-level half of the attachment read gate, checked by
// `tsc -p tsconfig.server.json`: the folder is an opaque value that path
// APIs refuse, and the old string export is gone. (String concatenation of
// an object compiles in TypeScript; attachment-read-gate.test.ts refuses
// that with the type checker instead.)
import { join } from "node:path";
import { ATTACHMENTS_HOME } from "./attachments.ts";
// @ts-expect-error ATTACHMENTS_DIR no longer exists
import { ATTACHMENTS_DIR } from "./attachments.ts";

// @ts-expect-error a path API never takes the opaque folder
export const joined = join(ATTACHMENTS_HOME, "x.png");
export const gone = ATTACHMENTS_DIR;
