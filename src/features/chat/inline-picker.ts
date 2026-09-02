// Inline panels: the note picker (@), slash menu (/) and workspace picker
// render as an anchored panel right below the message flow (above the
// composer) instead of centered modals. Permission requests render a compact
// card in the same slot.
import { setIcon } from 'obsidian';

export interface InlineListItem {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

function clear(panel: HTMLElement): void {
  panel.empty();
  panel.removeClass('is-open');
}

/**
 * Open a keyboard-navigable inline suggestion list.
 * - ArrowUp/ArrowDown navigate, Enter/Tab choose, Escape closes.
 * - Clicking outside the panel (or the anchor) closes it.
 */
export function openInlinePicker(panel: HTMLElement, opts: {
  placeholder: string;
  items: InlineListItem[];
  anchor?: HTMLElement;
  onChoose: (item: InlineListItem) => void;
  onClose?: () => void;
}): void {
  clear(panel);
  panel.addClass('is-open');

  const input = panel.createEl('input', {
    cls: 'dsh-agent-inline-search',
    attr: { placeholder: opts.placeholder, spellcheck: 'false' },
  });
  const list = panel.createDiv({ cls: 'dsh-agent-inline-list' });
  let selectedIndex = 0;
  let query = '';

  const filtered = (): InlineListItem[] => {
    const q = query.trim().toLowerCase();
    if (q === '') return opts.items;
    const scored = opts.items
      .map((item) => {
        const label = item.label.toLowerCase();
        const desc = (item.description ?? '').toLowerCase();
        let score = -1;
        if (label === q) score = 0;
        else if (label.startsWith(q)) score = 1;
        else if (label.includes(q)) score = 2;
        else if (desc.includes(q)) score = 3;
        return { item, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.item);
    return scored;
  };

  const renderList = (): void => {
    list.empty();
    const items = filtered();
    if (items.length === 0) {
      list.createDiv({ cls: 'dsh-agent-inline-empty', text: '无匹配结果' });
      return;
    }
    items.slice(0, 60).forEach((item, index) => {
      const row = list.createDiv({
        cls: 'dsh-agent-inline-item' + (index === selectedIndex ? ' is-selected' : ''),
      });
      const iconEl = row.createSpan({ cls: 'dsh-agent-inline-icon' });
      setIcon(iconEl, item.icon ?? 'file-text');
      const textEl = row.createDiv({ cls: 'dsh-agent-inline-text' });
      textEl.createDiv({ cls: 'dsh-agent-inline-label', text: item.label });
      if (item.description !== undefined && item.description !== '') {
        textEl.createDiv({ cls: 'dsh-agent-inline-desc', text: item.description });
      }
      row.onmousedown = (event) => {
        event.preventDefault();
        choose(items, index);
      };
    });
  };

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onDocumentKey, true);
    if (onDocumentDown !== null) document.removeEventListener('mousedown', onDocumentDown);
    clear(panel);
  };

  const choose = (items: InlineListItem[], index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    const onChoose = opts.onChoose;
    cleanup();
    onChoose(item);
  };

  const close = (): void => {
    const onClose = opts.onClose;
    cleanup();
    onClose?.();
  };

  const onDocumentKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onDocumentKey, true);

  let onDocumentDown: ((event: MouseEvent) => void) | null = null;
  if (opts.anchor !== undefined) {
    const anchor = opts.anchor;
    onDocumentDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panel.contains(target) || anchor.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onDocumentDown);
  }

  input.addEventListener('input', () => {
    query = input.value;
    selectedIndex = 0;
    renderList();
  });
  input.addEventListener('keydown', (event) => {
    const items = filtered();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length > 0) selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      renderList();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderList();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(items, selectedIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  input.focus();
  renderList();
}

/** Render the compact inline permission card (replaces anything in the panel). */
export function renderPermissionCard(panel: HTMLElement, opts: {
  toolName: string;
  prompt: string;
  argumentsJson: string;
  risk: string;
  queueDepth: number;
  onAllow: () => void;
  onReject: () => void;
}): void {
  clear(panel);
  panel.addClass('is-open');
  const card = panel.createDiv({ cls: 'dsh-agent-permission-card' });
  const header = card.createDiv({ cls: 'dsh-agent-permission-header' });
  const icon = header.createSpan({ cls: 'dsh-agent-permission-icon' });
  setIcon(icon, 'shield-alert');
  header.createDiv({ cls: 'dsh-agent-permission-title', text: 'DSH 请求权限' });
  header.createSpan({ cls: 'dsh-agent-permission-risk', text: opts.risk });
  const toolRow = card.createDiv({ cls: 'dsh-agent-permission-tool' });
  toolRow.createSpan({ cls: 'dsh-agent-mono', text: opts.toolName });
  if (opts.prompt.trim() !== '') {
    const promptEl = card.createDiv({ cls: 'dsh-agent-permission-prompt' });
    promptEl.setText(opts.prompt);
  }
  if (opts.argumentsJson.trim() !== '') {
    const details = card.createEl('details', { cls: 'dsh-agent-permission-details' });
    details.createEl('summary', { text: '查看工具参数' });
    details.createEl('pre', { cls: 'dsh-agent-mono', text: opts.argumentsJson.slice(0, 12000) });
  }
  if (opts.queueDepth > 1) {
    card.createDiv({ cls: 'dsh-agent-permission-queue', text: '权限队列中还有 ' + (opts.queueDepth - 1) + ' 项等待处理' });
  }
  const actions = card.createDiv({ cls: 'dsh-agent-permission-actions' });
  const allow = actions.createEl('button', { cls: 'dsh-agent-btn mod-cta' });
  const allowIcon = allow.createSpan();
  setIcon(allowIcon, 'check');
  allow.createSpan({ text: ' 允许一次' });
  allow.onclick = () => opts.onAllow();
  const reject = actions.createEl('button', { cls: 'dsh-agent-btn' });
  const rejectIcon = reject.createSpan();
  setIcon(rejectIcon, 'x');
  reject.createSpan({ text: ' 拒绝' });
  reject.onclick = () => opts.onReject();
}

export interface HoverMenuOption {
  id: string;
  label: string;
  description?: string;
  group?: string;
  groupTitle?: string;
  selected?: boolean;
}

/**
 * Hover-triggered selection menu (chip-style, no input box): opens when the
 * mouse enters the chip, closes when the mouse leaves both chip and menu
 * (150ms grace). Keyboard: focus the chip, Enter/Space opens, arrows move,
 * Enter picks, Escape closes. Clicking outside closes.
 */
interface HoverMenuState {
  panel: HTMLElement;
  chip: HTMLElement;
  close: () => void;
  cancelClose: () => void;
  scheduleClose: () => void;
  handleKey: (event: KeyboardEvent) => void;
}

// Only one hover menu may own the shared panel at a time. When the mouse
// moves from one chip straight to another, the new menu cancels the old
// menu's pending 150ms close timer — otherwise the stale timer would wipe
// the freshly opened menu.
let activeHoverMenu: HoverMenuState | null = null;

function detachActiveHoverMenu(): void {
  if (activeHoverMenu === null) return;
  activeHoverMenu.close();
}

export function openHoverMenu(panel: HTMLElement, opts: {
  chip: HTMLElement;
  options: HoverMenuOption[];
  onChoose: (id: string) => void;
}): void {
  let selectedIndex = 0;
  let open = false;
  let list: HTMLElement | null = null;
  const chip = opts.chip;

  const clear = (): void => {
    open = false;
    list = null;
    if (activeHoverMenu === state) activeHoverMenu = null;
    panel.empty();
    panel.removeClass('is-open');
  };

  // Incremental highlight only — rebuilding the list would reset the
  // scroll position (wheel scrolling / scrollbar dragging snapping back
  // to the top).
  const highlight = (index: number): void => {
    selectedIndex = index;
    if (list === null) return;
    const rows = list.querySelectorAll<HTMLElement>('.dsh-agent-hover-item');
    rows.forEach((row, i) => row.toggleClass('is-selected', i === index));
    rows[index]?.scrollIntoView({ block: 'nearest' });
  };

  const renderList = (): void => {
    panel.empty();
    panel.addClass('is-open');
    list = panel.createDiv({ cls: 'dsh-agent-inline-list dsh-agent-hover-list' });
    let lastGroup: string | undefined;
    opts.options.forEach((option, index) => {
      if (option.group !== undefined && option.group !== lastGroup) {
        const title = option.groupTitle ?? option.group;
        if (title !== '') list!.createDiv({ cls: 'dsh-agent-inline-group', text: title });
        lastGroup = option.group;
      }
      const row = list!.createDiv({
        cls: 'dsh-agent-inline-item dsh-agent-hover-item' + (index === selectedIndex ? ' is-selected' : ''),
      });
      row.dataset.optionId = option.id;
      if (option.selected === true) {
        const check = row.createSpan({ cls: 'dsh-agent-hover-check' });
        check.setText('✓');
      }
      const textEl = row.createDiv({ cls: 'dsh-agent-inline-text' });
      textEl.createDiv({ cls: 'dsh-agent-inline-label', text: option.label });
      if (option.description !== undefined && option.description !== '') {
        textEl.createDiv({ cls: 'dsh-agent-inline-desc', text: option.description });
      }
      row.onmouseenter = () => highlight(index);
      row.onclick = () => {
        const id = option.id;
        clear();
        opts.onChoose(id);
      };
    });
  };

  const move = (delta: number): void => {
    if (opts.options.length === 0) return;
    highlight(Math.min(Math.max(selectedIndex + delta, 0), opts.options.length - 1));
  };

  const pick = (): void => {
    const option = opts.options[selectedIndex];
    if (option === undefined) return;
    const id = option.id;
    clear();
    opts.onChoose(id);
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clear();
      chip.focus();
    }
  };

  const state: HoverMenuState = {
    panel,
    chip,
    close: clear,
    cancelClose: () => {},
    scheduleClose: () => {},
    handleKey,
  };

  const openMenu = (): void => {
    if (activeHoverMenu === state && open) return;
    if (activeHoverMenu !== null && activeHoverMenu !== state) {
      detachActiveHoverMenu();
    }
    activeHoverMenu = state;
    open = true;
    panel.tabIndex = -1;
    selectedIndex = Math.max(0, opts.options.findIndex((o) => o.selected === true));
    renderList();
    panel.focus();
  };

  // Click toggles the menu (no hover-open: moving the mouse across
  // neighbouring chips would otherwise steal the menu).
  chip.addEventListener('click', () => {
    if (activeHoverMenu === state && open) {
      clear();
      return;
    }
    openMenu();
  });
  chip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clear();
      chip.blur();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) move(-1);
    }
  });

  // Shared panel/document listeners registered exactly once per panel element.
  if (panel.dataset.hoverAttached !== '1') {
    panel.dataset.hoverAttached = '1';
    panel.addEventListener('keydown', (event) => activeHoverMenu?.handleKey(event));
    document.addEventListener('mousedown', (event) => {
      const menu = activeHoverMenu;
      if (menu === null) return;
      const target = event.target as Node | null;
      if (target === null) return;
      if (menu.panel.contains(target) || menu.chip.contains(target)) return;
      menu.close();
    });
  }
}
