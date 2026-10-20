// Verifies the chat Settings menu picks Tools and Effort with sliding segmented controls.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { segmentAt } from "../lib/segment-picker.js";

test("Settings menu replaces the Effort and Tools selects with sliding segmented controls", async () => {
  const menu = await readFile("ui/nextjs/components/system-tool-mode.jsx", "utf8");
  const control = await readFile("ui/nextjs/components/segmented-control.jsx", "utf8");
  const styles = await readFile("ui/nextjs/app/styles/home-conversation.css", "utf8");
  const globals = await readFile("ui/nextjs/app/globals.css", "utf8");
  assert.match(globals, /@import "\.\/styles\/home-conversation\.css";/);
  assert.match(styles, /\.composer-agent-settings-menu \{[^}]*box-sizing: border-box; width: min\(320px, calc\(100vw - 32px\)\)/);

  // Both chat pages keep a single shared control surface.
  assert.match(menu, /import \{ SegmentedControl \} from "\.\/segmented-control\.jsx"/);
  assert.match(menu, /<SegmentedControl name="effort"[\s\S]*?<SegmentedControl name="tool_mode"/);
  assert.match(menu, /const EFFORTS = \[\["low", "Low"\], \["medium", "Medium"\], \["high", "High"\]\]/);
  assert.match(menu, /const TOOL_MODES = \[\["forge", "Forge"\], \["builtin", "Built-in"\]\]/);
  // Provider and Model keep their dropdowns; the two new pickers must not be selects.
  assert.match(menu, /<label>Provider<select/);
  assert.match(menu, /<label>Model<select/);
  assert.match(styles, /\.composer-agent-settings-menu select \{[^}]*background-position: calc\(100% - 17px\) 50%, calc\(100% - 12px\) 50%;/);
  assert.match(styles, /\.composer-agent-settings-menu select \{[^}]*background-repeat: no-repeat;[^}]*padding: 5px 34px 5px 6px;[^}]*appearance: none; -webkit-appearance: none;/);
  assert.doesNotMatch(menu, /<label>Effort<select/);
  assert.doesNotMatch(menu, /<label>Tools<select/);

  // Press-and-slide selection with a highlight that travels between options.
  assert.match(control, /role="radiogroup"/);
  assert.match(control, /onPointerDown=\{onPointerDown\} onPointerMove=\{onPointerMove\} onPointerUp=\{onPointerUp\} onPointerCancel=\{onPointerCancel\}/);
  assert.match(control, /setPointerCapture/);
  assert.match(control, /composer-segmented-thumb/);
  assert.match(control, /transform: `translateX\(\$\{shown \* 100\}%\)`/);
  assert.match(control, /role="radio" aria-checked=\{index === active\}/);
  assert.match(control, /ArrowRight/);

  // The built-in option stays unreachable unless the provider allows it.
  assert.match(menu, /disabled: value === "builtin" && !builtinAllowed/);

  assert.match(styles, /\.composer-segmented-thumb \{[^}]*transition: transform/);
  assert.match(styles, /\.composer-segmented-option \{[^}]*flex: 1 1 0/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?\.composer-segmented-thumb \{ transition: none; \}/);
});

test("both chat pages mount the segmented settings control on the selected agent", async () => {
  const architecture = await readFile("ui/nextjs/components/architecture-workspace.jsx", "utf8");
  const system = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
  for (const [name, page] of [["architecture", architecture], ["system", system]]) {
    assert.match(page, /import \{ SystemToolMode \} from/, `${name} page must mount SystemToolMode`);
    assert.match(page, /<SystemToolMode key=\{[^}]*\.id\} agent=\{/, `${name} page must key the control by agent`);
  }
});

// The drag handler must settle on the nearest enabled segment, never on a disabled one.
test("segment hit-testing skips disabled options", () => {
  const rects = [[0, 50], [50, 100], [100, 150]];
  const items = rects.map(([left, right]) => ({ getBoundingClientRect: () => ({ width: right - left, left, right }) }));
  const options = [{ value: "low" }, { value: "medium", disabled: true }, { value: "high" }];

  assert.equal(segmentAt(items, options, 5), 0);
  assert.equal(segmentAt(items, options, 50), 0, "boundary stays on the left segment");
  assert.equal(segmentAt(items, options, 60), 0, "drag stopped over a disabled segment snaps back to where it started");
  assert.equal(segmentAt(items, options, 90), 2, "drag continued past a disabled segment snaps forward");
  assert.equal(segmentAt(items, options, 120), 2);

  const allEnabled = options.map((option) => ({ ...option, disabled: false }));
  assert.equal(segmentAt(items, allEnabled, 75), 1);

  const noneEnabled = options.map((option) => ({ ...option, disabled: true }));
  assert.equal(segmentAt(items, noneEnabled, 75), -1, "fully disabled track selects nothing");
});
