import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync(new URL("../registry/index.json", import.meta.url), "utf8"));
if (registry.schemaVersion !== 1 || !Array.isArray(registry.extensions)) {
  throw new Error("registry/index.json must use schemaVersion 1 and contain an extensions array");
}

const ids = new Set();
for (const extension of registry.extensions) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(extension.id)) throw new Error(`Invalid extension id: ${extension.id}`);
  if (ids.has(extension.id)) throw new Error(`Duplicate extension id: ${extension.id}`);
  ids.add(extension.id);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(extension.version)) throw new Error(`Invalid semantic version: ${extension.id}`);
  if (!["wasi", "external-mcp"].includes(extension.runtime)) throw new Error(`Invalid runtime: ${extension.id}`);
  if (!String(extension.downloadUrl).startsWith("https://")) throw new Error(`Download URL must use HTTPS: ${extension.id}`);
  if (!/^[0-9a-f]{64}$/i.test(extension.sha256)) throw new Error(`Invalid SHA-256: ${extension.id}`);
  if (!Number.isInteger(extension.size) || extension.size <= 0 || extension.size > 25 * 1024 * 1024) throw new Error(`Invalid package size: ${extension.id}`);
  if (!Array.isArray(extension.permissions) || extension.permissions.some(permission => !/^[A-Za-z0-9_.:*-]{1,80}$/.test(permission))) {
    throw new Error(`Invalid permissions: ${extension.id}`);
  }
}

console.log(`Validated ${registry.extensions.length} registry extensions`);
