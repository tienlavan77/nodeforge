// Shared dialog interaction behavior for focus containment, dismissal, and restoration.

// Return the interactive elements eligible for keyboard focus within a dialog.
export function getFocusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

// Install accessible dialog keyboard and focus behavior for the current open cycle.
// Identify backdrop clicks that should dismiss an open dialog.
export function shouldCloseOnOutsideClick(event, enabled) {
  return enabled && event.target === event.currentTarget;
}

export function installDialogBehavior({ dialog, documentRef, onCloseRef, previousFocus }) {
  previousFocus.current = documentRef.activeElement;
  const focusable = getFocusableElements(dialog);
  (focusable[0] ?? dialog).focus();
  const onKeyDown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); onCloseRef.current?.(); return; }
    if (event.key !== "Tab") return;
    const items = getFocusableElements(dialog);
    if (!items.length) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (documentRef.activeElement === first || !dialog.contains(documentRef.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (documentRef.activeElement === last || !dialog.contains(documentRef.activeElement))) { event.preventDefault(); first.focus(); }
  };
  documentRef.addEventListener("keydown", onKeyDown);
  return () => {
    documentRef.removeEventListener("keydown", onKeyDown);
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  };
}
