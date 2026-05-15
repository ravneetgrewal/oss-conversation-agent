import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadEnvFile(filePath = ".env") {
  const resolvedPath = path.resolve(filePath);
  let raw;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = parseEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (!key || Object.hasOwn(process.env, key)) continue;
    process.env[key] = value;
  }

  return true;
}

function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
