// Shared accessible dialogs for modal, confirmation, and drawer workflows.
"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { installDialogBehavior, shouldCloseOnOutsideClick } from "./DialogBehavior";

const PRESENTATION_STYLES = {
  modal: { alignItems: "center", justifyContent: "center" },
  confirmation: { alignItems: "center", justifyContent: "center" },
  drawer: { alignItems: "stretch", justifyContent: "flex-end" },
};

const PANEL_STYLES = {
  modal: { width: "min(92vw, 720px)", maxHeight: "90vh", borderRadius: "12px" },
  confirmation: { width: "min(92vw, 440px)", maxHeight: "90vh", borderRadius: "12px" },
  drawer: { width: "min(92vw, 420px)", height: "100vh", maxHeight: "100vh", borderRadius: "0" },
};

// Resolve the business presentation contract for each shared dialog variant.
export function getDialogPresentation(variant = "modal") {
  const resolvedVariant = PRESENTATION_STYLES[variant] ? variant : "modal";
  return {
    variant: resolvedVariant,
    backdrop: PRESENTATION_STYLES[resolvedVariant],
    panel: PANEL_STYLES[resolvedVariant],
  };
}

// Render an accessible portal dialog with modal, confirmation, or drawer presentation.
export function Dialog({ open, onClose, children, labelledBy, describedBy, label, variant = "modal", closeOnOutsideClick = true, className = "" }) {
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { variant: resolvedVariant, backdrop, panel } = getDialogPresentation(variant);
  const presentation = backdrop;
  const panelStyle = panel;

  useEffect(() => {
    if (!open) return undefined;
    return installDialogBehavior({ dialog: dialogRef.current, documentRef: document, onCloseRef, previousFocus });
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`shared-dialog-backdrop ${resolvedVariant} ${className}`}
      data-dialog-variant={resolvedVariant}
      data-dialog-layout={resolvedVariant === "drawer" ? "drawer" : "centered"}
      onMouseDown={(event) => {
        if (shouldCloseOnOutsideClick(event, closeOnOutsideClick)) onCloseRef.current?.();
      }}
      style={{ ...presentation, position: "fixed", inset: 0, display: "flex", zIndex: 1000 }}
    >
      <section
        ref={dialogRef}
        className={`shared-dialog-panel shared-dialog-panel--${resolvedVariant}`}
        data-dialog-variant={resolvedVariant}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={label || (labelledBy ? undefined : "Dialog")}
        tabIndex={-1}
        style={{ ...panelStyle, overflowY: "auto", background: "var(--dialog-surface, #fff)" }}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
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
