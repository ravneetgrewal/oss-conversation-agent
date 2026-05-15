import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addFile } from "./store.js";

const UPLOAD_DIR = path.resolve("uploads");
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/javascript",
  "application/typescript"
]);

export async function saveUploadedFile({ filename, mimeType, bytes }) {
  if (!filename) throw new Error("Missing filename");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("File exceeds 20 MB limit");

  await mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const storageName = `${randomUUID()}-${safeName}`;
  const storagePath = path.join(UPLOAD_DIR, storageName);
  await writeFile(storagePath, bytes);

  const textPreview = await createTextPreview({ storagePath, mimeType, filename });
  return addFile({
    filename: safeName,
    mimeType: mimeType || "application/octet-stream",
    size: bytes.byteLength,
    storagePath,
    textPreview
  });
}

async function createTextPreview({ storagePath, mimeType, filename }) {
  const extension = path.extname(filename).toLowerCase();
  const isTextLike = TEXT_TYPES.has(mimeType) || [".txt", ".md", ".csv", ".json", ".js", ".ts", ".tsx", ".jsx", ".css", ".html", ".py"].includes(extension);
  if (!isTextLike) return "";
  const raw = await readFile(storagePath, "utf8");
  return raw.slice(0, 12000);
}
