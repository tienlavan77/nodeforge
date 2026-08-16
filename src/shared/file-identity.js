import { randomUUID } from "node:crypto";

import { FileIdentityError } from "./errors.js";

function assertPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new FileIdentityError("A non-empty file path is required.");
  }
}

export function createFileId() {
  return `FILE-${randomUUID()}`;
}

export class FileIdentityRegistry {
  #idsByPath = new Map();
  #createId;

  constructor({ createId = createFileId } = {}) {
    this.#createId = createId;
  }

  get(path) {
    assertPath(path);
    return this.#idsByPath.get(path);
  }

  getOrCreate(path) {
    assertPath(path);
    const existing = this.#idsByPath.get(path);
    if (existing) return existing;

    const fileId = this.#createId();
    this.#idsByPath.set(path, fileId);
    return fileId;
  }

  rename(fromPath, toPath) {
    assertPath(fromPath);
    assertPath(toPath);

    const fileId = this.#idsByPath.get(fromPath);
    if (!fileId) {
      throw new FileIdentityError(`No file identity exists for ${fromPath}.`);
    }
    if (this.#idsByPath.has(toPath)) {
      throw new FileIdentityError(`A file identity already exists for ${toPath}.`);
    }

    this.#idsByPath.delete(fromPath);
    this.#idsByPath.set(toPath, fileId);
    return fileId;
  }

  remove(path) {
    assertPath(path);
    return this.#idsByPath.delete(path);
  }
}
