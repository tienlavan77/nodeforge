// Shared accessible dialogs for modal, confirmation, and drawer workflows.
"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Return the interactive elements eligible for keyboard focus within a dialog.
function getFocusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

// Keep keyboard focus inside an open dialog and restore it to the invoking control.
export function Dialog({ open, onClose, children, labelledBy, describedBy, label, variant = "modal", closeOnOutsideClick = true, className = "" }) {
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = getFocusableElements(dialog);
    (focusable[0] ?? dialog).focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose?.(); return; }
      if (event.key !== "Tab") return;
      const items = getFocusableElements(dialog);
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(<div className={`shared-dialog-backdrop ${variant} ${className}`} onMouseDown={(event) => {
    if (closeOnOutsideClick && event.target === event.currentTarget) onClose?.();
  }}>
    <section ref={dialogRef} className="shared-dialog-panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} aria-label={label} tabIndex={-1}>
      {children}
    </section>
  </div>, document.body);
}

// Present a confirmation dialog with explicit confirm and cancel actions.
export function ConfirmationDialog({ open, onClose, onConfirm, title, children, confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
  const titleId = "shared-confirmation-title";
  return <Dialog open={open} onClose={onClose} labelledBy={titleId} variant="confirmation">
    <h2 id={titleId}>{title}</h2><div>{children}</div>
    <div className="shared-dialog-actions"><button type="button" onClick={onClose}>{cancelLabel}</button><button type="button" onClick={onConfirm}>{confirmLabel}</button></div>
  </Dialog>;
}

// Present dialog content as a drawer while retaining shared keyboard behavior.
export function Drawer({ open, onClose, children, labelledBy, label, className = "" }) {
  return <Dialog open={open} onClose={onClose} labelledBy={labelledBy} label={label} variant="drawer" className={className}>{children}</Dialog>;
}
