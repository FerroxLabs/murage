// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored team packages from the MIT openmausbot-teams catalog name their
// source product and link its website. The shipped copy names Murage instead.
// The MIT licence text stays in licenses/openmausbot-teams (electron-builder.yml),
// which is where the attribution lives.
export function sanitizeTeamPackage(text) {
  return text
    .replace(/^[ \t]*url:[ \t]*https?:\/\/(?:www\.)?openmausbot\.com\/?[ \t]*\r?\n/gim, "")
    .replace(/^([ \t]*name:[ \t]*)OpenMausBot[ \t]*$/gm, "$1Murage")
    .replace(/\bOpenMausBot\b/g, "Murage")
    .replace(/\bSupaMaus\b/gi, "Murage")
    .replace(/\bMausBot\b/g, "Murage");
}
