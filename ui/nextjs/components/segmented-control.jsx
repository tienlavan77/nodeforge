// Sliding segmented picker: press a segment, or drag across the track, to choose a value.
"use client";

import { useRef, useState } from "react";
import { segmentAt } from "../lib/segment-picker.js";

// Renders a radio group whose highlight slides between options.
export function SegmentedControl({ name, label, value, options, onChange, disabled = false }) {
  const trackRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const active = Math.max(0, options.findIndex((item) => item.value === value));
  const shown = preview ?? active;
  const stepWidth = options.length ? 100 / options.length : 100;

  function items() {
    return Array.from(trackRef.current?.querySelectorAll("[data-segment]") ?? []);
  }

  function commit(index) {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    if (option.value !== value) onChange(option.value);
  }

  function onPointerDown(event) {
    if (disabled) return;
    const index = segmentAt(items(), options, event.clientX);
    if (index < 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPreview(index);
  }

  function onPointerMove(event) {
    if (disabled || preview === null) return;
    const index = segmentAt(items(), options, event.clientX);
    if (index >= 0) setPreview(index);
  }

  function onPointerUp() {
    if (preview !== null) commit(preview);
    setPreview(null);
  }

  function onPointerCancel() {
    setPreview(null);
  }

  // Arrow keys move the selection like a native radio group.
  function onKeyDown(event) {
    if (disabled) return;
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    let index = active;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = options.length - 1;
    else {
      for (let step = 0; step < options.length; step += 1) {
        index = (index + delta + options.length) % options.length;
        if (!options[index]?.disabled) break;
      }
    }
    if (!options[index]?.disabled) {
      if (options[index].value !== value) onChange(options[index].value);
      items()[index]?.focus?.();
    }
  }

  return <div className="composer-segmented" aria-label={label}>
    <span className="composer-segmented-label">{label}</span>
    <div className={`composer-segmented-track${disabled ? " composer-segmented-disabled" : ""}`} ref={trackRef} role="radiogroup" aria-label={`${label} ${name}`} tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <span className="composer-segmented-thumb" data-preview={shown} aria-hidden="true" style={{ transform: `translateX(${shown * 100}%)`, width: `${stepWidth}%` }} />
      {options.map((option, index) => <button key={option.value} type="button" data-segment={option.value} role="radio" aria-checked={index === active} disabled={disabled || option.disabled} className={`composer-segmented-option${index === active ? " composer-segmented-option-active" : ""}`} onClick={() => commit(index)}>{option.label}</button>)}
    </div>
  </div>;
}
