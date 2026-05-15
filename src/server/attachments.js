import { readFile } from "node:fs/promises";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif"
]);

const FILE_INPUT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tsv",
  "application/csv",
  "application/json",
  "application/javascript",
  "application/typescript",
  "text/javascript",
  "text/html",
  "text/css",
  "text/xml",
  "application/xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel"
]);

export function isImageInput(file) {
  return IMAGE_MIME_TYPES.has(normalizeMime(file.mimeType));
}

export function isFileInput(file) {
  return FILE_INPUT_MIME_TYPES.has(normalizeMime(file.mimeType)) || Boolean(file.textPreview);
}

export async function fileToBase64(file) {
  if (!file.storagePath) return "";
  const bytes = await readFile(file.storagePath);
  return bytes.toString("base64");
}

export async function fileToDataUrl(file) {
  const base64 = await fileToBase64(file);
  return base64 ? `data:${normalizeMime(file.mimeType)};base64,${base64}` : "";
}

export function normalizeMime(mimeType) {
  return String(mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
}
