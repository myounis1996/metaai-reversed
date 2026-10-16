// Attachment upload over rupload — Meta's resumable upload service. The web
// client first GETs the session URL to learn the resume offset; for a fresh
// session that is always 0, so a single POST of the whole body is enough. The
// answer is {"media_id": "<fbid>"}, which the chat Request then references as
// Attachment.id.fbid (see buildRequest in src/proto/ecto.js).

const fs = require("fs");
const path = require("path");
const {randomUUID} = require("crypto");
const {buildBrowserHeaders} = require("./browser");

const UPLOAD_ENDPOINT = "https://rupload.meta.ai/gen_ai_document_gen_ai_tenant";
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  return null;
}

// Accepts a path, a Buffer, or {path | bytes, name?, mime?}; with no name, the
// MIME type is sniffed from the bytes.
function readAttachmentInput(input) {
  let bytes;
  let name;
  let mime;
  if (typeof input === "string") {
    bytes = fs.readFileSync(input);
    name = path.basename(input);
  } else if (Buffer.isBuffer(input)) {
    bytes = input;
  } else if (input && typeof input === "object") {
    bytes = input.bytes ? Buffer.from(input.bytes) : input.path ? fs.readFileSync(input.path) : null;
    name = input.name || (input.path && path.basename(input.path));
    mime = input.mime;
  }
  if (!bytes || bytes.length === 0) {
    throw new Error("attachment must be a file path, a non-empty Buffer, or {path | bytes, name?, mime?}");
  }
  mime = mime || sniffMime(bytes) || MIME_BY_EXT[path.extname(name || "").toLowerCase()] || "application/octet-stream";
  if (!name) name = `upload${Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext] === mime) || ""}`;
  return {bytes, name, mime};
}

async function uploadAttachment(input, {accessToken}) {
  const {bytes, name, mime} = readAttachmentInput(input);
  const response = await fetch(`${UPLOAD_ENDPOINT}/${randomUUID()}`, {
    method: "POST",
    headers: {
      ...buildBrowserHeaders({accept: "*/*"}),
      "sec-fetch-site": "same-site",
      authorization: `OAuth ${accessToken}`,
      desired_upload_handler: "genai_document",
      ecto_auth_token: "true",
      is_abra_user: "true",
      offset: "0",
      "x-entity-length": String(bytes.length),
      "x-entity-name": encodeURIComponent(name),
      "x-entity-type": mime,
    },
    body: bytes,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!response.ok || !json || !json.media_id) {
    throw new Error(`attachment upload failed: ${response.status} — ${text.slice(0, 200)}`);
  }
  return {
    mediaId: String(json.media_id),
    kind: mime.startsWith("image/") ? "image" : "file",
    mimeType: mime,
    filename: name,
    size: bytes.length,
  };
}

module.exports = {uploadAttachment, readAttachmentInput};
