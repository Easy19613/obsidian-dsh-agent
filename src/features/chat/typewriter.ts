export const TYPEWRITER_FRAME_INTERVAL_MS = 16;

const TYPEWRITER_PROGRESS_LIMIT = 256;

function progressKey(messageId: string, segmentKey: string): string {
  return messageId + '\u0000' + segmentKey;
}

/**
 * Keep live output close to the wire instead of building a long one-character
 * animation queue. Small updates appear on the next frame; large buffered
 * chunks catch up within a handful of frames.
 */
export function nextTypewriterVisibleChars(text: string, visibleChars: number): number {
  let current = Math.max(0, Math.min(text.length, Math.floor(visibleChars)));
  if (current > 0
    && current < text.length
    && text.charCodeAt(current - 1) >= 0xD800
    && text.charCodeAt(current - 1) <= 0xDBFF
    && text.charCodeAt(current) >= 0xDC00
    && text.charCodeAt(current) <= 0xDFFF) {
    current -= 1;
  }
  const remaining = text.length - current;
  if (remaining <= 0) return text.length;

  const budget = remaining <= 96
    ? remaining
    : Math.min(256, Math.max(48, Math.ceil(remaining * 0.45)));
  let next = Math.min(text.length, current + budget);
  if (next < text.length
    && text.charCodeAt(next - 1) >= 0xD800
    && text.charCodeAt(next - 1) <= 0xDBFF
    && text.charCodeAt(next) >= 0xDC00
    && text.charCodeAt(next) <= 0xDFFF) {
    next += 1;
  }
  return next;
}

/** Remembers reveal positions while the user moves between conversations. */
export class TypewriterProgressStore {
  private readonly positions = new Map<string, number>();

  restore(messageId: string, segmentKey: string, targetText: string): number {
    return Math.min(targetText.length, this.positions.get(progressKey(messageId, segmentKey)) ?? 0);
  }

  remember(messageId: string, segmentKey: string, visibleChars: number, targetText: string): void {
    const key = progressKey(messageId, segmentKey);
    if (!this.positions.has(key) && this.positions.size >= TYPEWRITER_PROGRESS_LIMIT) {
      const oldest = this.positions.keys().next().value as string | undefined;
      if (oldest !== undefined) this.positions.delete(oldest);
    }
    this.positions.set(key, Math.max(0, Math.min(targetText.length, visibleChars)));
  }

  forgetMessage(messageId: string): void {
    const prefix = messageId + '\u0000';
    for (const key of this.positions.keys()) {
      if (key.startsWith(prefix)) this.positions.delete(key);
    }
  }

  clear(): void {
    this.positions.clear();
  }
}
