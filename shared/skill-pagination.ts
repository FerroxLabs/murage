// A fixed page keeps every library view bounded as the shipped library grows.
export const SKILL_PAGE_SIZE = 60;
export interface SkillPagination {
  offset: number;
  limit: number;
  total: number;
}
