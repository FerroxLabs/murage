// A skill's category in plain words (settings v10 K1). The library's
// frontmatter carries about 80 raw labels, some of them per-pack codenames;
// the Skills page shows a short list of names a person recognises.
export const OTHER_CATEGORY = "Other";

const RAW_TO_PLAIN: Record<string, string> = {
  "software-engineering": "Software engineering", "software-project": "Software engineering", "software-development": "Software engineering", engineering: "Software engineering",
  "web-development": "Web development",
  "backend-systems": "Backend and systems",
  "devops-cloud": "DevOps and cloud",
  security: "Security",
  "testing-quality": "Testing and quality",
  "data-analysis": "Data analysis", "data-engineering": "Data engineering",
  "ai-machine-learning": "AI and machine learning",
  "emerging-tech": "Emerging technology",
  "game-development": "Game development",
  writing: "Writing", copy: "Writing", documentation: "Writing",
  content: "Content creation", "content-creation": "Content creation",
  "design-creative": "Design", "creative-arts": "Creative arts", "creative-project": "Creative arts", creative: "Creative arts",
  "business-strategy": "Business strategy", business: "Business strategy",
  "business-operations": "Business operations", operations: "Business operations", compliance: "Business operations",
  "marketing-sales": "Marketing and sales", marketing: "Marketing and sales", sales: "Marketing and sales", market: "Marketing and sales", commerce: "Marketing and sales", support: "Marketing and sales",
  "personal-finance": "Personal finance", finance: "Personal finance",
  "career-development": "Career", career: "Career",
  hr: "People and HR",
  education: "Education",
  productivity: "Productivity",
  "health-wellness": "Health and wellness",
  "home-household": "Home and household",
  "family-relationships": "Family and relationships",
  "hobbies-crafts": "Hobbies and crafts",
  "travel-experiences": "Travel and experiences",
  "legal-civic": "Legal and civic", legal: "Legal and civic",
  sustainability: "Sustainability",
  "life-event": "Life events",
  research: "Research",
};

/** The plain category for a raw frontmatter label. Unknown or missing lands in Other. */
export function plainCategory(raw: unknown): string {
  if (typeof raw !== "string") return OTHER_CATEGORY;
  return RAW_TO_PLAIN[raw.trim().toLowerCase()] ?? OTHER_CATEGORY;
}

/** The distinct plain names, for tests and the manifest generator. */
export const PLAIN_CATEGORIES: readonly string[] = [...new Set(Object.values(RAW_TO_PLAIN)), OTHER_CATEGORY];

/** A frontmatter `category:` (top level or under `metadata:`) from a SKILL.md, quotes removed. */
export function frontmatterCategory(skillMd: string): string | null {
  const text = skillMd.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const match = /^[ \t]*category:[ \t]*(.+?)[ \t]*$/m.exec(text.slice(4, end));
  if (!match) return null;
  return match[1]!.replace(/^["']|["']$/g, "").trim() || null;
}
