// CodeMirror selection tracker: watches editor selections and reports
// debounced snapshots so the chat composer can attach the selected text.
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { MarkdownView } from 'obsidian';

export interface SelectionSnapshot {
  text: string;
  /** 1-based line range of the selection within the document. */
  lineStart: number;
  lineEnd: number;
}

export interface WebViewerSelectionSnapshot extends SelectionSnapshot {
  title: string;
  url: string;
  mode: 'selection' | 'page';
  /** Full rendered page text retained as surrounding context for a selection. */
  contextText?: string;
  truncated?: boolean;
  contextTruncated?: boolean;
}

export interface WebViewerElement extends HTMLElement {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const DEBOUNCE_MS = 400;

export class SelectionTracker {
  private lastSnapshot: SelectionSnapshot | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by the plugin; receives debounced snapshots (null = selection cleared). */
  onSelection: ((snapshot: SelectionSnapshot | null) => void) | null = null;
  readonly extension: Extension;

  constructor() {
    const tracker = this;
    this.extension = ViewPlugin.fromClass(
      class {
        constructor(private readonly view: EditorView) {}
        update(update: ViewUpdate): void {
          if (!update.selectionSet && !update.docChanged) return;
          tracker.computeFrom(this.view);
        }
      },
    );
  }

  private computeFrom(view: EditorView): void {
    const state = view.state;
    const selection = state.selection.main;
    if (selection.empty) {
      this.schedule(null);
      return;
    }
    const text = state.sliceDoc(selection.from, selection.to);
    if (text.trim() === '') {
      this.schedule(null);
      return;
    }
    this.schedule({
      text,
      lineStart: state.doc.lineAt(selection.from).number,
      lineEnd: state.doc.lineAt(selection.to).number,
    });
  }

  private schedule(snapshot: SelectionSnapshot | null): void {
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (snapshot !== null && this.lastSnapshot !== null
        && snapshot.text === this.lastSnapshot.text
        && snapshot.lineStart === this.lastSnapshot.lineStart) {
        return;
      }
      this.lastSnapshot = snapshot;
      this.onSelection?.(snapshot);
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.onSelection = null;
  }
}

/**
 * Reading-mode (preview) selection tracker: the rendered note is plain DOM,
 * so selections are browser-native. We watch `selectionchange` on the
 * document and report selections whose anchor lives inside the active
 * Markdown view in preview mode. Source-mode selections belong to the
 * CodeMirror {@link SelectionTracker} above.
 */
export interface DomSelectionTrackerOptions {
  getActiveMarkdownView: () => MarkdownView | null;
}

export class DomSelectionTracker {
  private lastSnapshot: SelectionSnapshot | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handler: () => void;
  onSelection: ((snapshot: SelectionSnapshot | null) => void) | null = null;

  constructor(private readonly options: DomSelectionTrackerOptions) {
    this.handler = () => this.onSelectionChange();
  }

  attach(): void {
    document.addEventListener('selectionchange', this.handler);
  }

  dispose(): void {
    document.removeEventListener('selectionchange', this.handler);
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.onSelection = null;
  }

  private onSelectionChange(): void {
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.emit();
    }, 400);
  }

  private emit(): void {
    const view = this.options.getActiveMarkdownView();
    // Source-mode selections are owned by the editor tracker.
    if (view === null || view.getMode() !== 'preview') return;
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed) {
      this.publish(null);
      return;
    }
    const anchor = selection.anchorNode;
    if (anchor === null || !view.containerEl.contains(anchor)) return;
    const text = selection.toString();
    if (text.trim() === '') {
      this.publish(null);
      return;
    }
    // Reading mode renders the note as DOM: the source line range is not
    // directly available, so we approximate it from the selected text.
    const lineCount = text.split('\n').length;
    this.publish({ text, lineStart: 1, lineEnd: lineCount });
  }

  private publish(snapshot: SelectionSnapshot | null): void {
    if (snapshot !== null && this.lastSnapshot !== null && snapshot.text === this.lastSnapshot.text) {
      return;
    }
    this.lastSnapshot = snapshot;
    this.onSelection?.(snapshot);
  }
}

const WEB_SELECTION_LIMIT = 40_000;
const WEB_PAGE_CONTEXT_LIMIT = 80_000;

interface WebViewerReadResult {
  ok: true;
  title: string;
  url: string;
  selectedText: string;
  pageText: string;
  selectionTruncated: boolean;
  pageTruncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the structured-clone result returned by Electron's webview. */
export function normalizeWebViewerReadResult(value: unknown): WebViewerSelectionSnapshot | null | undefined {
  if (!isRecord(value) || value.ok !== true
    || typeof value.title !== 'string' || typeof value.url !== 'string'
    || typeof value.selectedText !== 'string' || typeof value.pageText !== 'string') return undefined;
  const title = value.title.trim().slice(0, 300) || '网页';
  const url = value.url.trim().slice(0, 4_096);
  const selectedText = value.selectedText.trim();
  const pageText = value.pageText.trim();
  if (selectedText === '' && pageText === '') return null;
  const mode = selectedText !== '' ? 'selection' : 'page';
  const text = mode === 'selection' ? selectedText : pageText;
  const lineEnd = Math.max(1, text.split('\n').length);
  return {
    text,
    title,
    url,
    mode,
    lineStart: 1,
    lineEnd,
    ...(mode === 'selection' && pageText !== '' ? { contextText: pageText } : {}),
    ...(value.selectionTruncated === true && mode === 'selection' ? { truncated: true } : {}),
    ...(value.pageTruncated === true && mode === 'page' ? { truncated: true } : {}),
    ...(value.pageTruncated === true && mode === 'selection' ? { contextTruncated: true } : {}),
  };
}

/**
 * Read only the visible selection, title, URL and rendered article text from
 * the active Electron webview. No cookies, form values or browser storage are
 * touched. WeChat's article body is preferred before general article/main
 * containers, then body.innerText is the final fallback.
 */
export function webViewerReadScript(): string {
  return `(() => {
    const clean = (value) => String(value ?? '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{4,}/g, '\\n\\n\\n')
      .trim();
    const selected = clean(document.getSelection?.()?.toString?.() ?? '');
    const selectors = ['#js_content', '.rich_media_content', 'article', 'main', '[role="main"]'];
    let page = '';
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const candidate = clean(element?.innerText ?? '');
      if (candidate.length >= 120) { page = candidate; break; }
    }
    if (page === '') page = clean(document.body?.innerText ?? '');
    const heading = clean(document.querySelector('#activity-name')?.innerText
      ?? document.querySelector('h1')?.innerText ?? document.title ?? '');
    return {
      ok: true,
      title: heading.slice(0, 300) || location.hostname || '网页',
      url: String(location.href ?? '').slice(0, 4096),
      selectedText: selected.slice(0, ${WEB_SELECTION_LIMIT}),
      pageText: page.slice(0, ${WEB_PAGE_CONTEXT_LIMIT}),
      selectionTruncated: selected.length > ${WEB_SELECTION_LIMIT},
      pageTruncated: page.length > ${WEB_PAGE_CONTEXT_LIMIT},
    };
  })()`;
}

export interface WebViewerSelectionTrackerOptions {
  /** Return the webview hosted by the currently active Obsidian leaf. */
  getActiveWebView: () => WebViewerElement | null;
  pollMs?: number;
}

/**
 * Electron webview selections do not bubble into Obsidian's renderer DOM.
 * Poll only the active webview, plus one final read when focus leaves it, so a
 * fast browser -> chat switch cannot lose the selection.
 */
export class WebViewerSelectionTracker {
  private lastSnapshot: WebViewerSelectionSnapshot | null = null;
  private lastActiveWebView: WebViewerElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly pending = new WeakSet<WebViewerElement>();
  onSelection: ((snapshot: WebViewerSelectionSnapshot | null) => void) | null = null;

  constructor(private readonly options: WebViewerSelectionTrackerOptions) {}

  attach(): void {
    this.disposed = false;
    this.schedule(0);
  }

  /** Called on active-leaf changes to retain a final snapshot before blur. */
  refresh(): void {
    const active = this.options.getActiveWebView();
    if (active !== null) {
      this.lastActiveWebView = active;
      void this.capture(active);
      return;
    }
    const previous = this.lastActiveWebView;
    this.lastActiveWebView = null;
    if (previous !== null) void this.capture(previous);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.lastActiveWebView = null;
    this.onSelection = null;
  }

  private schedule(delay = this.options.pollMs ?? 650): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
      this.schedule();
    }, delay);
  }

  private async capture(webview: WebViewerElement): Promise<void> {
    if (this.disposed || this.pending.has(webview) || typeof webview.executeJavaScript !== 'function') return;
    this.pending.add(webview);
    try {
      const result = await webview.executeJavaScript(webViewerReadScript(), false);
      if (this.disposed) return;
      const snapshot = normalizeWebViewerReadResult(result);
      if (snapshot !== undefined) this.publish(snapshot);
    } catch {
      // Navigation, a destroyed popout, or a protected guest page can reject.
      // Keep the last valid context instead of clearing it on a transient error.
    } finally {
      this.pending.delete(webview);
    }
  }

  private publish(snapshot: WebViewerSelectionSnapshot | null): void {
    if (snapshot === null && this.lastSnapshot === null) return;
    if (snapshot !== null && this.lastSnapshot !== null
      && snapshot.text === this.lastSnapshot.text
      && snapshot.contextText === this.lastSnapshot.contextText
      && snapshot.title === this.lastSnapshot.title
      && snapshot.url === this.lastSnapshot.url
      && snapshot.mode === this.lastSnapshot.mode
      && snapshot.truncated === this.lastSnapshot.truncated
      && snapshot.contextTruncated === this.lastSnapshot.contextTruncated) return;
    this.lastSnapshot = snapshot;
    this.onSelection?.(snapshot);
  }
}
