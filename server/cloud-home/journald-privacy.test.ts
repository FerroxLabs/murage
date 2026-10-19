// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit FPS-4: no journal or SMTP address log may persist on the unencrypted root disk.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");

it("journald drop-in keeps the journal volatile and bounded", () => {
  const conf = source("murage-journald.conf");
  expect(conf).toMatch(/^Storage=volatile$/m);
  expect(conf).toMatch(/^RuntimeMaxUse=64M$/m);
  expect(conf).not.toMatch(/^Storage=(persistent|auto)/m);
});

it("build installs the drop-in and clears any existing persistent journal", () => {
  const build = source("build-image.sh");
  expect(build).toContain("install -m 0644 deploy/cloud-home/murage-journald.conf /etc/systemd/journald.conf.d/murage.conf");
  expect(build).toMatch(/rm -rf \/var\/log\/journal\/\*/);
});

it("nft no longer logs accepted port-587 connections but keeps the drop-path log", () => {
  const nft = source("murage-egress.nft");
  expect(nft).not.toContain('log prefix "murage smtp new "');
  expect(nft.match(/log prefix "murage smtp blocked "/g)).toHaveLength(2);
  expect(nft.match(/limit name "smtp_new_home"/g)).toHaveLength(2);
});
it("rsyslog cannot copy kernel or auth messages to the unencrypted root disk", () => {
  expect(source("build-image.sh")).toMatch(/^systemctl mask rsyslog\.service/m);
});
