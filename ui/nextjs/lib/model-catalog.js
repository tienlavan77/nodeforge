// Loads provider model choices from one project catalog for agent profile selectors.
import { useEffect, useState } from "react";
import bundledCatalog from "../public/model-catalog.json" with { type: "json" };

// Refreshes model choices when a selector opens while retaining bundled choices on network failure.
export function useModelCatalog() {
  const [catalog, setCatalog] = useState(bundledCatalog.providers);
  useEffect(() => {
    const controller = new AbortController();
    // Refreshes the catalog during long-lived UI sessions after the JSON file changes.
    function refresh() {
      fetch(`/model-catalog.json?v=${Date.now()}`, { cache: "no-store", signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}.`);
          return response.json();
        })
        .then((result) => { if (result?.providers && typeof result.providers === "object") setCatalog(result.providers); })
        .catch((error) => { if (error.name !== "AbortError") console.error("Model catalog refresh failed:", error); });
    }
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => { clearInterval(interval); controller.abort(); };
  }, []);
  return catalog;
}

// Returns models for one provider and keeps an existing profile model selectable.
export function getModelOptions(catalog, provider, currentModel) {
  const models = Array.isArray(catalog?.[provider]) ? catalog[provider] : [];
  const options = models.filter((model) => typeof model?.value === "string" && model.value && typeof model.label === "string");
  if (currentModel && !options.some((model) => model.value === currentModel)) return [{ value: currentModel, label: currentModel }, ...options];
  return options;
}
