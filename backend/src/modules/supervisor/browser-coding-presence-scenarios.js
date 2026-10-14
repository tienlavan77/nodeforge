// Verifies approved local-browser panel membership, restoration and storage failure behavior on the committed Coding page.
import assert from "node:assert/strict";

const key = "nodeforge:coding:panel-state:PROJECT-BROWSER";
const panels = '.coding-agent-monitor[data-project-id="PROJECT-BROWSER"]';

// Creates distinguishable existing-contract activity with explicit identity and optional run boundary.
function activity(agentId, step, run = "RUN-1", started = false, projectId = "PROJECT-BROWSER") {
  return { event_type: "agent.activity", event_id: `${agentId}-${run}-${step}`, project_id: projectId,
    payload: { agent_id: agentId, status: "working", activity_type: started ? "started" : "tool_started",
      ...(run ? { correlation_id: `${agentId}-${run}` } : {}), summary: `${projectId}-${agentId}-action-${step}` } };
}

// Waits for real React reconciliation to produce precisely the expected identities.
async function expectPanels(page, agentIds) {
  await page.waitForFunction(({ selector, ids }) => JSON.stringify([...document.querySelectorAll(selector)].map((panel) => panel.dataset.agentId).sort()) === JSON.stringify(ids.sort()), { selector: panels, ids: agentIds });
}

// Delivers controlled activity through the page's existing stream callbacks and shared buffer.
async function deliver(page, events, source) {
  await page.evaluate((input) => window.presenceFixture.deliver(input.events, input.source), { events, source });
}

// Starts with clean browser-local membership and records actual writes to prove debounce and payload boundaries.
async function setup(page) {
  await page.evaluate(() => {
    window.presenceFixture.unmount();
    localStorage.clear();
    window.storageWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { window.storageWrites.push({ key, value }); return original.call(this, key, value); };
    window.presenceFixture.mount();
  });
  await deliver(page, [activity("coder-1", 1, "RUN-1", true), activity("coder-2", 1, "RUN-1", true)]);
  await expectPanels(page, ["coder-1", "coder-2"]);
  await page.getByRole("button", { name: "Close agent panel coder-2 in project PROJECT-BROWSER", exact: true }).click();
  await expectPanels(page, ["coder-1"]);
  await page.waitForFunction((storageKey) => {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return data?.open?.length === 1 && data?.closed?.length === 1;
  }, key);
}

// Proves only versioned identity membership was persisted, never activity, execution markers or layout state.
async function assertMembership(page) {
  const stored = await page.evaluate((storageKey) => ({ keys: Object.keys(localStorage), data: JSON.parse(localStorage.getItem(storageKey)), writes: window.storageWrites }), key);
  assert.deepEqual(stored.keys, [key]);
  assert.deepEqual(stored.data, { version: 1, open: [["PROJECT-BROWSER", "coder-1"]], closed: [["PROJECT-BROWSER", "coder-2"]] });
  assert.equal(stored.writes.length, 1, "rapid activity and close must coalesce into one debounced save");
}

// Checks reload/navigation restore membership before defaults and refill actions exclusively from the current buffer.
async function verifyReload(page) {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.presenceFixture));
  await expectPanels(page, ["coder-1"]);
  assert.equal(await page.locator(`${panels} > div`).count(), 0);
  const events = [activity("coder-2", 0, null), activity("coder-1", 0, null, false, "FOREIGN"), ...Array.from({ length: 60 }, (_, step) => activity("coder-1", step, null))];
  await deliver(page, events);
  await expectPanels(page, ["coder-1"]);
  assert.equal(await page.locator(`${panels} > div`).count(), 50);
  const text = await page.locator(panels).textContent();
  assert.ok(!text.includes("FOREIGN") && !text.includes("coder-2-action"));
  assert.ok(!text.includes("action-0") && text.includes("action-59"));
  await page.goto(new URL("/away", page.url()).href);
  await page.goBack();
  await page.waitForFunction(() => Boolean(window.presenceFixture));
  await expectPanels(page, ["coder-1"]);
  assert.equal(await page.locator(`${panels} > div`).count(), 0);
}

// Confirms buffered restoration and markerless/same-run activity preserve closure, then a new live run reopens it.
async function verifyRestoredClosure(page) {
  await page.evaluate((buffered) => {
    window.presenceFixture.unmount();
    window.presenceFixture.buffered = buffered;
    window.presenceFixture.holdDirectory = true;
    window.presenceFixture.mount();
  }, [activity("coder-2", 1, "RUN-1", true)]);
  await expectPanels(page, []);
  assert.deepEqual(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)).closed, key), [["PROJECT-BROWSER", "coder-2"]]);
  await page.evaluate(() => { window.presenceFixture.holdDirectory = false; window.presenceFixture.releaseDirectory(); });
  await expectPanels(page, ["coder-1"]);
  await deliver(page, [activity("coder-2", 2), activity("coder-2", 3, null)]);
  await expectPanels(page, ["coder-1"]);
  await deliver(page, [activity("coder-2", 4, "RUN-2", true)]);
  await expectPanels(page, ["coder-1", "coder-2"]);
}

// Exercises real browser storage read/write/parse failures and requires logged diagnostics plus usable panel controls.
async function verifyStorageFailures(page) {
  for (const mode of ["read", "write", "malformed"]) {
    await page.evaluate((failureMode) => {
      window.presenceFixture.unmount();
      localStorage.clear();
      window.presenceFixture.buffered = [];
      window.storageDiagnostics = [];
      const originalError = console.error;
      console.error = (...args) => { window.storageDiagnostics.push(String(args[0])); originalError(...args); };
      window.originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
      if (failureMode === "read") Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Controlled storage read denial"); } });
      if (failureMode === "write") {
        const storage = window.localStorage;
        Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key) => storage.getItem(key), setItem() { throw new Error("Controlled storage write denial"); } } });
      }
      if (failureMode === "malformed") localStorage.setItem("nodeforge:coding:panel-state:PROJECT-BROWSER", "{not-json");
      window.presenceFixture.mount();
    }, mode);
    await deliver(page, [activity("coder-1", 1, mode, true)]);
    await expectPanels(page, ["coder-1"]);
    await page.waitForFunction(() => window.storageDiagnostics.length > 0);
    await page.getByRole("button", { name: "Close agent panel coder-1 in project PROJECT-BROWSER", exact: true }).click();
    await expectPanels(page, []);
    await page.evaluate(() => {
      window.presenceFixture.unmount();
      Object.defineProperty(window, "localStorage", window.originalStorageDescriptor);
    });
  }
}

// Executes only implemented approved presence assertions, failing on any missing UI or storage guarantee.
export async function verifyCodingPresenceAssertion(index, page) {
  if (index === 16) return verifyStorageFailures(page);
  await setup(page);
  if (index === 13) await assertMembership(page);
  else if (index === 14) await verifyReload(page);
  else if (index === 15) await verifyRestoredClosure(page);
  else throw new Error("No Coding presence scenario implements this assertion.");
}
