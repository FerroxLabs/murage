// Client half of GET/PUT /api/section-context — a team's instructions.
// The harness owns validation (section must exist, 60-char name, 24KB cap)
// and returns the stored copy; callers render that copy, not their draft.

export interface SectionContextResponse {
  section: string;
  label: string;
  text: string;
  updatedAt: number | null;
  maxBytes: number;
}

type Request = (path: string, init?: { method: string; body: string }) => Promise<unknown>;

export function sectionContextPath(section: string): string {
  return `/api/section-context?section=${encodeURIComponent(section)}`;
}

export async function loadSectionContext(section: string, request: Request): Promise<SectionContextResponse> {
  return (await request(sectionContextPath(section))) as SectionContextResponse;
}

export async function saveSectionContext(section: string, text: string, request: Request): Promise<SectionContextResponse> {
  return (await request(sectionContextPath(section), { method: "PUT", body: JSON.stringify({ text }) })) as SectionContextResponse;
}
