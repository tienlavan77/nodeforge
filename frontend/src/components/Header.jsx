// NodeForge summary: Reusable JSX header with the NodeForge logo and Agents action.
import React from 'react';

export default function Header() {
  return (
    <header className="site-header" aria-label="Main navigation">
      <a className="site-header__logo" href="/" aria-label="NodeForge home">
        <span className="site-header__logo-mark" aria-hidden="true">N</span>
        <span>NodeForge</span>
      </a>

      <button className="site-header__agents" type="button">
        Agents
      </button>
    </header>
  );
}
