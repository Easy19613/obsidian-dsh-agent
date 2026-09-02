interface WindowOwnedElement {
  ownerDocument: {
    defaultView: Window | null;
  };
}

/** Resolve the window that actually owns a view element, including Obsidian popouts. */
export function ownerWindowOf(element: WindowOwnedElement, fallback: Window): Window {
  return element.ownerDocument.defaultView ?? fallback;
}
