/**
 * Framework-agnostic in-page feedback widget. Embed on a local dev site:
 *   <script src="http://localhost:7878/widget.js"></script>
 *
 * Draw a rectangle, type a note — it captures a screenshot + CSS selector +
 * recent console/network diagnostics and POSTs them to the local bridge, which
 * surfaces them to your Claude Code session over MCP.
 *
 * Start it with the floating button or the keyboard (Alt+Shift+F by default).
 * Either way the page is snapshotted *before* the selection overlay appears, so
 * hover-only UI — menus, tooltips, :hover styling — survives into the shot.
 */
import { finder } from "@medv/finder";
import html2canvas from "html2canvas";

const UI_ATTR = "data-feedback-ui";
// Marks the live `:hover` chain so it can be replayed inside html2canvas's clone.
const HOVER_ATTR = "data-feedback-hover";
const HOVER_CLASS = "claude-feedback-hover";
// Claude brand palette.
const ACCENT = "#D97757"; // Claude coral
const ACCENT_RGB = "217,119,87";
const SURFACE = "#FAF9F5"; // Claude cream
const MIN_SIZE = 8;

// The Claude/Anthropic starburst mark, rendered inline so it stays crisp at any
// size and inherits its color from `stroke` (pass the brand color or a contrast).
function claudeMark(size: number, color: string): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">` +
    `<line x1="12" y1="2.5" x2="12" y2="21.5"/>` +
    `<line x1="2.5" y1="12" x2="21.5" y2="12"/>` +
    `<line x1="5.3" y1="5.3" x2="18.7" y2="18.7"/>` +
    `<line x1="18.7" y1="5.3" x2="5.3" y2="18.7"/>` +
    `</svg>`
  );
}

const SCRIPT_EL = document.currentScript as HTMLScriptElement | null;

// The bridge that served this script is where we post feedback.
const BRIDGE_ORIGIN = (() => {
  try {
    return SCRIPT_EL?.src ? new URL(SCRIPT_EL.src).origin : "http://localhost:7878";
  } catch {
    return "http://localhost:7878";
  }
})();

// Optional shared secret the bridge injects when CLAUDE_FEEDBACK_TOKEN is set.
const FEEDBACK_TOKEN = (window as { __CLAUDE_FEEDBACK_TOKEN__?: string })
  .__CLAUDE_FEEDBACK_TOKEN__;

// --- keyboard trigger -------------------------------------------------------

interface Hotkey {
  key: string; // lowercase `e.key`, or a bare `e.code` like "f2"
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * Override with `<script src="…/widget.js" data-hotkey="ctrl+shift+k">` or
 * `window.__CLAUDE_FEEDBACK_HOTKEY__ = "f2"`. Set it to "none" to disable.
 */
const HOTKEY_SPEC =
  (window as { __CLAUDE_FEEDBACK_HOTKEY__?: string }).__CLAUDE_FEEDBACK_HOTKEY__ ??
  SCRIPT_EL?.dataset.hotkey ??
  "alt+shift+f";

function parseHotkey(spec: string): Hotkey | null {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key || key === "none" || key === "off") return null;
  const hotkey: Hotkey = { key, alt: false, ctrl: false, shift: false, meta: false };
  for (const part of parts) {
    if (part === "alt" || part === "option" || part === "opt") hotkey.alt = true;
    else if (part === "ctrl" || part === "control") hotkey.ctrl = true;
    else if (part === "shift") hotkey.shift = true;
    else if (part === "meta" || part === "cmd" || part === "command") hotkey.meta = true;
    else return null; // unknown modifier — safer to bind nothing than the wrong thing
  }
  return hotkey;
}

const HOTKEY = parseHotkey(HOTKEY_SPEC);

/** Human-readable form for the button tooltip, e.g. "⌥⇧F" / "Alt+Shift+F". */
function hotkeyLabel(hotkey: Hotkey): string {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const parts: string[] = [];
  if (hotkey.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (hotkey.alt) parts.push(mac ? "⌥" : "Alt");
  if (hotkey.shift) parts.push(mac ? "⇧" : "Shift");
  if (hotkey.meta) parts.push(mac ? "⌘" : "Meta");
  parts.push(
    hotkey.key.length === 1
      ? hotkey.key.toUpperCase()
      : hotkey.key.charAt(0).toUpperCase() + hotkey.key.slice(1)
  );
  return mac ? parts.join("") : parts.join("+");
}

function isEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.isContentEditable ||
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement
  );
}

function matchesHotkey(e: KeyboardEvent, hotkey: Hotkey): boolean {
  if (
    e.altKey !== hotkey.alt ||
    e.ctrlKey !== hotkey.ctrl ||
    e.shiftKey !== hotkey.shift ||
    e.metaKey !== hotkey.meta
  ) {
    return false;
  }
  // Alt-chords produce exotic `key` values on macOS ("Ï"), so accept `code` too.
  const code = (e.code || "").toLowerCase();
  return (
    (e.key || "").toLowerCase() === hotkey.key ||
    code === hotkey.key ||
    code === `key${hotkey.key}` ||
    code === `digit${hotkey.key}`
  );
}

function installHotkey() {
  if (!HOTKEY) return;
  const bare = !HOTKEY.alt && !HOTKEY.ctrl && !HOTKEY.meta;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || !matchesHotkey(e, HOTKEY)) return;
      // A modifier-free hotkey must not steal keystrokes from a form field.
      if (bare && isEditable(e.target)) return;
      e.preventDefault();
      void startCapture();
    },
    true
  );
}

// --- pointer tracking -------------------------------------------------------

// Where the mouse was when a capture started: the element under it is the best
// anchor for a hover-triggered shot, since the hover is gone once we overlay.
let pointer: { x: number; y: number } | null = null;

function trackPointer() {
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true }
  );
}

// --- tiny DOM helpers -------------------------------------------------------

type Styles = Partial<CSSStyleDeclaration>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  styles: Styles = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute(UI_ATTR, "true");
  Object.assign(node.style, styles);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function isOwnUi(node: Element | null): boolean {
  return node instanceof HTMLElement && node.closest(`[${UI_ATTR}]`) !== null;
}

// --- diagnostics (console + failed fetch ring buffer) -----------------------

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: string;
}
interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  timestamp: string;
}

const consoleBuf: ConsoleEntry[] = [];
const networkBuf: NetworkEntry[] = [];
const MAX = 25;

function push<T>(buf: T[], entry: T) {
  buf.push(entry);
  if (buf.length > MAX) buf.shift();
}

function installDiagnostics() {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(consoleBuf, {
        level,
        timestamp: new Date().toISOString(),
        message: args
          .map((a) => (typeof a === "string" ? a : safeStringify(a)))
          .join(" ")
          .slice(0, 500),
      });
      original(...args);
    };
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await originalFetch(input, init);
    if (!res.ok) {
      push(networkBuf, {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        status: res.status,
        timestamp: new Date().toISOString(),
      });
    }
    return res;
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// --- capture ----------------------------------------------------------------

interface Anchor {
  selector: string;
  elementTag: string;
}

function resolveAnchor(clientX: number, clientY: number): Anchor {
  const node = document
    .elementsFromPoint(clientX, clientY)
    .find((e): e is HTMLElement => e instanceof HTMLElement && !isOwnUi(e));
  if (!node) {
    return { selector: "", elementTag: "" };
  }
  let selector = "";
  try {
    selector = finder(node);
  } catch {
    selector = "";
  }
  return { selector, elementTag: node.tagName };
}

/**
 * html2canvas renders a *clone* of the page in a detached iframe, where nothing
 * is hovered — so `:hover` styling silently disappears from screenshots. Tag the
 * live hover chain here, and `replayHover` re-applies it inside the clone.
 */
function markHoverChain(): { hovering: boolean; unmark: () => void } {
  let chain: Element[] = [];
  try {
    chain = Array.from(document.querySelectorAll(":hover")).filter((n) => !isOwnUi(n));
  } catch {
    chain = [];
  }
  for (const node of chain) node.setAttribute(HOVER_ATTR, "true");
  return {
    // <html> and <body> are always in the chain; anything deeper is a real hover.
    hovering: chain.length > 2,
    unmark: () => {
      for (const node of chain) node.removeAttribute(HOVER_ATTR);
    },
  };
}

/** Every `:hover` rule on the page, restated against a plain class. */
function hoverStyles(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectHoverRules(sheet.cssRules, out);
    } catch {
      continue; // cross-origin stylesheet — cssRules throws
    }
  }
  return out.join("\n");
}

function collectHoverRules(rules: CSSRuleList, out: string[]) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      if (rule.selectorText.includes(":hover")) {
        const selector = rule.selectorText.replace(/:hover/g, `.${HOVER_CLASS}`);
        out.push(`${selector} { ${rule.style.cssText} }`);
      }
    } else if (typeof CSSGroupingRule !== "undefined" && rule instanceof CSSGroupingRule) {
      // @media / @supports / @container — keep the prelude, recurse into the body.
      const nested: string[] = [];
      collectHoverRules(rule.cssRules, nested);
      if (nested.length) {
        const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
        out.push(`${prelude} {\n${nested.join("\n")}\n}`);
      }
    }
  }
}

function replayHover(clone: Document, css: string) {
  const marked = clone.querySelectorAll(`[${HOVER_ATTR}]`);
  if (!marked.length || !css) return;
  for (const node of Array.from(marked)) node.classList.add(HOVER_CLASS);
  const style = clone.createElement("style");
  style.textContent = css;
  clone.head?.appendChild(style);
}

interface Snapshot {
  canvas: HTMLCanvasElement;
  /** Device pixels per CSS pixel in `canvas`. */
  scale: number;
  width: number;
  height: number;
}

/**
 * Freeze the whole viewport as it looks *right now*, before any of our own UI
 * covers it. Everything that depends on the pointer staying put — hover menus,
 * tooltips, `:hover` styling — is still on screen at this moment.
 */
async function freezeViewport(): Promise<Snapshot | null> {
  // The client box excludes scrollbars, so it matches both the pointer's
  // clientX/clientY space and the fixed overlay we paint the snapshot into.
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const { hovering, unmark } = markHoverChain();
  // Walking every stylesheet isn't free — only worth it if something is hovered.
  const css = hovering ? hoverStyles() : "";
  try {
    const canvas = await html2canvas(document.body, {
      x: window.scrollX,
      y: window.scrollY,
      width,
      height,
      scale: window.devicePixelRatio || 1,
      useCORS: true,
      logging: false,
      backgroundColor: "#ffffff",
      ignoreElements: (node) => isOwnUi(node),
      onclone: (clone) => replayHover(clone, css),
    });
    return { canvas, scale: canvas.width / width, width, height };
  } catch {
    return null;
  } finally {
    unmark();
  }
}

/** Cut the selected region out of the frozen viewport. */
function cropSnapshot(
  snapshot: Snapshot,
  rect: { left: number; top: number; width: number; height: number }
): string | null {
  try {
    const { scale } = snapshot;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(rect.width * scale));
    out.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    // Round the source rect to whole device pixels so the crop is a 1:1 copy
    // rather than a fractional resample of the snapshot.
    ctx.drawImage(
      snapshot.canvas,
      Math.round(rect.left * scale),
      Math.round(rect.top * scale),
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height
    );
    return out.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

// --- UI flow ----------------------------------------------------------------

// True from the moment a capture starts until the composer closes, so a second
// trigger (button or hotkey) can't stack overlays.
let busy = false;

// Keys that would scroll the live page out from under the frozen snapshot.
const SCROLL_KEYS = new Set([
  " ",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/**
 * Snapshot first, select second. The freeze happens while the page is still
 * untouched, which is what makes a hover-only state capturable: press the
 * hotkey without moving the mouse, then take as long as you like drawing the
 * box over the frozen image.
 */
async function startCapture(hoverAnchored = true) {
  if (busy) return;
  busy = true;
  // For a keyboard trigger the pointer hasn't moved, so whatever sits under it
  // is the subject — resolve it now, while the hover-only UI is still there.
  // Clicking the button moves the pointer onto our own UI, so skip it there.
  const at = hoverAnchored ? pointer : null;
  const hovered = at ? resolveAnchor(at.x, at.y) : null;
  const banner = showHint("Capturing the page…");
  const snapshot = await freezeViewport();
  banner.remove();
  if (!snapshot) {
    busy = false;
    toast("Couldn't capture the page");
    return;
  }
  selectRegion(snapshot, hovered, at);
}

function selectRegion(
  snapshot: Snapshot,
  hovered: Anchor | null,
  hoveredAt: { x: number; y: number } | null
) {
  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483600",
    cursor: "crosshair",
    overflow: "hidden",
  });

  // The frozen page, pinned under the selection UI. The live DOM behind it may
  // already have moved on (the hover state is gone the moment we cover it).
  const frame = snapshot.canvas;
  frame.setAttribute(UI_ATTR, "true");
  Object.assign(frame.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${snapshot.width}px`,
    height: `${snapshot.height}px`,
    pointerEvents: "none",
  });
  const wash = el("div", {
    position: "absolute",
    inset: "0",
    background: `rgba(${ACCENT_RGB},0.08)`,
    pointerEvents: "none",
  });
  const box = el("div", {
    position: "fixed",
    border: `2px solid ${ACCENT}`,
    background: `rgba(${ACCENT_RGB},0.12)`,
    pointerEvents: "none",
    display: "none",
  });
  overlay.append(frame, wash, box);
  document.body.appendChild(overlay);
  const hint = showHint("Page frozen — drag to select · Esc to cancel");

  let start: { x: number; y: number } | null = null;

  // Removes the frozen frame/wash/box. Called either when the drag is
  // abandoned, or later by the composer once it closes — the freeze and the
  // selection box stay on screen for as long as the composer is open.
  const closeOverlay = () => overlay.remove();
  const abort = () => {
    busy = false;
    hint.remove();
    window.removeEventListener("keydown", onKey);
    closeOverlay();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      abort();
      return;
    }
    // Space/PageDown/arrows scroll too, and the overlay has focus-free keys.
    if (SCROLL_KEYS.has(e.key)) e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  // Scrolling would slide the live page out from under the frozen image.
  const blockScroll = (e: Event) => e.preventDefault();
  overlay.addEventListener("wheel", blockScroll, { passive: false });
  overlay.addEventListener("touchmove", blockScroll, { passive: false });

  overlay.addEventListener("pointerdown", (e) => {
    start = { x: e.clientX, y: e.clientY };
    Object.assign(box.style, {
      display: "block",
      left: `${e.clientX}px`,
      top: `${e.clientY}px`,
      width: "0px",
      height: "0px",
    });
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!start) return;
    Object.assign(box.style, {
      left: `${Math.min(start.x, e.clientX)}px`,
      top: `${Math.min(start.y, e.clientY)}px`,
      width: `${Math.abs(e.clientX - start.x)}px`,
      height: `${Math.abs(e.clientY - start.y)}px`,
    });
  });
  overlay.addEventListener("pointerup", (e) => {
    if (!start) {
      abort();
      return;
    }
    const rect = {
      left: Math.min(start.x, e.clientX),
      top: Math.min(start.y, e.clientY),
      width: Math.abs(e.clientX - start.x),
      height: Math.abs(e.clientY - start.y),
    };
    const small = rect.width < MIN_SIZE || rect.height < MIN_SIZE;
    if (small) {
      abort();
      return;
    }

    // A real selection: stop drag handling but leave the frozen frame and box
    // on screen, so the marked region stays visible behind the composer.
    hint.remove();
    window.removeEventListener("keydown", onKey);
    overlay.style.cursor = "default";

    // Prefer the element that was under the pointer at freeze time when the
    // selection covers it: after the overlay, hover-only UI is no longer there
    // to be found by `elementsFromPoint`.
    const inRect =
      hoveredAt !== null &&
      hoveredAt.x >= rect.left &&
      hoveredAt.x <= rect.left + rect.width &&
      hoveredAt.y >= rect.top &&
      hoveredAt.y <= rect.top + rect.height;
    const anchor =
      inRect && hovered?.selector
        ? hovered
        : resolveAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    openComposer(rect, anchor, cropSnapshot(snapshot, rect), closeOverlay);
  });
}

/** Small pill at the top of the screen; our own UI, so never screenshotted. */
function showHint(text: string): HTMLElement {
  const node = el(
    "div",
    {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483603",
      background: "#1a1a22",
      color: "#fff",
      padding: "7px 14px",
      borderRadius: "999px",
      font: "13px -apple-system, system-ui, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
      pointerEvents: "none", // must never join the `:hover` chain we're capturing
    },
    text
  );
  document.body.appendChild(node);
  return node;
}

function openComposer(
  rect: { left: number; top: number; width: number; height: number },
  anchor: Anchor,
  screenshotDataUrl: string | null,
  closeOverlay: () => void
) {
  const panel = el("div", {
    position: "fixed",
    left: `${Math.min(rect.left, window.innerWidth - 320)}px`,
    top: `${Math.min(rect.top + rect.height + 8, window.innerHeight - 180)}px`,
    zIndex: "2147483601",
    width: "300px",
    background: SURFACE,
    border: "1px solid #e1e1ea",
    borderRadius: "10px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
    padding: "12px",
    font: "13px -apple-system, system-ui, sans-serif",
    color: "#1a1a22",
  });

  const header = el("div", {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    marginBottom: "10px",
    fontWeight: "700",
    color: ACCENT,
  });
  const mark = el("span", {
    display: "inline-flex",
    width: "15px",
    height: "15px",
  });
  mark.innerHTML = claudeMark(15, ACCENT);
  header.append(mark, el("span", {}, "Claude Code feedback"));

  const textarea = el("textarea", {
    width: "100%",
    height: "72px",
    boxSizing: "border-box",
    resize: "vertical",
    border: "1px solid #d4d4dd",
    borderRadius: "6px",
    padding: "8px",
    font: "inherit",
  });
  textarea.placeholder = "What's the issue here?";

  const row = el("div", {
    display: "flex",
    gap: "8px",
    justifyContent: "flex-end",
    marginTop: "8px",
  });
  const cancel = el("button", btnStyle("#f0f0f4", "#333"), "Cancel");
  const send = el("button", btnStyle(ACCENT, "#fff"), "Send");
  row.append(cancel, send);
  panel.append(header, textarea, row);
  document.body.appendChild(panel);
  textarea.focus();

  const close = () => {
    panel.remove();
    busy = false;
    closeOverlay();
  };
  cancel.addEventListener("click", close);
  send.addEventListener("click", async () => {
    send.disabled = true;
    send.textContent = "Sending…";
    const id = await postFeedback({
      message: textarea.value.trim(),
      url: window.location.pathname,
      selector: anchor.selector,
      elementTag: anchor.elementTag,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: navigator.userAgent,
      screenshotDataUrl,
      diagnostics: { console: [...consoleBuf], network: [...networkBuf] },
    });
    close();
    if (id) {
      const pin = dropPin(rect);
      trackStatus(id, pin);
    }
    toast(id ? "Sent to Claude Code" : "Failed to reach the feedback bridge");
  });
}

function btnStyle(bg: string, color: string): Styles {
  return {
    background: bg,
    color,
    border: "none",
    borderRadius: "6px",
    padding: "7px 14px",
    font: "inherit",
    fontWeight: "600",
    cursor: "pointer",
  };
}

/** POST the feedback; resolves to the new item's id, or null on failure. */
async function postFeedback(payload: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE_ORIGIN}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(FEEDBACK_TOKEN ? { "X-Feedback-Token": FEEDBACK_TOKEN } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return data?.id ?? null;
  } catch {
    return null;
  }
}

function dropPin(rect: { left: number; top: number }): HTMLElement {
  const pin = el("div", {
    position: "absolute",
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    transform: "translate(-50%, -50%)",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: ACCENT,
    border: "2px solid #fff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "700",
    zIndex: "2147483500",
  });
  pin.title = "Sent to Claude Code";
  document.body.appendChild(pin);
  return pin;
}

// --- live pin status: open → in_progress (pulsing) → resolved (✓) -----------

const POLL_MS = 1500;
const MAX_MISSES = 5; // stop after the item disappears (cleared / unreachable)

function setPinState(pin: HTMLElement, state: "open" | "in_progress" | "resolved") {
  if (state === "in_progress") {
    pin.style.background = ACCENT;
    pin.style.animation = "ccf-pulse 1.3s ease-out infinite";
    pin.title = "Claude is working on this…";
    pin.textContent = "";
  } else if (state === "resolved") {
    pin.style.background = "#22c55e"; // done
    pin.style.animation = "";
    pin.title = "Resolved by Claude Code";
    pin.textContent = "✓";
    // Fade out a few seconds after completion so the page isn't littered with pins.
    setTimeout(() => {
      pin.style.transition = "opacity 0.6s ease";
      pin.style.opacity = "0";
      setTimeout(() => pin.remove(), 700);
    }, 4000);
  }
}

function trackStatus(id: string, pin: HTMLElement) {
  let misses = 0;
  const timer = window.setInterval(async () => {
    let status: string | null = null;
    try {
      const res = await fetch(`${BRIDGE_ORIGIN}/feedback/${encodeURIComponent(id)}`);
      if (res.ok) {
        status = ((await res.json()) as { status?: string })?.status ?? null;
        misses = 0;
      } else {
        misses += 1;
      }
    } catch {
      misses += 1;
    }
    if (status === "in_progress" || status === "resolved") {
      setPinState(pin, status);
    }
    if (status === "resolved" || misses >= MAX_MISSES) {
      window.clearInterval(timer);
    }
  }, POLL_MS);
}

function toast(text: string) {
  const node = el(
    "div",
    {
      position: "fixed",
      bottom: "80px",
      right: "20px",
      zIndex: "2147483602",
      background: "#1a1a22",
      color: "#fff",
      padding: "10px 14px",
      borderRadius: "8px",
      font: "13px -apple-system, system-ui, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    },
    text
  );
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3000);
}

function mountFab() {
  const fab = el(
    "button",
    {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483602",
      width: "52px",
      height: "52px",
      borderRadius: "50%",
      background: ACCENT,
      color: "#fff",
      border: "none",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    }
  );
  fab.innerHTML = claudeMark(26, "#fff");
  fab.title = HOTKEY
    ? `Leave feedback for Claude Code (${hotkeyLabel(HOTKEY)})`
    : "Leave feedback for Claude Code";
  fab.addEventListener("click", () => void startCapture(false));
  document.body.appendChild(fab);
}

// Keyframes can't live in inline styles, so inject them once.
function injectStyles() {
  const style = el("style");
  style.textContent =
    "@keyframes ccf-pulse {" +
    `0% { box-shadow: 0 0 0 0 rgba(${ACCENT_RGB},0.55); }` +
    `70% { box-shadow: 0 0 0 12px rgba(${ACCENT_RGB},0); }` +
    `100% { box-shadow: 0 0 0 0 rgba(${ACCENT_RGB},0); }` +
    "}";
  document.head.appendChild(style);
}

installDiagnostics();
injectStyles();
trackPointer();
installHotkey();
// Escape hatch for custom triggers (your own shortcut, a dev-menu item, …).
(window as { __CLAUDE_FEEDBACK__?: { capture: () => void } }).__CLAUDE_FEEDBACK__ = {
  capture: () => void startCapture(),
};
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountFab);
} else {
  mountFab();
}
