'use client';

import React, { useEffect, useState } from 'react';

const palette = {
  light: {
    header: 'rgba(250, 251, 248, 0.86)',
    border: '#e4e8e0',
    text: '#17211b',
    muted: '#66736a',
    button: '#f1f4ef',
    buttonBorder: '#dfe6dd',
    accent: '#2f855a',
    mark: '#1f6b47',
  },
  dark: {
    header: 'rgba(20, 28, 24, 0.9)',
    border: '#344139',
    text: '#eef5ef',
    muted: '#a7b5aa',
    button: '#27342b',
    buttonBorder: '#3c4b40',
    accent: '#8bd5a6',
    mark: '#83c99a',
  },
};

export default function Header() {
  const [theme, setTheme] = useState('light');
  const colors = palette[theme];

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('nodeforge-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') setTheme(savedTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('nodeforge-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((current) => (current === 'light' ? 'dark' : 'light'));

  return (
    <header
      aria-label="Main navigation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(14px)',
        background: colors.header,
        borderBottom: `1px solid ${colors.border}`,
        color: colors.text,
        display: 'flex',
        justifyContent: 'space-between',
        minHeight: 72,
        padding: '0 clamp(20px, 5vw, 72px)',
        position: 'relative',
        width: '100%',
        zIndex: 10,
      }}
    >
      <a href="/" aria-label="NodeForge home" style={{ alignItems: 'center', color: colors.text, display: 'flex', gap: 11, textDecoration: 'none' }}>
        <span aria-hidden="true" style={{ alignItems: 'center', background: colors.mark, borderRadius: 10, color: '#fff', display: 'inline-flex', fontSize: 17, fontWeight: 800, height: 34, justifyContent: 'center', letterSpacing: '-0.06em', width: 34 }}>N</span>
        <span style={{ fontSize: 19, fontWeight: 750, letterSpacing: '-0.04em' }}>NodeForge</span>
      </a>

      <nav aria-label="Header actions" style={{ alignItems: 'center', display: 'flex', gap: 10 }}>
        <button type="button" style={{ background: colors.button, border: `1px solid ${colors.buttonBorder}`, borderRadius: 9, color: colors.text, cursor: 'pointer', fontSize: 14, fontWeight: 650, padding: '10px 16px' }}>
          Agents
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          style={{ alignItems: 'center', background: colors.button, border: `1px solid ${colors.buttonBorder}`, borderRadius: 9, color: colors.accent, cursor: 'pointer', display: 'inline-flex', height: 40, justifyContent: 'center', width: 40 }}
        >
          {theme === 'light' ? (
            <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><path d="M12 3v2m0 14v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M3 12h2m14 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></svg>
          ) : (
            <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
          )}
        </button>
      </nav>
    </header>
  );
}
