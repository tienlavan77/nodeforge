// Verifies the approved new Coding ticket's identity isolation, accessible closing and next-run reopening in real Chromium.
import assert from "node:assert/strict";

// Selects a panel by its exact controlled project and agent identity instead of display labels.
const panel = (agentId) => `[data-project-id="PROJECT-BROWSER"][data-agent-id="${agentId}"]`;

// Supplies explicit existing-contract run identities so closed panels cannot reopen from ambiguous activity.
function activity(agentId, correlationId, step, activityType = "tool_started", status = "working", projectId = "PROJECT-BROWSER") {
  return { project_id: projectId, event_type: "agent.activity", event_id: `${projectId}-${agentId}-${correlationId}-${step}`, timestamp: `2026-10-14T00:00:${String(step).padStart(2, "0")}Z`,
    payload: { agent_id: agentId, correlation_id: correlationId, activity_type: activityType, status, summary: `${projectId}-${agentId}-action-${step}` } };
}

// Delivers approved controlled events through the real registry and component, never the production API.
async function update(page, events, source) {
  await page.evaluate((input) => window.browserFixture.update(input), { events, source });
}

// Counts only exact project/agent identities after React has applied the user action or activity boundary.
async function assertPanels(page, agentIds) {
  await page.waitForFunction((expected) => {
    const actual = [...document.querySelectorAll('.coding-agent-monitor[data-project-id="PROJECT-BROWSER"]')].map((element) => element.dataset.agentId).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, agentIds);
}

// Proves a different agent panel retains its actual DOM element while one panel closes or reopens.
async function assertOtherRetained(page) {
  assert.equal(await page.evaluate(() => window.otherPanel === document.querySelector('[data-agent-id="coder-2"]') && window.otherPanel.isConnected), true);
}

// Executes each exact approved new-ticket assertion with observable browser actions and frozen event identities.
export async function verifyCodingLifecycleAssertion(index, page) {
  const initial = [activity("coder-1", "RUN-1", 1, "started"), activity("coder-2", "RUN-2", 1, "started")];
  await update(page, initial);
  await assertPanels(page, ["coder-1", "coder-2"]);
  await page.evaluate(() => { window.otherPanel = document.querySelector('[data-agent-id="coder-2"]'); });
  if (index === 10) {
    await update(page, [...initial, activity("coder-1", "FOREIGN-RUN", 2, "started", "working", "FOREIGN")]);
    for (const agentId of ["coder-1", "coder-2"]) {
      const element = page.locator(panel(agentId));
      assert.equal(await element.locator("header strong").textContent(), "Same name");
      assert.ok((await element.textContent()).includes(`PROJECT-BROWSER-${agentId}-action-1`));
      assert.ok(!(await element.textContent()).includes(`PROJECT-BROWSER-${agentId === "coder-1" ? "coder-2" : "coder-1"}-action-1`));
      assert.ok(!(await element.textContent()).includes("FOREIGN-coder-1-action-2"));
      assert.equal(await element.getAttribute("data-project-id"), "PROJECT-BROWSER");
    }
    assert.equal(await page.locator('.coding-agent-monitor[data-project-id="FOREIGN"]').count(), 0);
  } else if (index === 11) {
    // Defines close function behavior for browser-coding-lifecycle-scenarios.js.
    const close = () => page.getByRole("button", { name: "Close agent panel coder-1 in project PROJECT-BROWSER", exact: true });
    await close().focus();
    assert.equal(await close().evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    await assertPanels(page, ["coder-2"]);
    await assertOtherRetained(page);
    await update(page, [activity("coder-1", "RUN-3", 3, "started"), initial[1]]);
    await assertPanels(page, ["coder-1", "coder-2"]);
    await close().click();
    await assertPanels(page, ["coder-2"]);
    await assertOtherRetained(page);
  } else if (index === 12) {
    await page.getByRole("button", { name: "Close agent panel coder-1 in project PROJECT-BROWSER", exact: true }).click();
    await assertPanels(page, ["coder-2"]);
    for (const [step, status] of [[2, "working"], [3, "ready"], [4, "working"]]) {
      await update(page, [initial[0], activity("coder-1", "RUN-1", step, "tool_started", status), initial[1]]);
      await assertPanels(page, ["coder-2"]);
      await assertOtherRetained(page);
    }
    await update(page, [initial[0], initial[1]], "error");
    await assertPanels(page, ["coder-2"]);
    await update(page, [initial[0], activity("coder-1", "RUN-1", 5, "tool_started"), initial[1]], "connected");
    await assertPanels(page, ["coder-2"]);
    await update(page, [activity("coder-1", "RUN-3", 6, "started"), initial[1]]);
    await assertPanels(page, ["coder-1", "coder-2"]);
    await assertOtherRetained(page);
    assert.ok((await page.locator(panel("coder-1")).textContent()).includes("PROJECT-BROWSER-coder-1-action-6"));
  } else throw new Error("No Coding lifecycle scenario implements this assertion.");
}
