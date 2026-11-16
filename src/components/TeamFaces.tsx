// A small row of real faces (the real Ember avatar, resting, never moving): up to five, then "+N". Used by the welcome for the starter team.
import { faceRow, FACE_ROW_MAX } from "@/lib/face-row";
import { EmberAvatar } from "./Avatar";

export interface TeamFace { key: string; name: string; color?: string; mascotBody?: string | null }

export function TeamFaces({ members, label, size = 28, max = FACE_ROW_MAX, quiet }: { members: readonly TeamFace[]; label: string; size?: number; max?: number; quiet?: string }) {
  const { shown, more } = faceRow(members, max);
  if (shown.length === 0) return null;
  return (
    <div role="img" aria-label={`${label}: ${members.map((member) => member.name).join(", ")}`} data-team-faces={shown.length} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      {shown.map((member) => (
        <span key={member.key} style={{ display: "inline-flex", width: size, height: size }} aria-hidden="true">
          <EmberAvatar label={member.name} color={member.color as never} body={member.mascotBody as never} size={size} state="idle" animated={false} autoBlink={false} trackPointer={false} />
        </span>
      ))}
      {more > 0 && <span data-team-more={more} style={{ fontSize: 13, fontWeight: 600, color: quiet }} aria-hidden="true">{`+${more}`}</span>}
    </div>
  );
}
