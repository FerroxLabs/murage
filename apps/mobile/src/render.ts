// Draws one View. textContent only: nothing a scanned code or a computer's
// name contains can become markup.
import type { Act, Draft } from "./launcher";
import { CODE_LENGTH, computerRow, createCodeEntry, highlightIndex, hintFor } from "./code-entry";
import type { Action, View } from "./screens";

export interface FormValues {
  address: string;
  code: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let fields = 0;

/** A labelled input; the label is tied by id as well as by nesting. */
function field(name: string, label: string, type: string, placeholder: string) {
  const id = `field-${name}-${++fields}`;
  const wrap = el("div", "field");
  const caption = el("label", "field-label", label);
  caption.htmlFor = id;
  const input = el("input", "field-input");
  input.id = id;
  input.name = name;
  input.type = type;
  input.placeholder = placeholder;
  wrap.append(caption, input);
  return { wrap, input };
}

const SVG = "http://www.w3.org/2000/svg";

function svg(name: string, attributes: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/**
 * The Murage mark as the splash shows it (brand/app-icon.svg: the galaxy in
 * Forge Orange on a black tile), built in place: no fetch, no markup string.
 * Decorative: the title beside it names the app.
 */
function murageMark(): SVGElement {
  const mark = svg("svg", { class: "mark", viewBox: "0 0 1024 1024", "aria-hidden": "true", focusable: "false" });
  mark.append(svg("rect", { x: "100.4", y: "100.4", width: "823.3", height: "823.3", rx: "184.2", fill: "#000000" }));
  const galaxy = svg("g", {
    transform: "translate(265.01 265.01) scale(20.58240)",
    fill: "none",
    stroke: "#ff6b35",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  for (const d of [
    "M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001",
    "M17 21h.01",
    "M7 3h.01",
    "M7.997 8.891a11.885 7.288-60.756 0111.977 8.107",
  ]) {
    galaxy.append(svg("path", { d }));
  }
  galaxy.append(svg("circle", { cx: "12", cy: "12", r: "1", fill: "#ff6b35", stroke: "none" }));
  mark.append(galaxy);
  return mark;
}

function button(action: Action, onClick: () => void): HTMLButtonElement {
  const node = el("button", `button${action.primary ? " primary" : ""}${action.danger ? " danger" : ""}`, action.label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/** What a focused control is, to find its twin in a redrawn screen: its tag and its words. */
function focusKey(node: Element): string {
  return `${node.tagName}|${node.getAttribute("aria-label") ?? ""}|${node.getAttribute("name") ?? ""}|${node.textContent ?? ""}`;
}

/** The control in `screen` that matches the one focused in `root` before the redraw, if any. */
function focusLike(root: HTMLElement, screen: HTMLElement): HTMLElement | null {
  const focused = document.activeElement;
  if (!focused || focused === root || !root.contains(focused)) return null;
  const key = focusKey(focused);
  return [...screen.querySelectorAll<HTMLElement>("button, input, h1")].find((node) => focusKey(node) === key) ?? null;
}

/** `keep`: the same screen redrawn in place (a resume): focus and scroll stay where they were. */
export function render(root: HTMLElement, view: View, act: Act, draft?: Draft, keep = false): void {
  // First run: the text in the upper middle, the buttons at the bottom within thumb reach.
  const screen = el("section", view.layout === "firstRun" ? "screen first-run" : "screen");
  screen.setAttribute("aria-busy", view.busy ? "true" : "false");
  if (view.mark) screen.append(murageMark());
  if (view.step) screen.append(el("p", "step", `Step ${view.step} of 4`));
  const title = el("h1", "title", view.title);
  title.id = "screen-title";
  title.tabIndex = -1;
  screen.setAttribute("aria-labelledby", title.id);
  screen.append(title);
  for (const line of view.lines) screen.append(el("p", "line", line));
  if (view.image) {
    // Bundled with the launcher (Get your code ready): the desktop page, light or dark to match the phone.
    const picture = el("picture", "shot");
    const source = el("source");
    source.media = "(prefers-color-scheme: dark)";
    source.srcset = view.image.dark;
    const img = el("img");
    img.src = view.image.light;
    img.alt = view.image.alt;
    img.width = view.image.width;
    img.height = view.image.height;
    img.decoding = "async";
    picture.append(source, img);
    screen.append(picture);
  }
  if (view.busy) {
    const spinner = el("div", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    screen.append(spinner);
  }
  if (view.error) {
    const error = el("p", "error", view.error);
    error.setAttribute("role", "alert");
    screen.append(error);
  }

  if (view.rows.length) {
    const list = el("ul", "rows");
    for (const row of view.rows) {
      const item = el("li", "row");
      const open = row.actions.find((a) => a.id === "open");
      const remove = row.actions.find((a) => a.id === "remove");
      const main = el("button", "row-main");
      main.type = "button";
      main.append(el("span", "row-name", row.name), el("span", "row-detail", row.detail));
      if (open) {
        main.setAttribute("aria-label", `${row.name}. ${row.detail}`);
        main.addEventListener("click", () => act(open));
      } else {
        main.disabled = true;
      }
      item.append(main);
      if (remove) {
        const removeButton = button(remove, () => act(remove));
        removeButton.classList.add("small");
        removeButton.setAttribute("aria-label", `Remove ${row.name}`);
        item.append(removeButton);
      }
      list.append(item);
    }
    screen.append(list);
  }

  let values: () => FormValues = () => ({ address: "", code: "" });
  let submitConnect: (() => void) | undefined;
  if (view.form) {
    const form = el("form", "form");
    form.noValidate = true;
    const address = field("address", "Address", "url", "your-computer.tail1234.ts.net");
    address.input.autocapitalize = "none";
    address.input.spellcheck = false;
    address.input.setAttribute("autocomplete", "url");
    address.input.enterKeyHint = "next";
    if (draft) address.input.value = draft.address;
    else if (view.form.origin) address.input.value = view.form.origin.replace(/^https:\/\//, "");

    // Code: one real input, visually hidden, over six display-only boxes.
    const codeId = `field-code-${++fields}`;
    const helpId = `${codeId}-help`;
    const codeWrap = el("div", "field");
    const codeLabel = el("label", "field-label", "Six-digit code");
    codeLabel.htmlFor = codeId;
    const boxes = el("div", "code-boxes");
    const cells: HTMLElement[] = [];
    for (let i = 0; i < CODE_LENGTH; i++) {
      const cell = el("span", "code-box");
      cell.setAttribute("aria-hidden", "true");
      cells.push(cell);
      boxes.append(cell);
    }
    const codeInput = el("input", "code-input");
    codeInput.id = codeId;
    codeInput.name = "code";
    codeInput.type = "text";
    codeInput.inputMode = "numeric";
    codeInput.autocomplete = "one-time-code";
    codeInput.enterKeyHint = "go";
    codeInput.autocapitalize = "none";
    codeInput.spellcheck = false;
    codeInput.setAttribute("aria-describedby", helpId);
    boxes.append(codeInput);
    const help = el("p", "code-help");
    help.id = helpId;
    codeWrap.append(codeLabel, boxes, help);

    const paint = () => {
      const typed = codeInput.value;
      const focused = document.activeElement === codeInput;
      const at = highlightIndex(codeInput.selectionStart, typed.length);
      cells.forEach((cell, i) => {
        cell.textContent = typed[i] ?? "";
        cell.classList.toggle("filled", i < typed.length);
        cell.classList.toggle("active", focused && i === at);
      });
      boxes.classList.toggle("focused", focused);
    };
    // The highlight follows the real caret. Nothing here moves it, so an
    // explicit selection (select all, then paste), an IME's marked text and a
    // screen reader's moves are left alone.
    document.addEventListener("selectionchange", function onSelection() {
      if (!codeInput.isConnected) document.removeEventListener("selectionchange", onSelection);
      else if (document.activeElement === codeInput) paint();
    });

    values = () => ({ address: address.input.value, code: entry.digits });
    const connect = view.actions.find((a) => a.id === "connect");
    const entry = createCodeEntry(
      () => address.input.value.trim() !== "",
      (digits) => {
        if (connect) act(connect, { address: address.input.value, code: digits });
      },
    );
    // Before an explicit submit the field is the truth, not the last event.
    const reconcile = () => settle(false);
    submitConnect = () => {
      reconcile();
      entry.enter();
    };
    const syncHint = () => {
      help.textContent = hintFor(address.input.value.trim() !== "", entry.needsConfirm, entry.digits.length === CODE_LENGTH);
    };
    syncHint();
    address.input.addEventListener("input", () => {
      entry.addressChanged();
      syncHint();
    });
    // Only a non-composing input event may connect by itself; blur,
    // compositionend and submit just normalize.
    const settle = (mayConnect: boolean) => {
      const digits = mayConnect ? entry.input(codeInput.value) : entry.sync(codeInput.value);
      if (codeInput.value !== digits) codeInput.value = digits;
      paint();
      syncHint();
    };
    // Composition is tracked by the event's own isComposing flag, never by
    // state that a missing compositionend could leave stuck.
    codeInput.addEventListener("compositionend", () => settle(false));
    codeInput.addEventListener("input", (event) => {
      // An input event that is not composing means any composition is over,
      // even if compositionend never arrived.
      if ((event as InputEvent).isComposing) return;
      settle(true);
    });
    // Landing in the field starts after the last digit; after that the caret is the person's.
    codeInput.addEventListener("focus", () => {
      const end = codeInput.value.length;
      codeInput.setSelectionRange(end, end);
      paint();
    });
    codeInput.addEventListener("blur", () => {
      settle(false); // a composition cannot outlive focus; leaving never pairs
    });
    // A later tap lands the caret by the input's own glyph positions, which do
    // not match the boxes. Send it to the end unless the person has made a real
    // selection (select all, then paste).
    const caretToEnd = () => {
      if (codeInput.selectionStart !== codeInput.selectionEnd) return;
      const end = codeInput.value.length;
      codeInput.setSelectionRange(end, end);
      paint();
    };
    codeInput.addEventListener("click", caretToEnd);
    codeInput.addEventListener("pointerup", caretToEnd);
    boxes.addEventListener("click", () => codeInput.focus());

    // Computer row when the address is known; the input itself otherwise.
    const computerName = computerRow(address.input.value, view.form, draft !== undefined);
    if (computerName !== null) {
      address.wrap.hidden = true;
      const row = el("div", "computer-row");
      const rowText = el("div", "computer-text");
      rowText.append(el("span", "computer-label", "Computer"), el("span", "computer-name", computerName));
      const change = el("button", "button small", "Change");
      change.type = "button";
      change.setAttribute("aria-label", `Change computer, now ${computerName}`);
      change.addEventListener("click", () => {
        row.hidden = true;
        address.wrap.hidden = false;
        address.input.focus();
      });
      row.append(rowText, change);
      form.append(row);
    }
    form.append(address.wrap, codeWrap);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    // Return never submits by itself. On the address it moves to the code (the
    // keyboard says Next); on the code it connects (the keyboard says Go).
    address.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      codeInput.focus();
    });
    codeInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      reconcile();
      entry.enter();
    });
    screen.append(form);
  }

  if (view.actions.length) {
    const actions = el("div", "actions");
    for (const action of view.actions) {
      actions.append(button(action, () => (action.id === "connect" && submitConnect ? submitConnect() : act(action, values()))));
    }
    screen.append(actions);
  }

  if (keep) {
    const scrolled = window.scrollY;
    const again = focusLike(root, screen);
    root.replaceChildren(screen);
    again?.focus({ preventScroll: true }); // nothing announced again; focus stays on the same control
    window.scrollTo(0, scrolled);
  } else {
    root.replaceChildren(screen);
    title.focus({ preventScroll: true }); // a screen reader hears the new screen's title
    window.scrollTo(0, 0);
  }
}
