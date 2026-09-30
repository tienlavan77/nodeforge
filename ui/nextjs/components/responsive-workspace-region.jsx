// Keeps each workspace region mounted while presenting it as a responsive drawer.
"use client";

import { useEffect, useRef, useState } from "react";
import { installDialogBehavior } from "./DialogBehavior.js";

// Presents a region inline on wide screens and with dialog focus behavior on narrow screens.
export function ResponsiveWorkspaceRegion({ name, title, breakpoint, open, onClose, children }) {
  const [narrow, setNarrow] = useState(false);
  const panelRef = useRef(null);
  const previousFocus = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [breakpoint]);

  useEffect(() => {
    if (!narrow || !open || !panelRef.current) return undefined;
    return installDialogBehavior({ dialog: panelRef.current, documentRef: document, onCloseRef: closeRef, previousFocus });
  }, [narrow, open]);

  return <div className={`responsive-region responsive-region--${name}${narrow ? " is-drawer" : ""}${open ? " is-open" : ""}`}
    role={narrow && open ? "presentation" : undefined}
    aria-hidden={narrow && !open ? "true" : undefined}
    onMouseDown={(event) => { if (narrow && open && event.target === event.currentTarget) onClose?.(); }}>
    <div ref={panelRef} className="responsive-region-panel" role={narrow && open ? "dialog" : undefined}
      aria-modal={narrow && open ? "true" : undefined} aria-label={narrow && open ? title : undefined} tabIndex={narrow && open ? -1 : undefined}>
      {narrow && open && <div className="responsive-region-heading"><strong>{title}</strong><button type="button" onClick={onClose} aria-label={`Close ${title}`}>×</button></div>}
      {children}
    </div>
  </div>;
}
