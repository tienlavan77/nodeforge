// Serve the coding conversation workspace at the canonical /code route.
"use client";

import SystemPage from "../system/page.jsx";

// Render the coding workspace while preserving its /code navigation identity.
export default function CodePage() {
  return <SystemPage sectionTitle="Code" />;
}
