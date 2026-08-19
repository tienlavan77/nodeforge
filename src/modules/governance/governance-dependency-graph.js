import { ConfigurationError } from "../../shared/errors.js";

const NODE_TYPES = new Set(["roadmap", "sprint", "ticket", "commit"]);

export function createGovernanceDependencyGraph() {
  const nodes = new Map();
  const dependencies = new Map();
  const dependents = new Map();

  return Object.freeze({ addNode, addDependency, getDependencies, getDependents, getExecutionOrder });

  function addNode(node) {
    if (!node || typeof node.id !== "string" || node.id.length === 0 || !NODE_TYPES.has(node.type)) {
      throw new ConfigurationError("Governance node requires an id and a supported type.");
    }
    if (nodes.has(node.id)) throw new ConfigurationError(`Governance node already exists: ${node.id}.`);
    nodes.set(node.id, Object.freeze({ ...node }));
    dependencies.set(node.id, new Set());
    dependents.set(node.id, new Set());
    return { ...nodes.get(node.id) };
  }

  function addDependency(nodeId, dependencyId) {
    assertNode(nodeId);
    assertNode(dependencyId);
    if (nodeId === dependencyId || createsCycle(nodeId, dependencyId)) {
      throw new ConfigurationError(`Governance dependency creates a cycle: ${nodeId} -> ${dependencyId}.`);
    }
    dependencies.get(nodeId).add(dependencyId);
    dependents.get(dependencyId).add(nodeId);
  }

  function getDependencies(nodeId) {
    assertNode(nodeId);
    return [...dependencies.get(nodeId)].map(cloneNode);
  }

  function getDependents(nodeId) {
    assertNode(nodeId);
    return [...dependents.get(nodeId)].map(cloneNode);
  }

  function getExecutionOrder() {
    const remaining = new Map([...dependencies.entries()].map(([id, ids]) => [id, new Set(ids)]));
    const order = [];
    while (remaining.size > 0) {
      const ready = [...remaining.entries()].filter(([, ids]) => ids.size === 0).map(([id]) => id);
      if (ready.length === 0) throw new ConfigurationError("Governance dependency graph contains a cycle.");
      for (const id of ready) {
        order.push(cloneNode(id));
        remaining.delete(id);
        for (const ids of remaining.values()) ids.delete(id);
      }
    }
    return order;
  }

  function createsCycle(nodeId, dependencyId) {
    const visited = new Set();
    const pending = [dependencyId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === nodeId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...dependencies.get(current));
    }
    return false;
  }

  function assertNode(id) {
    if (typeof id !== "string" || !nodes.has(id)) throw new ConfigurationError(`Unknown governance node: ${id}.`);
  }

  function cloneNode(id) {
    return { ...nodes.get(id) };
  }
}
