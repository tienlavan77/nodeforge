import { extname } from "node:path";

import { emptyExtraction, normalizeExtraction } from "./contract.js";
import { extractJavaScript } from "./javascript.js";
import { extractPhp } from "./php.js";

export function createExtractorRegistry() {
  const extractors = new Map();

  return Object.freeze({
    register(extensions, extractor) {
      if (!Array.isArray(extensions) || extensions.length === 0 || typeof extractor !== "function") {
        throw new TypeError("An extractor requires one or more extensions and an extract function.");
      }
      for (const extension of extensions) extractors.set(normalizeExtension(extension), extractor);
      return this;
    },
    extract(filePath, source) {
      const extension = extname(filePath);
      if (!extension) return emptyExtraction();
      const extractor = extractors.get(normalizeExtension(extension));
      return extractor ? normalizeExtraction(extractor(source, filePath)) : emptyExtraction();
    },
    supports(filePath) {
      const extension = extname(filePath);
      return Boolean(extension) && extractors.has(normalizeExtension(extension));
    }
  });
}

export const extractorRegistry = createExtractorRegistry();
extractorRegistry.register([".js", ".ts", ".jsx", ".tsx"], extractJavaScript);
extractorRegistry.register([".php"], extractPhp);

function normalizeExtension(extension) {
  if (typeof extension !== "string" || extension.length === 0) {
    throw new TypeError("An extractor extension must be a non-empty string.");
  }
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}
