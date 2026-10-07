// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for the server's use of browser-extension-host-registration.mjs.
type Browser = "chrome" | "edge" | "brave" | "chromium";
export function browserRegistrationFamily(browser: Browser, platform: string): Browser;
export function sharedRegistrationBrowsers(browser: Browser, platform?: string): string[];
