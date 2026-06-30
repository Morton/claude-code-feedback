/**
 * Framework-agnostic in-page feedback widget. Embed on a local dev site:
 *   <script src="http://localhost:7878/widget.js"></script>
 *
 * Draw a rectangle, type a note — it captures a screenshot + CSS selector +
 * recent console/network diagnostics and POSTs them to the local bridge, which
 * surfaces them to your Claude Code session over MCP.
 */
import { finder } from "@medv/finder";
import html2canvas from "html2canvas";

const UI_ATTR = "data-feedback-ui";
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

// The bridge that served this script is where we post feedback.
const BRIDGE_ORIGIN = (() => {
  const script = document.currentScript as HTMLScriptElement | null;
  try {
    return script?.src ? new URL(script.src).origin : "http://localhost:7878";
  } catch {
    return "http://localhost:7878";
  }
})();

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

function resolveAnchor(clientX: number, clientY: number) {
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

async function captureRegion(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): Promise<string | null> {
  try {
    const canvas = await html2canvas(document.body, {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      scale: window.devicePixelRatio || 1,
      useCORS: true,
      logging: false,
      backgroundColor: "#ffffff",
      ignoreElements: (node) => isOwnUi(node),
    });
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

// --- UI flow ----------------------------------------------------------------

let drawing = false;

function startDrawing() {
  if (drawing) return;
  drawing = true;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483600",
    cursor: "crosshair",
    background: `rgba(${ACCENT_RGB},0.08)`,
  });
  const box = el("div", {
    position: "fixed",
    border: `2px solid ${ACCENT}`,
    background: `rgba(${ACCENT_RGB},0.12)`,
    pointerEvents: "none",
    display: "none",
  });
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let start: { x: number; y: number } | null = null;

  const cleanup = () => {
    drawing = false;
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  window.addEventListener("keydown", onKey);

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
  overlay.addEventListener("pointerup", async (e) => {
    if (!start) {
      cleanup();
      return;
    }
    const rect = {
      left: Math.min(start.x, e.clientX),
      top: Math.min(start.y, e.clientY),
      width: Math.abs(e.clientX - start.x),
      height: Math.abs(e.clientY - start.y),
    };
    cleanup();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const anchor = resolveAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const screenshotDataUrl = await captureRegion(rect);
    openComposer(rect, anchor, screenshotDataUrl);
  });
}

function openComposer(
  rect: { left: number; top: number; width: number; height: number },
  anchor: { selector: string; elementTag: string },
  screenshotDataUrl: string | null
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

  const close = () => panel.remove();
  cancel.addEventListener("click", close);
  send.addEventListener("click", async () => {
    send.disabled = true;
    send.textContent = "Sending…";
    const ok = await postFeedback({
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
    if (ok) dropPin(rect);
    toast(ok ? "Sent to Claude Code" : "Failed to reach the feedback bridge");
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

async function postFeedback(payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_ORIGIN}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function dropPin(rect: { left: number; top: number }) {
  const pin = el("div", {
    position: "absolute",
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    transform: "translate(-50%, -50%)",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    background: ACCENT,
    border: "2px solid #fff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
    zIndex: "2147483500",
  });
  document.body.appendChild(pin);
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
  fab.title = "Leave feedback for Claude Code";
  fab.addEventListener("click", startDrawing);
  document.body.appendChild(fab);
}

installDiagnostics();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountFab);
} else {
  mountFab();
}
