"use client";
// Reveal live conversation responses at a readable pace even when the agent sends one large event.

import { useEffect, useRef, useState } from "react";
import { MessageContent } from "./conversation-message-content.jsx";

// Displays saved messages immediately and progressively reveals new agent responses.
export function ConversationResponseReveal({ text, reveal = false, onReveal }) {
  const fullText = String(text ?? "");
  const [visibleText, setVisibleText] = useState(reveal ? "" : fullText);
  const visibleRef = useRef(visibleText);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  useEffect(() => {
    if (!reveal || window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
      visibleRef.current = fullText;
      setVisibleText(fullText);
      return undefined;
    }
    if (!fullText.startsWith(visibleRef.current)) {
      visibleRef.current = fullText;
      setVisibleText(fullText);
      return undefined;
    }
    const characters = Array.from(fullText);
    let position = Array.from(visibleRef.current).length;
    if (position >= characters.length) return undefined;
    const charactersPerSecond = Math.max(180, characters.length / 2.8);
    let previousTick = performance.now();
    let timer;

    // Advances the visible response in small batches without delaying message delivery.
    function advance() {
      if (document.hidden) position = characters.length;
      else {
        const now = performance.now();
        position = Math.min(characters.length, position + Math.max(1, Math.ceil((now - previousTick) * charactersPerSecond / 1000)));
        previousTick = now;
      }
      visibleRef.current = characters.slice(0, position).join("");
      setVisibleText(visibleRef.current);
      onRevealRef.current?.();
      if (position < characters.length) timer = window.setTimeout(advance, 32);
    }
    timer = window.setTimeout(advance, 32);
    return () => window.clearTimeout(timer);
  }, [fullText, reveal]);

  return <MessageContent text={reveal ? visibleText : fullText} />;
}
