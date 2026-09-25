// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// announcements.yml to the feed the app reads, with every check the app makes
// plus the stricter publishing ones (copy rules, unknown fields, image files).
// Used by lint.mjs (on every pull request) and sign.mjs (on merge), so what
// is signed is exactly what was linted.
//
// The rules themselves are the app's own: shared/announcements.ts in the
// Murage repo, imported directly (Node 22.18+ runs it as is). The publishing
// workflow checks out the Murage repo next to the announcements repo for
// exactly this reason.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ANNOUNCEMENT_IMAGE_PREFIX,
  ANNOUNCEMENT_LIMITS,
  checkAnnouncementFeed,
} from "../../shared/announcements.ts";

/** The `yaml` package, from the working directory first (the announcements
 *  repo installs it there), else from next to this file (the Murage repo). */
function loadYaml() {
  for (const base of [join(process.cwd(), "noop.js"), import.meta.url]) {
    try {
      return createRequire(base)("yaml");
    } catch {
      // try the next place
    }
  }
  throw new Error('The "yaml" package is missing. Run: npm install --no-save --no-package-lock yaml@2');
}

const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/;

function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

const text = (value) => (typeof value === "string" ? value.trim() : value);

/**
 * Build the feed from announcements.yml.
 *
 * @param {string} ymlPath  path to announcements.yml; images live in `images/` beside it
 * @param {{ issuedAt?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], warnings: string[], bytes?: Buffer, feed?: object, images: string[] }}
 */
export function buildFeed(ymlPath, options = {}) {
  const errors = [];
  const warnings = [];
  const images = [];
  const root = resolve(ymlPath, "..");
  const imagesDir = join(root, "images");
  let doc;
  try {
    doc = loadYaml().parse(readFileSync(ymlPath, "utf8"), { schema: "core", uniqueKeys: true });
  } catch (error) {
    return { ok: false, errors: [`announcements.yml could not be read: ${error instanceof Error ? error.message : String(error)}`], warnings, images };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: ["announcements.yml must have an items: list"], warnings, images };
  for (const key of Object.keys(doc)) if (key !== "items") errors.push(`unknown top-level field "${key}"`);
  const raw = doc.items ?? [];
  if (!Array.isArray(raw)) return { ok: false, errors: ["items must be a list"], warnings, images };

  const items = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const item = {};
    for (const [key, value] of Object.entries(entry)) {
      if (value instanceof Date) item[key] = value.toISOString();
      else if (value && typeof value === "object" && !Array.isArray(value)) item[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, text(v)]));
      else item[key] = text(value);
    }
    if (typeof item.image === "string") {
      const name = item.image;
      if (!IMAGE_NAME.test(name)) {
        errors.push(`${item.id ?? `item ${index + 1}`}: image must be a file name in images/, like voice.webp`);
      } else {
        const file = join(imagesDir, name);
        if (!existsSync(file)) errors.push(`${item.id}: images/${name} does not exist`);
        else {
          const bytes = readFileSync(file);
          if (bytes.length > ANNOUNCEMENT_LIMITS.imageBytes) errors.push(`${item.id}: images/${name} is over ${ANNOUNCEMENT_LIMITS.imageBytes / 1024} KB`);
          const kind = sniff(bytes);
          const ext = name.split(".").pop().toLowerCase().replace("jpeg", "jpg");
          if (!kind) errors.push(`${item.id}: images/${name} is not a PNG, JPEG or WebP picture`);
          else if (kind !== ext) errors.push(`${item.id}: images/${name} is really a ${kind}`);
          images.push(name);
        }
        item.image = ANNOUNCEMENT_IMAGE_PREFIX + name;
      }
    }
    return item;
  });

  const feed = { version: 1, issuedAt: options.issuedAt ?? new Date().toISOString(), items };
  const bytes = Buffer.from(JSON.stringify(feed));
  const checked = checkAnnouncementFeed(bytes, { strict: true });
  if (!checked.ok) errors.push(...checked.errors);
  else warnings.push(...checked.warnings);

  if (existsSync(imagesDir) && statSync(imagesDir).isDirectory()) {
    for (const name of readdirSync(imagesDir)) if (!name.startsWith(".") && !images.includes(name)) warnings.push(`images/${name} is not used by any notice`);
  }
  return errors.length ? { ok: false, errors, warnings, images } : { ok: true, errors, warnings, bytes, feed, images: [...new Set(images)] };
}

/** True when this module is the script node was asked to run. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
