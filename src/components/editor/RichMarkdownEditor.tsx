// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rich Markdown editor, ported from Wayland's TipTap editor:
//   - a sticky top toolbar (headings, marks, lists, quote, link, divider,
//     undo and redo), always there to find
//   - a bubble menu on a text selection for quick inline formatting
//   - "/" for a menu of blocks (headings, lists, task list, table, code...)
//   - a drag handle on hover: "+" adds a block below, the grip reorders
//   - a placeholder on the empty line: "Press '/' for commands..."
//   - resizable tables, nested task lists, inline link editing
//   - a streaming mode where a bot's text replaces the document live
//
// Markdown goes through Murage's own layer (@tiptap/markdown with the
// extension set from markdown-fidelity.ts), so what the editor shows is
// what the fidelity check proved. The extra extensions here (placeholder,
// slash menu, drag handle) never change the schema or the Markdown.
//
// Two ways in: <RichMarkdownEditor> owns its editor (skills, House Rules),
// and useRichEditorKit + <RichEditorFrame> wrap an editor the caller builds
// (the workspace file editor, which keeps its own save cycle).
import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Check,
  Code,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";

import { createMarkdownExtensions, EMPTY_MARKDOWN_DOC } from "@/lib/markdown-fidelity";
import { createSlashCommand, SlashMenuPopup, type SlashKeyHandle, type SlashState } from "./slashMenu";
import "./rich-markdown-editor.css";

export const RICH_EDITOR_PLACEHOLDER = "Press '/' for commands, or just start typing…";

/** Editor content for a rich body. Tiptap parses an empty string as HTML
 * (not Markdown), so an empty body loads the empty document instead. */
export function richEditorContent(body: string): { content: string; contentType: "markdown" } | { content: typeof EMPTY_MARKDOWN_DOC } {
  return body === "" ? { content: EMPTY_MARKDOWN_DOC } : { content: body, contentType: "markdown" };
}

export interface RichEditorKit {
  extensions: ReturnType<typeof createMarkdownExtensions>;
  slash: SlashState | null;
  closeSlash(): void;
  slashKeyRef: MutableRefObject<SlashKeyHandle | null>;
}

/** The extension set of the live editor: the Markdown set the fidelity check
 *  uses, plus the placeholder and the slash menu. Stable for the component's
 *  life, so it can go straight into useEditor. */
export function useRichEditorKit(placeholder: string = RICH_EDITOR_PLACEHOLDER): RichEditorKit {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashKeyRef = useRef<SlashKeyHandle | null>(null);
  const extensions = useMemo(() => [
    ...createMarkdownExtensions({ resizableTables: true }),
    Placeholder.configure({
      showOnlyCurrent: true,
      showOnlyWhenEditable: true,
      placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : placeholder),
    }),
    createSlashCommand(setSlash, slashKeyRef),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);
  const closeSlash = useCallback(() => setSlash(null), []);
  return { extensions, slash, closeSlash, slashKeyRef };
}

// ---- toolbar ------------------------------------------------------------------

function ToolbarButton({ active, disabled, title, onClick, children }: { active?: boolean; disabled?: boolean; title: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
      className={`rme-btn${active ? " rme-btn-active" : ""}`}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="rme-divider" aria-hidden="true" />;

/** The small inline field that replaces window.prompt for links. */
function LinkField({ editor, onDone }: { editor: Editor; onDone(): void }) {
  const current = editor.getAttributes("link").href as string | undefined;
  const [href, setHref] = useState(current ?? "https://");
  const apply = () => {
    const url = href.trim();
    if (!url || url === "https://") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    onDone();
  };
  const remove = () => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); onDone(); };
  const cancel = () => { editor.commands.focus(); onDone(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); apply(); }
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
  };
  return (
    <span className="rme-link" role="group" aria-label="Link">
      <input
        autoFocus
        type="url"
        value={href}
        onChange={event => setHref(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Link address"
        placeholder="https://"
        className="rme-link-input"
      />
      <ToolbarButton title="Apply link" onClick={apply}><Check size={15} aria-hidden="true" /></ToolbarButton>
      {current ? <ToolbarButton title="Remove link" onClick={remove}><Unlink size={15} aria-hidden="true" /></ToolbarButton> : null}
      <ToolbarButton title="Cancel" onClick={cancel}><X size={15} aria-hidden="true" /></ToolbarButton>
    </span>
  );
}

function FormatButtons({ editor, variant }: { editor: Editor; variant: "full" | "bubble" }) {
  const [linkOpen, setLinkOpen] = useState(false);
  if (linkOpen && variant === "bubble") return <LinkField editor={editor} onDone={() => setLinkOpen(false)} />;
  const chain = () => editor.chain().focus();
  return (
    <>
      <ToolbarButton title="Heading 1" active={editor.isActive("heading", { level: 1 })} onClick={() => chain().toggleHeading({ level: 1 }).run()}><Heading1 size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive("heading", { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive("heading", { level: 3 })} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 size={16} aria-hidden="true" /></ToolbarButton>
      <Divider />
      <ToolbarButton title="Bold (⌘B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><Bold size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Italic (⌘I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><Italic size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><Strikethrough size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Inline code" active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}><Code size={16} aria-hidden="true" /></ToolbarButton>
      <Divider />
      <ToolbarButton title="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}><List size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={16} aria-hidden="true" /></ToolbarButton>
      <ToolbarButton title="Quote" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}><Quote size={16} aria-hidden="true" /></ToolbarButton>
      <Divider />
      <ToolbarButton title="Link" active={editor.isActive("link") || linkOpen} onClick={() => setLinkOpen(open => !open)}><LinkIcon size={16} aria-hidden="true" /></ToolbarButton>
      {variant === "full" && (
        <>
          <ToolbarButton title="Divider" onClick={() => chain().setHorizontalRule().run()}><Minus size={16} aria-hidden="true" /></ToolbarButton>
          <Divider />
          <ToolbarButton title="Undo (⌘Z)" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}><Undo2 size={16} aria-hidden="true" /></ToolbarButton>
          <ToolbarButton title="Redo (⌘⇧Z)" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}><Redo2 size={16} aria-hidden="true" /></ToolbarButton>
          {linkOpen ? <LinkField editor={editor} onDone={() => setLinkOpen(false)} /> : null}
        </>
      )}
    </>
  );
}

// ---- frame --------------------------------------------------------------------

export interface RichEditorFrameProps {
  editor: Editor | null;
  kit: RichEditorKit;
  editable: boolean;
  isStreaming?: boolean;
  className?: string;
}

/** Toolbar, bubble menu, slash menu and drag handle around an editor. */
export function RichEditorFrame({ editor, kit, editable, isStreaming = false, className = "" }: RichEditorFrameProps) {
  const [hoveredPos, setHoveredPos] = useState<number | null>(null);
  // Re-render the toolbar only when the active marks or nodes change; a
  // plain transaction listener fires constantly from the drag handle.
  useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return "";
      return [
        current.isActive("heading", { level: 1 }), current.isActive("heading", { level: 2 }), current.isActive("heading", { level: 3 }),
        current.isActive("bold"), current.isActive("italic"), current.isActive("strike"), current.isActive("code"),
        current.isActive("bulletList"), current.isActive("orderedList"), current.isActive("blockquote"), current.isActive("link"),
        current.can().undo(), current.can().redo(),
      ].join("|");
    },
  });
  // Stable callbacks: fresh closures make the menus rebuild their plugins
  // on every render, which can end the slash menu right after it opens.
  const handleNodeChange = useCallback(({ pos }: { pos: number }) => setHoveredPos(pos), []);
  const bubbleShouldShow = useCallback(({ state }: { state: { selection: { from: number; to: number; empty: boolean } } }) => {
    const { from, to, empty } = state.selection;
    return !empty && from !== to;
  }, []);
  const insertBlockBelow = useCallback(() => {
    if (!editor || hoveredPos == null || hoveredPos < 0) return;
    const node = editor.state.doc.nodeAt(hoveredPos);
    if (!node) return;
    const at = hoveredPos + node.nodeSize;
    editor.chain().focus().insertContentAt(at, { type: "paragraph" }).setTextSelection(at + 1).run();
  }, [editor, hoveredPos]);

  const showChrome = Boolean(editor) && editable && !isStreaming;
  return (
    <div className={`rme${isStreaming ? " rme-streaming" : ""} ${className}`}>
      {isStreaming && <div className="rme-streaming-badge" role="status">Bot is writing…</div>}
      {kit.slash && <SlashMenuPopup {...kit.slash} keyHandleRef={kit.slashKeyRef} onClose={kit.closeSlash} />}
      {showChrome && editor && (
        <div className="rme-toolbar" role="toolbar" aria-label="Formatting">
          <FormatButtons editor={editor} variant="full" />
        </div>
      )}
      {showChrome && editor && (
        <BubbleMenu editor={editor} shouldShow={bubbleShouldShow}>
          <div className="rme-bubble" role="toolbar" aria-label="Selection formatting">
            <FormatButtons editor={editor} variant="bubble" />
          </div>
        </BubbleMenu>
      )}
      {showChrome && editor && (
        <DragHandle editor={editor} onNodeChange={handleNodeChange}>
          <div className="rme-handle">
            <button type="button" title="Add a block below" aria-label="Add a block below" className="rme-handle-btn" onMouseDown={event => event.preventDefault()} onClick={insertBlockBelow}>
              <Plus size={14} aria-hidden="true" />
            </button>
            {/* Not a button, so the drag listeners on the wrapper fire. */}
            <span title="Drag to move" aria-hidden="true" className="rme-handle-grip" data-drag-handle>
              <GripVertical size={14} />
            </span>
          </div>
        </DragHandle>
      )}
      <EditorContent editor={editor} className="rme-content" />
    </div>
  );
}

// ---- self-contained editor ------------------------------------------------------

export interface RichMarkdownEditorProps {
  /** Markdown body. A change the editor did not make itself (a reset, or a
   *  bot writing while `isStreaming`) replaces the document. */
  value: string;
  onChange?(markdown: string): void;
  readOnly?: boolean;
  isStreaming?: boolean;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}

export function RichMarkdownEditor({ value, onChange, readOnly = false, isStreaming = false, ariaLabel, placeholder, className }: RichMarkdownEditorProps) {
  const kit = useRichEditorKit(placeholder);
  const editable = !readOnly && !isStreaming;
  const lastValue = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initial = useMemo(() => richEditorContent(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useEditor({
    immediatelyRender: typeof window !== "undefined",
    extensions: kit.extensions,
    ...initial,
    injectCSS: false,
    editable,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": ariaLabel, class: "rme-prose" },
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      lastValue.current = markdown;
      onChangeRef.current?.(markdown);
    },
  });
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    const next = richEditorContent(value);
    editor.commands.setContent(next.content, { emitUpdate: false, ...("contentType" in next ? { contentType: next.contentType } : {}) });
  }, [editor, value]);
  return <RichEditorFrame editor={editor} kit={kit} editable={editable} isStreaming={isStreaming} className={className} />;
}
