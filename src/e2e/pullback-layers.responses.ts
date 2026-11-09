// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated renderer fixture replies; no production server imports.
import type { AboutMe } from '../components/AboutMeSettings';
import type { OwnerTimeZone } from '../components/TimeZoneSettings';
export const pbConfig = { surface: 'remote', computer: false, profile: { name: 'Fixture', email: '' }, engines: [], webSearch: { provider: 'off' }, composio: { configured: false }, features: { skillRecorder: true } };
export const pbAboutMe = { text: '', saved: true, chars: 0, maxChars: 4000, suggestion: '' } satisfies AboutMe;
export const pbTimeZone = { timeZone: 'UTC', chosen: false, computerTimeZone: 'UTC' } satisfies OwnerTimeZone;
