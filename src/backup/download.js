// Thin DOM helpers for backup files. Nothing else lives here.

import { MAX_IMPORT_BYTES } from "./backup.js";

// Starts a browser download of `blob`. The object URL is released after a
// delay because some browsers cancel the download if it is revoked at once.
export function downloadBlob(
  blob,
  filename,
  { document = globalThis.document, URL = globalThis.URL, revokeAfterMs = 10000 } = {},
) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

// Reads a chosen File as text. UNIT: maxBytes is in bytes, compared with
// file.size, which is the same unit importFromText uses (both default to
// MAX_IMPORT_BYTES). A file over the limit is refused before it is read.
export async function readFileAsText(file, maxBytes = MAX_IMPORT_BYTES) {
  if (file.size > maxBytes) {
    throw new Error(`The file is too large to import (limit: ${maxBytes} bytes)`);
  }
  return file.text();
}
