// Summary: Defines canonical application errors so HTTP, streams, clients, and UI share one failure contract.
export class ForgeError extends Error {
  constructor(message, { cause, code = "FORGE_ERROR", retryable = false, scope = "application", requestId = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.scope = scope;
    this.requestId = requestId;
  }

  toJSON() {
    return {
      code: typeof this.code === "string" && this.code ? this.code : "FORGE_ERROR",
      message: typeof this.message === "string" && this.message ? this.message : "An unexpected error occurred",
      retryable: Boolean(this.retryable),
      scope: typeof this.scope === "string" && this.scope ? this.scope : "application",
      requestId: typeof this.requestId === "string" && this.requestId ? this.requestId : null
    };
  }
}

export class ConfigurationError extends ForgeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "CONFIGURATION_ERROR" });
  }
}

export class FileIdentityError extends ForgeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "FILE_IDENTITY_ERROR" });
  }
}

export class LifecycleError extends ForgeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "LIFECYCLE_ERROR" });
  }
}
