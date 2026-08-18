import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import picomatch from "picomatch";

import { ConfigurationError } from "../../shared/errors.js";
import { createNodeEventValidator } from "../watcher/debounced-watcher.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const permissionSchema = require("../../../schemas/project/permission.schema.json");
const ROLES = new Set(["node", "builder", "reviewer", "planner", "tester", "human", "custom"]);
const ACCESS_TYPES = new Set(["read", "write", "create", "delete", "rename", "execute"]);

export function createPermissionEvaluator({ permissions, projectId, internalBus, clock = () => new Date(), createEventId = () => `EVT-${randomUUID()}`, validateEvent = createNodeEventValidator() } = {}) {
  if (!Array.isArray(permissions) || typeof projectId !== "string" || projectId.length === 0 || !internalBus?.emit) {
    throw new ConfigurationError("Permissions, project_id, and an internal bus are required for permission evaluation.");
  }
  if (typeof clock !== "function" || typeof createEventId !== "function" || typeof validateEvent !== "function") {
    throw new ConfigurationError("Permission evaluator dependencies must be functions.");
  }
  const validatePermission = createPermissionValidator();
  const orderedPermissions = permissions.map((permission, order) => {
    validatePermission(permission);
    return Object.freeze({ ...permission, priority: permission.priority ?? 100, enabled: permission.enabled ?? true, order });
  }).sort((left, right) => right.priority - left.priority || left.order - right.order);

  function evaluate({ role, path, access } = {}) {
    validateAction({ role, path, access });
    const permission = orderedPermissions.find((entry) => entry.enabled
      && (entry.project_id === undefined || entry.project_id === projectId)
      && entry.role === role
      && entry.access.includes(access)
      && picomatch.isMatch(path, entry.path, { dot: true }));
    if (!permission) return Object.freeze({ allowed: false, reason: "no_matching_permission" });
    return Object.freeze({
      allowed: permission.effect === "allow",
      permission_id: permission.id,
      reason: permission.reason ?? (permission.effect === "allow" ? "allowed" : "denied_by_permission")
    });
  }

  async function execute(action, actionFn) {
    if (typeof actionFn !== "function") throw new ConfigurationError("A permission-protected action must be a function.");
    const decision = evaluate(action);
    if (!decision.allowed) {
      emitDenied(action, decision);
      return Object.freeze({ ...decision, executed: false });
    }
    const result = await actionFn();
    return Object.freeze({ ...decision, executed: true, result });
  }

  function emitDenied(action, decision) {
    const event = {
      event_id: createEventId(),
      type: "rules.permission_denied",
      project_id: projectId,
      timestamp: clock().toISOString(),
      payload: {
        role: action.role,
        path: action.path,
        access: action.access,
        reason: decision.reason,
        ...(decision.permission_id ? { permission_id: decision.permission_id } : {})
      }
    };
    validateEvent(event);
    internalBus.emit("event", Object.freeze(event));
  }

  return Object.freeze({ evaluate, execute });
}

export function createPermissionValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(permissionSchema);
  const validate = ajv.getSchema(permissionSchema.$id);
  return (permission) => {
    if (!validate(permission)) {
      throw new ConfigurationError(`Invalid permission: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

function validateAction({ role, path, access }) {
  if (!ROLES.has(role) || typeof path !== "string" || path.length === 0 || !ACCESS_TYPES.has(access)) {
    throw new ConfigurationError("Permission action requires a valid role, project-relative path, and access type.");
  }
}
