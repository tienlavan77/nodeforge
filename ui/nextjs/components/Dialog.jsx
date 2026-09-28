// Shared accessible dialogs for modal, confirmation, and drawer workflows.
"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { installDialogBehavior, shouldCloseOnOutsideClick } from "./DialogBehavior";

// Render an accessible portal dialog with modal, confirmation, or drawer presentation.
export function Dialog({ open, onClose, children, labelledBy, describedBy, label, variant = "modal", closeOnOutsideClick = true, className = "" }) {
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    return installDialogBehavior({ dialog: dialogRef.current, documentRef: document, onCloseRef, previousFocus });
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(<div className={`shared-dialog-backdrop ${variant} ${className}`} onMouseDown={(event) => {
    if (shouldCloseOnOutsideClick(event, closeOnOutsideClick)) onCloseRef.current?.();
  }}>
    <section ref={dialogRef} className="shared-dialog-panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} aria-label={label || (labelledBy ? undefined : "Dialog")} tabIndex={-1}>
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
