import { useCallback, useEffect, useRef, useState } from "react";
import { listSkills, type SkillsPage } from "@/lib/skills-api";
import { SKILL_PAGE_SIZE } from "../../../shared/skill-pagination";

/** One request lifecycle for Settings and Add a skill. Filter changes invalidate
 * in-flight pages immediately, including the debounce window and unmount. */
export function useSkillsBrowser() {
  const [query, setQueryValue] = useState("");
  const [category, setCategoryValue] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SkillsPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const generation = useRef(0);
  const invalidate = () => { ++generation.current; setBusy(true); setError(""); };
  const setQuery = (value: string) => { if (value === query) return; invalidate(); setQueryValue(value); setOffset(0); };
  const setCategory = (value: string) => { if (value === category && !query) return; invalidate(); setCategoryValue(value); setQueryValue(""); setOffset(0); };
  const goToPage = (value: number) => { if (value === offset) return; invalidate(); setOffset(value); };
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setBusy(true);
    try {
      const next = await listSkills({ q: query, category, offset, limit: SKILL_PAGE_SIZE });
      if (mine === generation.current) { setPage(next); setError(""); }
    } catch (cause) {
      if (mine === generation.current) setError(cause instanceof Error ? cause.message : "Skills couldn't be loaded.");
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }, [query, category, offset]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => { clearTimeout(timer); ++generation.current; };
  }, [load, query]);
  return { query, category, page, error, busy, setQuery, setCategory, goToPage, load };
}
