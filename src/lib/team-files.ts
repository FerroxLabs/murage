import { api } from "@/state/store";

interface ExportedTeam {
  team: {
    name: string;
    members: unknown[];
  };
}

/** Fetch a safe server-built manifest and hand it to the browser as a file. */
export async function downloadTeamFile(groupId: string): Promise<{ name: string; members: number }> {
  const manifest = (await api(`/api/groups/${groupId}/team`)) as ExportedTeam;
  const slug =
    manifest.team.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "openmaus-team";
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.mausteam.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // There is no browser event for "download has consumed this URL". Keep it
  // alive long enough for slower engines to start reading, then clean it up.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: manifest.team.name, members: manifest.team.members.length };
}
