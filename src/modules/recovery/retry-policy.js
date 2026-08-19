import { ConfigurationError } from "../../shared/errors.js";

export function createRetryPolicy({ maxAttempts = 3 } = {}) {
  validateAttempts(maxAttempts);

  return Object.freeze({ execute });

  async function execute(operation, options = {}) {
    if (typeof operation !== "function") throw new ConfigurationError("Retry operation must be a function.");
    const attempts = options.maxAttempts ?? maxAttempts;
    validateAttempts(attempts);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation({ attempt, maxAttempts: attempts });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

export async function execute(operation, options) {
  return createRetryPolicy(options).execute(operation, options);
}

function validateAttempts(value) {
  if (!Number.isInteger(value) || value < 1) throw new ConfigurationError("Retry maxAttempts must be a positive integer.");
}
