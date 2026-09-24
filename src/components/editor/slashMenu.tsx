// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "/" command menu for the rich Markdown editor, ported from Wayland's
// TipTap editor. Typing "/" opens a filterable list anchored to the cursor.
// Arrow keys move, Enter runs the command, Escape closes.
//
// The Suggestion plugin pushes all menu state (items, anchor rect, command)
// through a React state setter instead of mounting its own renderer, and the
// editor renders <SlashMenuPopup> from its own tree. That sidesteps the
// React 19 / TipTap ReactRenderer problem where `.element` can be null when
// the portal is appended.
import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { SuggestionPluginKey } from "@tiptap/suggestion";
import {
  AlignLeft,
  Braces,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  Minus,
  Quote,
  Table,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";

export interface SlashItem {
  label: string;
  description: string;
  keywords: string[];
  icon: LucideIcon;
  action(args: { editor: Editor; range: Range }): void;
}

export const SLASH_ITEMS: readonly SlashItem[] = Object.freeze([
  {
    label: "Text",
    description: "Plain paragraph",
    keywords: ["text", "paragraph", "plain", "p"],
    icon: AlignLeft,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setParagraph().run(); },
  },
  {
    label: "Heading 1",
    description: "Large section heading",
    keywords: ["heading", "h1", "title", "large"],
    icon: Heading1,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(); },
  },
  {
    label: "Heading 2",
    description: "Medium section heading",
    keywords: ["heading", "h2", "subtitle", "medium"],
    icon: Heading2,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(); },
  },
  {
    label: "Heading 3",
    description: "Small section heading",
    keywords: ["heading", "h3", "small"],
    icon: Heading3,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(); },
  },
  {
    label: "Bulleted list",
    description: "Simple bullet list",
    keywords: ["bullet", "list", "unordered", "ul"],
    icon: List,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleBulletList().run(); },
  },
  {
    label: "Numbered list",
    description: "List with 1., 2., 3.",
    keywords: ["numbered", "list", "ordered", "ol"],
    icon: ListOrdered,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleOrderedList().run(); },
  },
  {
    label: "Task list",
    description: "Track to-dos with checkboxes",
    keywords: ["task", "todo", "to-do", "checkbox", "check"],
    icon: ListTodo,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleList("taskList", "taskItem").run(); },
  },
  {
    label: "Quote",
    description: "Pull-quote block",
    keywords: ["quote", "blockquote", "citation"],
    icon: Quote,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setBlockquote().run(); },
  },
  {
    label: "Code block",
    description: "Multi-line code in a monospace font",
    keywords: ["code", "codeblock", "pre", "fenced"],
    icon: Braces,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleCodeBlock().run(); },
  },
  {
    label: "Inline code",
    description: "Wrap in `backticks`",
    keywords: ["code", "inline", "mono"],
    icon: Code,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setMark("code").run(); },
  },
  {
    label: "Divider",
    description: "Horizontal rule across the page",
    keywords: ["divider", "hr", "horizontal", "rule", "separator"],
    icon: Minus,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setHorizontalRule().run(); },
  },
  {
    label: "Table",
    description: "3 by 3 grid with a header row",
    keywords: ["table", "grid", "rows", "columns"],
    icon: Table,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); },
  },
  {
    label: "Bulleted list (nested)",
    description: "List that can have sub-items",
    keywords: ["nested", "tree", "sub", "hierarchy", "outline"],
    icon: ListTree,
    action: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleBulletList().run(); },
  },
] satisfies SlashItem[]);

/** Items whose label or keywords contain the typed query. All 13 show for an
 *  empty query; the menu scrolls. */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter(item => item.label.toLowerCase().includes(q) || item.keywords.some(keyword => keyword.includes(q)));
}

export interface SlashState {
  items: SlashItem[];
  command(item: SlashItem): void;
  rect: DOMRect | null;
}

/** Handle the popup exposes so the Suggestion plugin can forward keys. */
export interface SlashKeyHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

interface SlashMenuPopupProps extends SlashState {
  keyHandleRef: MutableRefObject<SlashKeyHandle | null>;
  onClose(): void;
}

const POPUP_HEIGHT = 340;
const POPUP_WIDTH = 290;
const VIEWPORT_PADDING = 8;

export function SlashMenuPopup({ items, command, rect, keyHandleRef, onClose }: SlashMenuPopupProps) {
  const [selected, setSelected] = useState(0);
  const current = items.length === 0 ? 0 : Math.min(Math.max(selected, 0), items.length - 1);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSelected(0); }, [items]);

  // Any mousedown outside the popup closes it.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (popupRef.current && target && popupRef.current.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [onClose]);

  useEffect(() => {
    keyHandleRef.current = {
      onKeyDown: event => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") { setSelected((current + 1) % items.length); return true; }
        if (event.key === "ArrowUp") { setSelected((current - 1 + items.length) % items.length); return true; }
        if (event.key === "Enter") {
          const item = items[current];
          if (item) command(item);
          return true;
        }
        return false;
      },
    };
    return () => { keyHandleRef.current = null; };
  }, [items, command, current, keyHandleRef]);

  useEffect(() => {
    popupRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  // Anchor below the cursor, flip above when there is no room, clamp to the
  // viewport. Portaled to <body> so a transformed ancestor cannot re-base
  // `position: fixed`.
  const flipAbove = rect ? rect.bottom + POPUP_HEIGHT + 12 > window.innerHeight : false;
  const left = Math.round(Math.max(VIEWPORT_PADDING, Math.min(rect?.left ?? 0, window.innerWidth - POPUP_WIDTH - VIEWPORT_PADDING)));
  const top = Math.round(Math.max(VIEWPORT_PADDING, rect ? (flipAbove ? rect.top - POPUP_HEIGHT - 6 : rect.bottom + 6) : 0));

  return createPortal(
    <div ref={popupRef} className="rme-slash-portal" style={{ left, top }}>
      {items.length === 0 ? (
        <div className="rme-slash"><div className="rme-slash-empty">No commands match</div></div>
      ) : (
        <div className="rme-slash" role="listbox" aria-label="Insert a block">
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="option"
                aria-selected={index === current}
                className={`rme-slash-item${index === current ? " rme-slash-item-active" : ""}`}
                onMouseDown={event => { event.preventDefault(); command(item); }}
                onMouseEnter={() => setSelected(index)}
              >
                <span className="rme-slash-icon"><Icon size={17} aria-hidden="true" /></span>
                <span className="rme-slash-body">
                  <span className="rme-slash-label">{item.label}</span>
                  <span className="rme-slash-desc">{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The TipTap extension. `setState(null)` hides the popup; `keyRef` is where
 *  the popup puts its key handler. */
export function createSlashCommand(
  setState: (state: SlashState | null) => void,
  keyRef: MutableRefObject<SlashKeyHandle | null>,
): Extension {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) => filterSlashItems(query),
          command: ({ editor, range, props }) => {
            props.action({ editor, range });
            setState(null);
          },
          render: () => ({
            onStart: props => setState({ items: props.items, command: props.command, rect: props.clientRect?.() ?? null }),
            onUpdate: props => setState({ items: props.items, command: props.command, rect: props.clientRect?.() ?? null }),
            onKeyDown: props => {
              if (props.event.key === "Escape") { setState(null); return true; }
              return keyRef.current?.onKeyDown(props.event) ?? false;
            },
            // The drag handle's positioning transactions can make Suggestion
            // report an exit a frame after it opens, so an exit is only
            // trusted once the plugin itself says the "/" range is gone
            // (deleted, or a space typed after it).
            onExit: props => {
              setTimeout(() => {
                const plugin = props.editor.isDestroyed ? null : SuggestionPluginKey.getState(props.editor.state) as { active?: boolean } | undefined;
                if (!plugin?.active) setState(null);
              }, 30);
            },
          }),
        }),
      ];
    },
  });
}
