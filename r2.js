// r2.js — PUBLIC, NON-EXPIRING URLs ONLY (no presigned GET links)
"use strict";

import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// =======================
// Env
// =======================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";

// Optional override, otherwise computed from account id
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

// This should be your permanent public domain for assets, e.g. https://assets.faltastudio.com
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// =======================
// Client
// =======================
const r2 =
  R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

function assertR2Configured() {
  if (!r2) throw new Error("R2 is not configured (missing R2_ENDPOINT / credentials).");
  if (!R2_BUCKET) throw new Error("R2_BUCKET is missing.");
}

function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function safeName(name = "file") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function guessExtFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "";
}

function encodeKeyForUrl(key) {
  return String(key || "")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

// ✅ Permanent public URL (no signatures, no expiry)
export function publicUrlForKey(key) {
  if (!key) return "";

  // Preferred: your custom domain (Cloudflare proxied or R2 custom domain)
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;

  // Fallback ONLY works if you have configured a public bucket/domain on Cloudflare.
  // If this fallback is not public, the browser will get 403.
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }

  return "";
}

export function isOurAssetUrl(u) {
  try {
    const url = new URL(String(u));
    const host = url.hostname.toLowerCase();

    if (R2_PUBLIC_BASE_URL) {
      const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
      if (host === baseHost) return true;
    }

    if (host.endsWith("r2.cloudflarestorage.com")) return true;
    return false;
  } catch {
    return false;
  }
}

export function makeKey({ kind = "uploads", customerId = "anon", filename = "", contentType = "" } = {}) {
  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const base = safeName(filename || "upload");

  const extGuess = guessExtFromContentType(contentType);
  const ext =
    extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : "";

  return `${folder}/${cid}/${Date.now()}-${uuid}-${base}${ext}`;
}

export async function putBufferToR2({ key, buffer, contentType } = {}) {
  assertR2Configured();
  if (!key) throw new Error("putBufferToR2: key is required.");
  if (!buffer) throw new Error("putBufferToR2: buffer is required.");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: "inline",
    })
  );

  const publicUrl = publicUrlForKey(key);
  if (!publicUrl) {
    throw new Error(
      "Public URL could not be built. Set R2_PUBLIC_BASE_URL to a permanent public domain."
    );
  }

  return { key, publicUrl, url: publicUrl };
}

export async function storeRemoteImageToR2({ url, kind = "generations", customerId = "anon" } = {}) {
  if (!url) throw new Error("storeRemoteImageToR2: url is required.");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const key = makeKey({
    kind,
    customerId,
    filename: "remote",
    contentType,
  });

  return putBufferToR2({ key, buffer: buf, contentType });
}

// Backwards-compat shim: if any older code calls a "sign get" helper,
// we still return a permanent public URL (NO expiry).
export async function r2PutAndSignGet({ key, buffer, contentType } = {}) {
  const stored = await putBufferToR2({ key, buffer, contentType });
  return {
    key: stored.key,
    // historically "getUrl" was signed/expiring; now it's permanent.
    getUrl: stored.publicUrl,
    publicUrl: stored.publicUrl,
    url: stored.publicUrl,
  };
}

// dataURL parsing used by server.js
export function parseDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid dataUrl format (expected data:<mime>;base64,...)");

  const contentType = m[1] || "application/octet-stream";
  const b64 = m[2] || "";
  const buffer = Buffer.from(b64, "base64");
  const ext = guessExtFromContentType(contentType);

  return { buffer, contentType, ext };
}
