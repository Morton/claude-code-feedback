import { randomUUID } from "node:crypto";

export interface DiagnosticsSnapshot {
  console: Array<{ level: string; message: string; timestamp: string }>;
  network: Array<{
    url: string;
    method: string;
    status: number;
    timestamp: string;
  }>;
}

export interface FeedbackInput {
  message: string;
  url: string;
  selector: string;
  elementTag: string;
  viewport: string;
  userAgent: string;
  /** Full data URL, e.g. `data:image/jpeg;base64,...`, or null. */
  screenshotDataUrl: string | null;
  diagnostics: DiagnosticsSnapshot | null;
}

export interface FeedbackItem extends Omit<FeedbackInput, "screenshotDataUrl"> {
  id: string;
  createdAt: string;
  status: "open" | "resolved";
  /** base64 payload (without the `data:` prefix), or null. */
  screenshotBase64: string | null;
  screenshotMime: string | null;
}

const items: FeedbackItem[] = [];

function splitDataUrl(dataUrl: string | null): {
  base64: string | null;
  mime: string | null;
} {
  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return { base64: null, mime: null };
  }
  const comma = dataUrl.indexOf(",");
  const mime = /data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? null;
  return { base64: dataUrl.slice(comma + 1), mime };
}

export function addFeedback(input: FeedbackInput): FeedbackItem {
  const { base64, mime } = splitDataUrl(input.screenshotDataUrl);
  const { screenshotDataUrl: _omit, ...rest } = input;
  const item: FeedbackItem = {
    ...rest,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "open",
    screenshotBase64: base64,
    screenshotMime: mime,
  };
  items.push(item);
  return item;
}

export function listFeedback(includeResolved = false): FeedbackItem[] {
  return includeResolved ? [...items] : items.filter((i) => i.status === "open");
}

export function getFeedback(id: string): FeedbackItem | undefined {
  return items.find((i) => i.id === id);
}

export function resolveFeedback(id: string): boolean {
  const item = items.find((i) => i.id === id);
  if (!item) {
    return false;
  }
  item.status = "resolved";
  return true;
}

export function clearFeedback(): number {
  const n = items.length;
  items.length = 0;
  return n;
}
