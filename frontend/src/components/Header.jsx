'use client';

import { useEffect, useState } from 'react';

export function ThemeToggle() {


}

export default function Header() {
  return (
    <header
      aria-label="Main navigation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(14px)',
        background: 'var(--header-background)',
        borderBottom: '1px solid var(--header-border)',
        color: 'var(--page-text)',
        display: 'flex',
        justifyContent: 'space-between',
        minHeight: 72,
        padding: '0 clamp(20px, 5vw, 72px)',
        position: 'relative',
        width: '100%',
        zIndex: 10,
      }}
    >
      <a href="/" aria-label="NodeForge home" style={{ alignItems: 'center', color: 'var(--page-text)', display: 'flex', gap: 11, textDecoration: 'none' }}>
        <span aria-hidden="true" style={{ alignItems: 'center', background: 'var(--header-mark)', borderRadius: 10, color: '#fff', display: 'inline-flex', fontSize: 17, fontWeight: 800, height: 34, justifyContent: 'center', letterSpacing: '-0.06em', width: 34 }}>N</span>
        <span style={{ fontSize: 19, fontWeight: 750, letterSpacing: '-0.04em' }}>NodeForge</span>
      </a>

      <nav aria-label="Header actions" style={{ alignItems: 'center', display: 'flex', gap: 10 }}>
        <a href="/agents" style={{ background: 'var(--header-button)', border: '1px solid var(--header-button-border)', borderRadius: 9, color: 'var(--page-text)', cursor: 'pointer', fontSize: 14, fontWeight: 650, padding: '10px 16px', textDecoration: 'none' }}>
          Agents
        </a>
        <a href="/login" style={{ background: 'var(--header-mark)', border: '1px solid var(--header-mark)', borderRadius: 9, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: '10px 16px', textDecoration: 'none' }}>
          Login
        </a>
      </nav>
    </header>
  );
}
