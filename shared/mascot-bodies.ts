/**
 * The mascot bodies a bot can wear.
 *
 * `ember` is Murage's own fire silhouette. Its artwork lives with the renderer in
 * `src/components/EmberAvatar.tsx` (SHAPE), so this file only names it; the server can
 * validate and persist the id without importing React.
 *
 * Seven of the outlines — blob, circle, capsule, drop, shield, hexagon and star — carry the
 * artwork from Sean's own Blob Studio (<https://www.blobstudio.xyz/>) mascot packs: Blob,
 * Circle, Capsule, Drop, Cone, Polygon and Star, taken from each pack's `SHAPE` constant.
 * See NOTICE. Two — squircle and diamond — are still copied verbatim from OpenMausBot's
 * generated `shared/mascot-bodies.ts` (OpenMausBot PR #663, last changed in commit
 * 2da55d778e747d843084f7911d96e8f47cf2b3ca, unchanged at
 * 4feae3598a361c97b77dc36e0533b561503cd7be), Apache License 2.0; see NOTICE. Upstream's
 * `cursor` body is deliberately not carried: Murage retired that artwork.
 *
 * Blob Studio and OpenMausBot's generator share a lineage, so five of the seven packs are
 * the same silhouette upstream already had, to within the curve form each writes: Cone is
 * upstream's shield to 0 units of 200, Polygon its hexagon to 0.002, Blob to 0.011, Drop to
 * 0.046 and Circle to 0.027 (upstream approximates a true arc with cubics; the packs write
 * the arc). Two are genuinely different drawings and the pack wins: the pack's Capsule has
 * quadratic corners rather than circular ones (4.55 of 200), and its Star has a different
 * waist — a different inner radius (12.74 of 200).
 *
 * Each pack also supplies its own face anchor, which is what the shapes really differ on.
 * Those are taken as authored, so the scales are not uniform: most packs place a full-size
 * face (scale 1, the same the Ember flame draws), the Star clamps its own to 0.682 because
 * its points leave less room, and the two remaining upstream outlines keep upstream's shared
 * 0.791 clamp. The ids stay as 0.1.54 wrote them so saved profiles keep their body, which is
 * why `shield` shows as Cone and `hexagon` as Polygon.
 *
 * The packs' own DEFAULT_GRADIENT (Blob Studio's green) is deliberately not carried: Murage
 * paints each body with the bot's own colour through the `{{GRADIENT}}` slot.
 *
 * Upstream's generator solved each of its anchors against the same 25-expression face geometry
 * EmberAvatar draws (identical point data, FACE_BOX 228.541, FACE_CENTRE [120, 122.5]) and
 * clamped every face to one shared scale, so the face does not clip in any of them; the Blob
 * Studio packs solve the same face against their own silhouette. Do not hand-edit the outline
 * data; re-copy it from upstream, or from the pack, instead.
 */

import { z } from "zod";

/** Every selectable body id, in the order the picker shows them. */
export const MASCOT_BODY_IDS = ["ember", "blob", "circle", "squircle", "capsule", "drop", "shield", "hexagon", "diamond", "star"] as const;

export type MascotBodyId = (typeof MASCOT_BODY_IDS)[number];

export const mascotBodySchema = z.enum(MASCOT_BODY_IDS, {
  error: `mascotBody must be ${MASCOT_BODY_IDS.slice(0, -1).join(", ")}, or ${MASCOT_BODY_IDS.at(-1)}`,
});

export interface MascotBody {
  id: Exclude<MascotBodyId, "ember">;
  /** Human-readable name, used for the picker and the accessible label. */
  name: string;
  /** Transform mapping the outline into the face box. */
  fit: string;
  /** Body markup. `{{GRADIENT}}` is replaced with the bot's own gradient. */
  body: string;
  /** The same outline without a fill, used as the clip region. */
  clip: string;
  /** Where the face sits inside the body, in face-space units. */
  anchor: { x: number; y: number; scale: number };
}

/** The shipped mascot, and the fallback for any unrecognised value. */
export const DEFAULT_MASCOT_BODY: MascotBodyId = "ember";

/** Picker and accessible-label names for every body, the built-in one included. */
export const MASCOT_BODY_NAMES: Record<MascotBodyId, string> = {
  ember: "Ember",
  blob: "Blob",
  circle: "Circle",
  squircle: "Squircle",
  capsule: "Capsule",
  drop: "Drop",
  shield: "Cone",
  hexagon: "Polygon",
  diamond: "Diamond",
  star: "Star",
};

/** The generated outlines. `ember` is supplied by the renderer. */
export const MASCOT_BODIES: Record<Exclude<MascotBodyId, "ember">, MascotBody> = {
  blob: {
    id: "blob",
    name: "Blob",
    fit: "translate(-0.707 2.9621) scale(1.13464)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M198.91 113.13Q198.00 126.26 193.13 138.61Q188.27 150.96 179.93 161.28Q171.59 171.59 160.81 179.13Q150.04 186.68 137.88 191.31Q125.71 195.95 112.85 197.75Q100.00 199.54 87.00 198.31Q73.99 197.08 61.63 192.48Q49.26 187.88 38.70 179.87Q28.15 171.85 20.54 161.06Q12.92 150.28 8.79 137.91Q4.66 125.55 3.80 112.78Q2.94 100.00 4.79 87.50Q6.65 74.99 10.94 63.02Q15.23 51.06 22.14 40.05Q29.05 29.05 38.81 19.99Q48.57 10.93 60.81 5.16Q73.04 -0.61 86.52 -2.10Q100.00 -3.58 113.13 -0.77Q126.25 2.05 137.80 8.29Q149.35 14.52 158.90 23.04Q168.45 31.55 176.01 41.65Q183.58 51.74 189.03 63.22Q194.47 74.69 197.14 87.34Q199.82 100.00 198.91 113.13Z\"/>",
    clip: "<path d=\"M198.91 113.13Q198.00 126.26 193.13 138.61Q188.27 150.96 179.93 161.28Q171.59 171.59 160.81 179.13Q150.04 186.68 137.88 191.31Q125.71 195.95 112.85 197.75Q100.00 199.54 87.00 198.31Q73.99 197.08 61.63 192.48Q49.26 187.88 38.70 179.87Q28.15 171.85 20.54 161.06Q12.92 150.28 8.79 137.91Q4.66 125.55 3.80 112.78Q2.94 100.00 4.79 87.50Q6.65 74.99 10.94 63.02Q15.23 51.06 22.14 40.05Q29.05 29.05 38.81 19.99Q48.57 10.93 60.81 5.16Q73.04 -0.61 86.52 -2.10Q100.00 -3.58 113.13 -0.77Q126.25 2.05 137.80 8.29Q149.35 14.52 158.90 23.04Q168.45 31.55 176.01 41.65Q183.58 51.74 189.03 63.22Q194.47 74.69 197.14 87.34Q199.82 100.00 198.91 113.13Z\"/>",
    anchor: { x: 112.93, y: 118.29, scale: 1 },
  },
  circle: {
    id: "circle",
    name: "Circle",
    fit: "translate(0 0) scale(1.142705)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M0 100A100 100 0 0 1 200 100A100 100 0 0 1 0 100Z\"/>",
    clip: "<path d=\"M0 100A100 100 0 0 1 200 100A100 100 0 0 1 0 100Z\"/>",
    anchor: { x: 113.82, y: 113.82, scale: 1 },
  },
  squircle: {
    id: "squircle",
    name: "Squircle",
    fit: "translate(0 0) scale(1.142705)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M50 0C83.33333 0 116.66667 0 150 0C177.61424 0 200 22.38576 200 50C200 83.33333 200 116.66667 200 150C200 177.61424 177.61424 200 150 200C116.66667 200 83.33333 200 50 200C22.38576 200 0 177.61424 0 150C0 116.66667 0 83.33333 0 50C0 22.38576 22.38576 0 50 0Z\"/>",
    clip: "<path d=\"M50 0C83.33333 0 116.66667 0 150 0C177.61424 0 200 22.38576 200 50C200 83.33333 200 116.66667 200 150C200 177.61424 177.61424 200 150 200C116.66667 200 83.33333 200 50 200C22.38576 200 0 177.61424 0 150C0 116.66667 0 83.33333 0 50C0 22.38576 22.38576 0 50 0Z\"/>",
    anchor: { x: 111.78, y: 111.79, scale: 0.791 },
  },
  capsule: {
    id: "capsule",
    name: "Capsule",
    fit: "translate(0 0) scale(1.142705)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100 0H100Q175 0 175 75V125Q175 200 100 200H100Q25 200 25 125V75Q25 0 100 0Z\"/>",
    clip: "<path d=\"M100 0H100Q175 0 175 75V125Q175 200 100 200H100Q25 200 25 125V75Q25 0 100 0Z\"/>",
    anchor: { x: 113.82, y: 86.15, scale: 1 },
  },
  drop: {
    id: "drop",
    name: "Drop",
    fit: "translate(-3.5341 -3.5341) scale(1.178046)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100 3C160.84 78.2235 178 103.298 178 119A78 78 0 0 1 22 119C22 103.298 39.16 78.2235 100 3Z\"/>",
    clip: "<path d=\"M100 3C160.84 78.2235 178 103.298 178 119A78 78 0 0 1 22 119C22 103.298 39.16 78.2235 100 3Z\"/>",
    anchor: { x: 113.82, y: 141.5, scale: 1 },
  },
  shield: {
    id: "shield",
    name: "Cone",
    fit: "translate(-12.1611 -24.3223) scale(1.264316)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M57.25 38.475Q100 0 142.75 38.475L176.19 152.975Q195 200 147.975 200L52.025000000000006 200Q5 200 23.810000000000002 152.975Z\"/>",
    clip: "<path d=\"M57.25 38.475Q100 0 142.75 38.475L176.19 152.975Q195 200 147.975 200L52.025000000000006 200Q5 200 23.810000000000002 152.975Z\"/>",
    anchor: { x: 113.82, y: 107.91, scale: 1 },
  },
  hexagon: {
    id: "hexagon",
    name: "Polygon",
    fit: "translate(-4.1077 -4.1077) scale(1.183782)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M94.91 4.94Q100.00 2.00 105.09 4.94L179.78 48.06Q184.87 51.00 184.87 56.88L184.87 143.12Q184.87 149.00 179.78 151.94L105.09 195.06Q100.00 198.00 94.91 195.06L20.22 151.94Q15.13 149.00 15.13 143.12L15.13 56.88Q15.13 51.00 20.22 48.06Z\"/>",
    clip: "<path d=\"M94.91 4.94Q100.00 2.00 105.09 4.94L179.78 48.06Q184.87 51.00 184.87 56.88L184.87 143.12Q184.87 149.00 179.78 151.94L105.09 195.06Q100.00 198.00 94.91 195.06L20.22 151.94Q15.13 149.00 15.13 143.12L15.13 56.88Q15.13 51.00 20.22 48.06Z\"/>",
    anchor: { x: 113.82, y: 113.82, scale: 1 },
  },
  diamond: {
    id: "diamond",
    name: "Diamond",
    fit: "translate(-5.9383 -5.9383) scale(1.202088)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M94.12 7.88C98.04 3.96 101.96 3.96 105.88 7.88C134.62667 36.62667 163.37333 65.37333 192.12 94.12C196.04 98.04 196.04 101.96 192.12 105.88C163.37333 134.62667 134.62667 163.37333 105.88 192.12C101.96 196.04 98.04 196.04 94.12 192.12C65.37333 163.37333 36.62667 134.62667 7.88 105.88C3.96 101.96 3.96 98.04 7.88 94.12C36.62667 65.37333 65.37333 36.62667 94.12 7.88Z\"/>",
    clip: "<path d=\"M94.12 7.88C98.04 3.96 101.96 3.96 105.88 7.88C134.62667 36.62667 163.37333 65.37333 192.12 94.12C196.04 98.04 196.04 101.96 192.12 105.88C163.37333 134.62667 134.62667 163.37333 105.88 192.12C101.96 196.04 98.04 196.04 94.12 192.12C65.37333 163.37333 36.62667 134.62667 7.88 105.88C3.96 101.96 3.96 98.04 7.88 94.12C36.62667 65.37333 65.37333 36.62667 94.12 7.88Z\"/>",
    anchor: { x: 112.53, y: 109.95, scale: 0.791 },
  },
  star: {
    id: "star",
    name: "Star",
    fit: "translate(-8.3373 3.1388) scale(1.226078)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100.00 2.00L124.19 66.70L193.20 69.72L139.15 112.72L157.60 179.28L100.00 141.16L42.40 179.28L60.85 112.72L6.80 69.72L75.81 66.70Z\"/>",
    clip: "<path d=\"M100.00 2.00L124.19 66.70L193.20 69.72L139.15 112.72L157.60 179.28L100.00 141.16L42.40 179.28L60.85 112.72L6.80 69.72L75.81 66.70Z\"/>",
    anchor: { x: 113.82, y: 117.01, scale: 0.682 },
  },
};

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botMascotBody(value: unknown): MascotBodyId {
  return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}
