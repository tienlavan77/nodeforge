"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "nodeforge-theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState("dark");
  const label = useMemo(() => (theme === "dark" ? "Light mode" : "Dark mode"), [theme]);

  useEffect(() => {
    const nextTheme = getInitialTheme();
    setTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.type === "storage" && event.key !== STORAGE_KEY) return;
      const nextTheme = (event.type === "storage" ? event.newValue : event.detail) === "light" ? "light" : "dark";
      setTheme(nextTheme);
      applyTheme(nextTheme);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("nodeforge-theme-change", handleStorage);
    return () => { window.removeEventListener("storage", handleStorage); window.removeEventListener("nodeforge-theme-change", handleStorage); };
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
    window.dispatchEvent(new CustomEvent("nodeforge-theme-change", { detail: nextTheme }));
  };

  return <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={label} title={label}>{theme === "dark" ? "☾" : "☀"}</button>;
}
