// Summary: Defines canonical application errors so HTTP, streams, clients, and UI share one failure contract.
export class ForgeError extends Error {
  constructor(message, { cause, code = "FORGE_ERROR", details, retryable = false, scope = "application", requestId = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.scope = scope;
    this.requestId = requestId;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      scope: this.scope,
      requestId: this.requestId
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
