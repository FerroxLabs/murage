/**
 * The mascot bodies a bot can wear.
 *
 * `ember` is Murage's own fire silhouette. Its artwork lives with the renderer in
 * `src/components/EmberAvatar.tsx` (SHAPE), so this file only names it; the server can
 * validate and persist the id without importing React.
 *
 * Six of the outlines — blob, squircle, capsule, drop, diamond and star — their fit
 * transforms and their face anchors are copied verbatim from OpenMausBot's generated
 * `shared/mascot-bodies.ts` (OpenMausBot PR #663, last changed in commit
 * 2da55d778e747d843084f7911d96e8f47cf2b3ca, unchanged at
 * 4feae3598a361c97b77dc36e0533b561503cd7be), Apache License 2.0; see NOTICE. Upstream's
 * `cursor` body is deliberately not carried: Murage retired that artwork.
 *
 * The other three — `circle`, `shield` and `hexagon` — now carry the artwork from Sean's
 * own Blob Studio (<https://www.blobstudio.xyz/>) Circle, Cone and Polygon mascot packs
 * instead, taken from each pack's `SHAPE` constant; see NOTICE. Blob Studio and OpenMausBot's
 * generator share a lineage, so the three silhouettes are the same geometry either way
 * (Cone is upstream's shield to 0 units, Polygon its hexagon to 0.002, Circle the exact arc
 * upstream approximated with four cubics, max radial error 0.027 of 200). Two things do
 * differ and the packs win, because Sean authored them: the shapes are named Circle, Cone and
 * Polygon, and each face sits where its pack put it, at the pack's own scale of 1 — the same
 * full-size face the Ember flame already draws — rather than upstream's shared 0.791 clamp.
 * The ids stay `circle`/`shield`/`hexagon` so profiles saved by 0.1.54 keep their body.
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
    fit: "translate(-0.7217 2.9555) scale(1.134706)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M198.91052 113.12915C198.30169 121.88191 196.37668 130.37605 193.1355 138.61157C189.89431 146.84709 185.49332 154.4026 179.93252 161.27809C174.37172 168.15358 167.99976 174.1053 160.81663 179.13325C153.6335 184.1612 145.98678 188.22176 137.87645 191.31491C129.76613 194.40806 121.42581 196.55178 112.85548 197.74609C104.28516 198.94039 95.66469 199.12755 86.99407 198.30758C78.32344 197.4876 69.86713 195.54477 61.62513 192.47909C53.38313 189.41341 45.74309 185.20915 38.70501 179.86633C31.66693 174.52351 25.60941 168.25632 20.53243 161.06476C15.45546 153.87319 11.54067 146.15559 8.78808 137.91195C6.03549 129.66831 4.37316 121.28874 3.80109 112.77325C3.22902 104.25775 3.5616 95.83136 4.79882 87.49409C6.03604 79.15682 8.08364 70.99969 10.94163 63.0227C13.79962 55.04571 17.53174 47.38891 22.13799 40.0523C26.74425 32.71568 32.30193 26.0276 38.81103 19.98806C45.32014 13.94852 52.65266 9.00619 60.80862 5.16109C68.96458 1.31599 77.53546 -1.10241 86.52128 -2.09412C95.50709 -3.08583 104.37427 -2.64309 113.12282 -0.76589C121.87137 1.11131 130.09712 4.12751 137.80007 8.28271C145.50302 12.43791 152.53652 17.35515 158.90058 23.03443C165.26463 28.7137 170.969 34.91856 176.01368 41.649C181.05836 48.37944 185.3953 55.56843 189.02451 63.21597C192.65372 70.86352 195.3609 78.90607 197.14605 87.34364C198.93119 95.78121 199.51935 104.37638 198.91052 113.12915Z\"/>",
    clip: "<path d=\"M198.91052 113.12915C198.30169 121.88191 196.37668 130.37605 193.1355 138.61157C189.89431 146.84709 185.49332 154.4026 179.93252 161.27809C174.37172 168.15358 167.99976 174.1053 160.81663 179.13325C153.6335 184.1612 145.98678 188.22176 137.87645 191.31491C129.76613 194.40806 121.42581 196.55178 112.85548 197.74609C104.28516 198.94039 95.66469 199.12755 86.99407 198.30758C78.32344 197.4876 69.86713 195.54477 61.62513 192.47909C53.38313 189.41341 45.74309 185.20915 38.70501 179.86633C31.66693 174.52351 25.60941 168.25632 20.53243 161.06476C15.45546 153.87319 11.54067 146.15559 8.78808 137.91195C6.03549 129.66831 4.37316 121.28874 3.80109 112.77325C3.22902 104.25775 3.5616 95.83136 4.79882 87.49409C6.03604 79.15682 8.08364 70.99969 10.94163 63.0227C13.79962 55.04571 17.53174 47.38891 22.13799 40.0523C26.74425 32.71568 32.30193 26.0276 38.81103 19.98806C45.32014 13.94852 52.65266 9.00619 60.80862 5.16109C68.96458 1.31599 77.53546 -1.10241 86.52128 -2.09412C95.50709 -3.08583 104.37427 -2.64309 113.12282 -0.76589C121.87137 1.11131 130.09712 4.12751 137.80007 8.28271C145.50302 12.43791 152.53652 17.35515 158.90058 23.03443C165.26463 28.7137 170.969 34.91856 176.01368 41.649C181.05836 48.37944 185.3953 55.56843 189.02451 63.21597C192.65372 70.86352 195.3609 78.90607 197.14605 87.34364C198.93119 95.78121 199.51935 104.37638 198.91052 113.12915Z\"/>",
    anchor: { x: 111.22, y: 116.58, scale: 0.791 },
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
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100 0C141.42136 0 175 33.57864 175 75C175 91.66667 175 108.33333 175 125C175 166.42136 141.42136 200 100 200C58.57864 200 25 166.42136 25 125C25 108.33333 25 91.66667 25 75C25 33.57864 58.57864 0 100 0Z\"/>",
    clip: "<path d=\"M100 0C141.42136 0 175 33.57864 175 75C175 91.66667 175 108.33333 175 125C175 166.42136 141.42136 200 100 200C58.57864 200 25 166.42136 25 125C25 108.33333 25 91.66667 25 75C25 33.57864 58.57864 0 100 0Z\"/>",
    anchor: { x: 113.82, y: 131.68, scale: 0.791 },
  },
  drop: {
    id: "drop",
    name: "Drop",
    fit: "translate(-3.5341 -3.5341) scale(1.178046)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100 3C160.84 78.2235 178 103.298 178 119C178 162.07821 143.07821 197 100 197C56.92179 197 22 162.07821 22 119C22 103.298 39.16 78.2235 100 3Z\"/>",
    clip: "<path d=\"M100 3C160.84 78.2235 178 103.298 178 119C178 162.07821 143.07821 197 100 197C56.92179 197 22 162.07821 22 119C22 103.298 39.16 78.2235 100 3Z\"/>",
    anchor: { x: 112.47, y: 138.8, scale: 0.791 },
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
    fit: "translate(-8.3327 3.1407) scale(1.226032)",
    body: "<path fill=\"{{GRADIENT}}\" d=\"M100 2C110.56054 20.13133 121.12108 38.26266 131.68163 56.39398C152.18893 60.83477 172.69623 65.27555 193.20354 69.71633C179.22301 85.3629 165.24248 101.00946 151.26195 116.65602C153.37562 137.5319 155.48929 158.40778 157.60295 179.28367C138.40197 170.82244 119.20098 162.36122 100 153.9C80.79902 162.36122 61.59803 170.82244 42.39705 179.28367C44.51071 158.40778 46.62438 137.5319 48.73805 116.65602C34.75752 101.00946 20.77699 85.3629 6.79646 69.71633C27.30377 65.27555 47.81107 60.83477 68.31837 56.39398C78.87892 38.26266 89.43946 20.13133 100 2Z\"/>",
    clip: "<path d=\"M100 2C110.56054 20.13133 121.12108 38.26266 131.68163 56.39398C152.18893 60.83477 172.69623 65.27555 193.20354 69.71633C179.22301 85.3629 165.24248 101.00946 151.26195 116.65602C153.37562 137.5319 155.48929 158.40778 157.60295 179.28367C138.40197 170.82244 119.20098 162.36122 100 153.9C80.79902 162.36122 61.59803 170.82244 42.39705 179.28367C44.51071 158.40778 46.62438 137.5319 48.73805 116.65602C34.75752 101.00946 20.77699 85.3629 6.79646 69.71633C27.30377 65.27555 47.81107 60.83477 68.31837 56.39398C78.87892 38.26266 89.43946 20.13133 100 2Z\"/>",
    anchor: { x: 113.82, y: 125.43, scale: 0.791 },
  },
};

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botMascotBody(value: unknown): MascotBodyId {
  return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}
