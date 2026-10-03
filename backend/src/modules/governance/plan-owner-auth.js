// Verifies a project owner's plan decision against a server-held credential.
import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Returns a stable authorization failure without exposing credential material.
function deny(code, statusCode) { return Object.assign(new ConfigurationError("Plan owner authorization is required."), { code, statusCode }); }

// Binds approval identity to a server-side owner and compares tokens in constant time.
export function createPlanOwnerAuth({ token, ownerId } = {}) {
  return Object.freeze({
    verify(headers = {}) {
      if (!token || !ownerId) throw deny("PLAN_OWNER_AUTH_UNCONFIGURED", 503);
      const value = headers.authorization ?? headers.Authorization;
      const supplied = typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
      const expectedHash = createHash("sha256").update(token).digest();
      const suppliedHash = createHash("sha256").update(supplied).digest();
      if (!supplied || !timingSafeEqual(expectedHash, suppliedHash)) throw deny("PLAN_OWNER_UNAUTHORIZED", 403);
      return ownerId;
    }
  });
}
