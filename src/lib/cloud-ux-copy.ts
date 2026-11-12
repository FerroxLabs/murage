// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud-only screen strings (ux.cloud.*), kept out of the main catalog. English only for now.
import cloud from "../locales/en-ux/cloud.json";

export type CloudUxKey = keyof typeof cloud;
export function uxCloud(key: CloudUxKey): string { return cloud[key]; }
