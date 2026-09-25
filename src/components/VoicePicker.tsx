// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's voice picker: a list you can listen down. Every row has its own
// play button, so a voice can be heard without choosing it first.
//
// The list is the ARIA listbox pattern with roving focus on the rows: arrows,
// Home, End, Page Up and Page Down move; typing a name jumps to it; Enter or
// Space chooses. An option may not hold a button, so the play buttons are a
// column laid over the right edge of the rows, outside the listbox, in the
// same scrolling box. Every row is the same height, which is what lines the
// two up. Only the active row's play button is in the Tab order, right after
// the list itself; the rest are one click away.
//
// Nothing here talks to the network: the caller owns the list and the
// speaker, and a preview is only made when a play button is pressed.
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, Play, Search, Square, X } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  filterVoices,
  listKey,
  pickerFilters,
  previewButton,
  sortVoices,
  typeAhead,
  type GenderFilter,
  type PickerVoice,
  type RowPreviewState,
} from "./voice-picker-model";

/** Every row is this tall, the play column included. At least 44px. */
const ROW = 52;
const GENDER_LABEL = { female: "Female", male: "Male", neutral: "Neutral" } as const;

export interface VoicePickerProps {
  voices: PickerVoice[];
  /** Rows kept first and never filtered: "Workspace default", a saved voice
   *  the list no longer has. */
  pinned?: PickerVoice[];
  /** The chosen provider id; "" for the workspace default. */
  value: string;
  onChange: (id: string) => void;
  /** The list's accessible name, e.g. "Nova's voice". */
  label: string;
  loading?: boolean;
  preview: (id: string) => { state: RowPreviewState; error?: string };
  /** Play the voice, or stop it when it is the one playing. */
  onPreview: (id: string) => void;
}

export function VoicePicker({ voices, pinned = [], value, onChange, label, loading, preview, onPreview }: VoicePickerProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<GenderFilter>("all");
  const [accent, setAccent] = useState("all");
  const sorted = useMemo(() => sortVoices(voices), [voices]);
  const filters = useMemo(() => pickerFilters(voices), [voices]);
  const filtering = Boolean(query.trim()) || gender !== "all" || accent !== "all";
  const rows = useMemo(
    () => [...(filtering ? [] : pinned), ...filterVoices(sorted, { query, gender, accent })],
    [filtering, pinned, sorted, query, gender, accent],
  );
  const selectedIndex = rows.findIndex((v) => v.id === value);
  const [active, setActive] = useState(-1);
  const current = active >= 0 && active < rows.length ? active : Math.max(selectedIndex, 0);

  const scroller = useRef<HTMLDivElement>(null);
  const options = useRef<Array<HTMLDivElement | null>>([]);
  const typed = useRef({ text: "", at: 0 });

  // The chosen voice is in view whenever the list changes under it: when the
  // voices arrive, and after a filter.
  const rowsKey = rows.map((v) => v.id).join("\n");
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    setActive(-1);
    const at = rows.findIndex((v) => v.id === value);
    box.scrollTop = at < 0 ? 0 : Math.max(0, at * ROW - (box.clientHeight - ROW) / 2);
    // value is read, not watched: choosing a voice must not jump the list
  }, [rowsKey]);

  const focusRow = (index: number) => {
    setActive(index);
    const option = options.current[index];
    option?.focus();
    option?.scrollIntoView?.({ block: "nearest" });
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const moved = listKey(event.key, current, rows.length);
    if (moved !== null) {
      event.preventDefault();
      focusRow(moved);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      // a space inside a name being typed is part of the name
      if (event.key === " " && typed.current.text && Date.now() - typed.current.at < 600) {
        event.preventDefault();
        typed.current = { text: `${typed.current.text} `, at: Date.now() };
        return;
      }
      event.preventDefault();
      const voice = rows[current];
      if (voice) onChange(voice.id);
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now();
      const text = now - typed.current.at < 600 ? typed.current.text + event.key : event.key;
      typed.current = { text, at: now };
      const found = typeAhead(rows, text.trimEnd(), current);
      if (found >= 0) {
        event.preventDefault();
        focusRow(found);
      }
    }
  };

  const failed = rows.map((v) => ({ voice: v, ...preview(v.id) })).find((r) => r.state === "error");
  const clear = () => {
    setQuery("");
    setGender("all");
    setAccent("all");
  };

  return (
    <div>
      <div className="relative">
        <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && rows.length) {
              e.preventDefault();
              focusRow(current);
            }
          }}
          placeholder="Search voices"
          aria-label="Search voices"
          aria-controls={listId}
          autoComplete="off"
          className="h-11 w-full rounded-lg border border-hairline/40 bg-inset pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      {(filters.genders.length > 1 || filters.accents.length > 0) && (
        <div role="group" aria-label="Filter voices" className="mt-2 flex flex-wrap gap-x-1.5 gap-y-3 py-1.5">
          {filters.genders.length > 1 && (
            <>
              <Chip pressed={gender === "all"} onClick={() => setGender("all")}>All</Chip>
              {filters.genders.map((g) => (
                <Chip key={g} pressed={gender === g} onClick={() => setGender(gender === g ? "all" : g)}>
                  {GENDER_LABEL[g]}
                </Chip>
              ))}
            </>
          )}
          {filters.genders.length > 1 && filters.accents.length > 0 && <span aria-hidden className="mx-1 my-1.5 hidden w-px bg-hairline/50 sm:block" />}
          {filters.accents.map((a) => (
            <Chip key={a} pressed={accent === a} onClick={() => setAccent(accent === a ? "all" : a)}>
              {a}
            </Chip>
          ))}
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {loading ? "" : filtering ? `${rows.length} of ${voices.length} voices` : ""}
      </div>

      <div
        ref={scroller}
        className="relative mt-2 max-h-[min(364px,50dvh)] overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-inset"
      >
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          aria-busy={loading || undefined}
          onKeyDown={onListKey}
          // With no rows there is nothing to focus inside, so the list itself
          // stays reachable and says why it is empty.
          tabIndex={rows.length ? undefined : 0}
          className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {rows.map((voice, index) => {
            const selected = voice.id === value;
            const row = preview(voice.id);
            return (
              <div
                key={voice.id || "(default)"}
                ref={(el) => {
                  options.current[index] = el;
                }}
                id={`${uid}-o${index}`}
                role="option"
                aria-selected={selected}
                tabIndex={index === current ? 0 : -1}
                onClick={() => {
                  setActive(index);
                  onChange(voice.id);
                }}
                onFocus={() => setActive(index)}
                style={{ height: ROW }}
                data-voice={voice.id}
                className={cn(
                  "relative flex cursor-pointer items-center gap-2.5 pl-3 pr-14 outline-none",
                  "focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                  selected ? "bg-accent/12 hover:bg-accent/18" : "hover:bg-raised-hover/60",
                  index > 0 && "border-t border-hairline/25",
                )}
              >
                <span aria-hidden className={cn("absolute inset-y-2 left-0 w-[3px] rounded-r-full", selected ? "bg-accent" : "bg-transparent")} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13.5px] leading-5", selected ? "font-medium text-ink" : "text-ink")}>
                    {voice.label}
                  </span>
                  {row.state === "error" ? (
                    <span className="block truncate text-[12px] leading-4 text-danger">Couldn't play</span>
                  ) : (
                    voice.description && (
                      <span className="block truncate text-[12px] leading-4 text-ink-secondary">{capitalise(voice.description)}</span>
                    )
                  )}
                </span>
                {voice.gender && gender === "all" && (
                  <span className="hidden shrink-0 text-[11px] text-ink-secondary sm:inline">{GENDER_LABEL[voice.gender]}</span>
                )}
                {selected ? <Check size={15} aria-hidden className="shrink-0 text-accent-text" /> : <span aria-hidden className="w-[15px] shrink-0" />}
              </div>
            );
          })}
        </div>

        {/* The play column: one button per row, same height, same order. */}
        <div className="pointer-events-none absolute right-1 top-0">
          {rows.map((voice, index) => {
            const row = preview(voice.id);
            const button = previewButton(row.state, voice.label);
            return (
              <div key={voice.id || "(default)"} style={{ height: ROW }} className="flex items-center">
                <button
                  type="button"
                  tabIndex={index === current ? 0 : -1}
                  onClick={() => onPreview(voice.id)}
                  aria-label={button.label}
                  aria-busy={row.state === "loading" || undefined}
                  title={button.text}
                  data-preview={row.state}
                  className={cn(
                    "pointer-events-auto flex size-11 items-center justify-center rounded-full outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-accent",
                    row.state === "playing" || row.state === "loading"
                      ? "bg-accent/15 text-accent-text hover:bg-accent/25"
                      : "text-ink-secondary hover:bg-control hover:text-ink",
                  )}
                >
                  {row.state === "loading" ? (
                    <Loader2 size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
                  ) : row.state === "playing" ? (
                    <Square size={13} aria-hidden fill="currentColor" />
                  ) : (
                    <Play size={15} aria-hidden fill="currentColor" className="translate-x-px" />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {!rows.length && (
          <div className="flex flex-col items-center gap-1 px-4 py-6 text-center text-[12.5px] text-ink-secondary">
            {loading ? (
              <span className="inline-flex items-center gap-2"><Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" />Loading voices</span>
            ) : filtering ? (
              <>
                <span>No voices match.</span>
                <button type="button" onClick={clear} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 font-medium text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <X size={13} aria-hidden />Clear filters
                </button>
              </>
            ) : (
              <span>No voices to show.</span>
            )}
          </div>
        )}
      </div>

      {failed && (
        <div role="alert" className="mt-1.5 text-[11.5px] text-danger">
          Couldn't play {failed.voice.label}. {failed.error}
        </div>
      )}
    </div>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      // 32px to look at, 44px to hit: the ::after reaches 6px above and below
      className={cn(
        "relative h-8 rounded-full px-3 text-[12.5px] outline-none transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
        "focus-visible:ring-2 focus-visible:ring-accent",
        pressed ? "bg-accent/15 font-medium text-accent-text" : "bg-control text-ink-secondary hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

