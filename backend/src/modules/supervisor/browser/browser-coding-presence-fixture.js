// Mounts the committed Coding page to verify actual persistence effects through reload and navigation.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import CodingPage from "@ticket/ui/app/coding/page.jsx";
import { deliverPresenceEvents } from "./browser-coding-presence-adapters.js";
import "@ticket/ui/app/styles/workspace-monitors.css";

const root = createRoot(document.getElementById("root"));
let revision = 0;
window.presenceFixture = {
  buffered: [], deliver: deliverPresenceEvents,
  mount: () => flushSync(() => root.render(React.createElement(CodingPage, { key: ++revision }))),
  unmount: () => flushSync(() => root.render(null))
};
window.presenceFixture.mount();
