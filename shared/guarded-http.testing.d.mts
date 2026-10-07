// SPDX-License-Identifier: AGPL-3.0-or-later
import type http from "node:http";
import type { GuardedRequestOptions } from "./guarded-http.mjs";

export function withSeams(
  options: GuardedRequestOptions,
  seams: { transportFor?: (scheme: "http" | "https") => typeof http; tamperAddress?: (address: string) => string },
): GuardedRequestOptions;
