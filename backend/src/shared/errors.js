export class ForgeError extends Error {
  constructor(message, { cause, code = "FORGE_ERROR", details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
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
