// Checks the approved Coding panel and Sprint callback behaviors against real browser DOM elements.
import assert from "node:assert/strict";
import { verifyCodingLifecycleAssertion } from "./browser-coding-lifecycle-scenarios.js";

const panels = ".coding-agent-monitor";
const ids = ["leader", "coder-1", "coder-2", "reviewer"];

// Builds a controlled existing-contract event with explicit project and agent identities.
function event(agentId, status = "working", projectId = "PROJECT-BROWSER", step = 1) {
  return { project_id: projectId, event_type: "agent.activity", event_id: `${agentId}-${step}`, timestamp: String(step), payload: { agent_id: agentId, status, summary: `${agentId}-action-${step}` } };
}

// Delivers events through the real registry and React component instead of reconstructing mock DOM.
async function update(page, input) {
  await page.evaluate((value) => window.browserFixture.update(value), input);
}

// Retains a browser element reference so reconciliation tests prove actual DOM continuity.
async function retain(page) {
  await page.evaluate(() => { window.retainedPanel = document.querySelector('[data-agent-id="coder-1"]'); });
}

// Checks that the original unclosed panel is still the same live element after event changes.
async function assertRetained(page) {
  assert.equal(await page.evaluate(() => window.retainedPanel === document.querySelector('[data-agent-id="coder-1"]') && window.retainedPanel.isConnected), true);
}

// Executes one exact approved assertion, failing on missing panels, misleading identities or callback drift.
export async function verifyCodingAssertion(index, page) {
  await page.evaluate(() => window.browserFixture.reset());
  if (index >= 10 && index <= 12) return verifyCodingLifecycleAssertion(index, page);
  if ([0, 1, 2].includes(index)) {
    await update(page, { events: ids.map((id) => event(id)) });
    assert.equal(await page.locator(panels).count(), 4);
    const profiles = await page.evaluate(() => window.browserFixture.profiles);
    for (const profile of profiles) {
      const panel = page.locator(`[data-agent-id="${profile.agent_id}"]`);
      assert.equal(await panel.getAttribute("data-project-id"), "PROJECT-BROWSER");
      assert.equal(await panel.locator("header strong").textContent(), profile.agent_name);
      assert.equal(await panel.locator("header span").textContent(), profile.role.replaceAll("_", " "));
      if (index === 2) {
        await update(page, { events: [...ids.map((id) => event(id)), event(profile.agent_id, "working", "FOREIGN", 2)] });
        const text = await panel.textContent();
        assert.ok(text.includes(`${profile.agent_id}-action-1`));
        assert.ok(!text.includes(`${profile.agent_id}-action-2`));
        for (const otherId of ids.filter((id) => id !== profile.agent_id)) assert.ok(!text.includes(`${otherId}-action-1`));
      }
    }
  } else if (index === 3) {
    await update(page, { events: [event("coder-1")], directory: [] });
    assert.equal(await page.locator(panels).count(), 0);
    const directory = await page.evaluate(() => window.browserFixture.profiles);
    await update(page, { directory });
    assert.equal(await page.locator(panels).count(), 1);
    assert.equal(await page.locator(panels).getAttribute("data-agent-id"), "coder-1");
  } else if ([4, 5, 6, 8].includes(index)) {
    await update(page, { events: [event("coder-1")] });
    await retain(page);
    if (index === 4) {
      await update(page, { events: [event("coder-1"), event("coder-1"), event("coder-1", "working", "PROJECT-BROWSER", 2)], source: "connected" });
    } else if (index === 5) {
      for (const status of ["ready", "working", "success", "failed", "ready"]) {
        await update(page, { events: [event("coder-1", status)] });
        await assertRetained(page);
      }
      await update(page, { events: Array.from({ length: 60 }, (_, step) => event("reviewer", "working", "PROJECT-BROWSER", step)).slice(-50) });
      assert.equal(await page.locator('[data-agent-id="reviewer"] > div').count(), 50);
      assert.ok(!(await page.locator('[data-agent-id="coder-1"]').textContent()).includes("coder-1-action-1"));
    } else if (index === 6) {
      const directory = await page.evaluate(() => window.browserFixture.profiles.map((profile) => ({ ...profile, agent_name: "Renamed", role: "reviewer" })));
      await update(page, { directory, events: [{ ...event("coder-1"), event_id: "changed-event", timestamp: "changed-time" }] });
      assert.equal(await page.locator('[data-agent-id="coder-1"] header strong').textContent(), "Renamed");
    } else {
      await update(page, { source: "error" });
      assert.match(await page.locator('[data-agent-id="coder-1"]').textContent(), /Activity: disconnected/);
      await update(page, { source: "connected", events: [] });
      assert.match(await page.locator('[data-agent-id="coder-1"]').textContent(), /Activity: unknown/);
      assert.match(await page.locator('[data-agent-id="coder-1"]').textContent(), /Profile: ready/);
    }
    await assertRetained(page);
    assert.equal(await page.locator('[data-agent-id="coder-1"]').count(), 1);
  } else if (index === 7) {
    const ambiguous = await page.evaluate(() => [window.browserFixture.profiles[1], window.browserFixture.profiles[1]]);
    await update(page, { directory: ambiguous, events: [event("coder-1")] });
    assert.equal(await page.locator(panels).count(), 0);
    const directory = await page.evaluate(() => window.browserFixture.profiles);
    await page.evaluate(() => window.browserFixture.reset());
    await update(page, { directory, events: [{ ...event("coder-1"), project_id: undefined }, event("bad identity"), event(undefined), event("coder-1", "working", "FOREIGN"), { ...event("coder-1"), agent_id: "coder-2" }] });
    assert.equal(await page.locator(panels).count(), 0);
  } else if (index === 9) {
    await verifySprintControls(page);
  } else throw new Error("No browser scenario implements this assertion.");
}

// Verifies visible Sprint controls call the existing client contract without real backend side effects.
async function verifySprintControls(page) {
  const sprint = page.locator(".sprint-item");
  assert.ok((await sprint.textContent()).includes("Preserve Sprint controls"));
  await sprint.getByRole("button", { name: "Toggle sprint tasks" }).click();
  await page.locator(".dashboard-ticket").waitFor();
  const ticket = page.locator(".dashboard-ticket");
  await ticket.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await ticket.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForFunction(() => window.browserFixture.calls.some((call) => call.name === "runTicket"));
  page.once("dialog", (dialog) => dialog.accept());
  await ticket.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForFunction(() => window.browserFixture.calls.some((call) => call.name === "ticketDeleted"));
  await sprint.locator(".sprint-actions").getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await sprint.locator(".sprint-actions").getByRole("button", { name: "Run", exact: true }).click();
  await page.evaluate(() => window.browserFixture.emit({ event_type: "ticket.status_changed", payload: { ticket_id: "TICKET-BROWSER", status: "done" } }));
  await page.waitForFunction(() => window.browserFixture.calls.some((call) => call.name === "refresh"));
  page.once("dialog", (dialog) => dialog.accept());
  await sprint.locator(".sprint-actions").getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForFunction(() => window.browserFixture.calls.some((call) => call.name === "sprintDeleted"));
  const calls = await page.evaluate(() => window.browserFixture.calls);
  for (const name of ["getTicket", "deleteTicket"]) assert.deepEqual(calls.find((call) => call.name === name).args, ["PROJECT-BROWSER", "TICKET-BROWSER"]);
  assert.deepEqual(calls.find((call) => call.name === "runTicket").args, ["PROJECT-BROWSER", "TICKET-BROWSER", { fresh: false }]);
  assert.deepEqual(calls.find((call) => call.name === "ticketDeleted").args, ["TICKET-BROWSER", { sprint_id: "SPRINT-BROWSER" }]);
  for (const name of ["getSprintPlan", "runSprintPlan"]) assert.deepEqual(calls.find((call) => call.name === name).args, ["PROJECT-BROWSER", "SPRINT-BROWSER"]);
  assert.deepEqual(calls.find((call) => call.name === "deleteSprintPlan").args, ["PROJECT-BROWSER", "SPRINT-BROWSER", 7]);
  assert.deepEqual(calls.find((call) => call.name === "sprintDeleted").args, ["SPRINT-BROWSER"]);
}
