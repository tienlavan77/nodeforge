// Loads project conversations and keeps the displayed list synchronized with API data.
"use client";

import { useEffect, useRef, useState } from "react";
import { applyStoredOrder, dedupeConversations, fetchConversationList } from "./conversation-list-utils.js";
import { sortPinnedFirst } from "./conversation-pinning.js";

// Manages conversation list state, loading status, and project-scoped refreshes.
export function useConversationList({ conversations = [], projectId, agentId } = {}) {
  const [items, setItems] = useState(() => [...conversations]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const fetchedKeyRef = useRef(null);

  useEffect(() => {
    setItems(sortPinnedFirst(applyStoredOrder(dedupeConversations([...conversations]))));
  }, [conversations]);

  useEffect(() => {
    const key = `${projectId ?? ""}::${agentId ?? ""}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;
    let cancelled = false;

    // Fetches project-scoped conversations and updates the list when still mounted.
    async function loadConversations() {
      setLoading(true);
      setFetchError("");
      try {
        const fetched = await fetchConversationList({ projectId, agentId });
        if (cancelled) return;
        setItems(sortPinnedFirst(applyStoredOrder(dedupeConversations(fetched))));
      } catch (error) {
        if (cancelled) return;
        setFetchError(error?.message ?? "Unable to load conversations.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadConversations();
    return () => { cancelled = true; };
  }, [projectId, agentId]);

  return { items, setItems, loading, fetchError };
}
