// Draws one View. textContent only: nothing a scanned code or a computer's
// name contains can become markup.
import type { Act, Draft } from "./launcher";
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
    const code = field("code", "Six-digit code", "text", "123456");
    code.input.inputMode = "numeric";
    code.input.autocomplete = "one-time-code";
    code.input.enterKeyHint = "go";
    code.input.maxLength = 7;
    values = () => ({ address: address.input.value, code: code.input.value });
    form.append(address.wrap, code.wrap);
    const connect = view.actions.find((a) => a.id === "connect");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    // Two fields and no submit button inside the form: Return never submits
    // by itself. On the address it moves to the code (the keyboard says Next);
    // on the code it connects (the keyboard says Go).
    address.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      code.input.focus();
    });
    code.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (connect) act(connect, values());
    });
    screen.append(form);
  }

  if (view.actions.length) {
    const actions = el("div", "actions");
    for (const action of view.actions) actions.append(button(action, () => act(action, values())));
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
