// Hero Part 1: Simple file upload gateway using Cloudflare R2 presigned URLs
// Part 1.1: Express server that only handles CORS + presign endpoints for the front-end.
// Part 1.1.1: Comments mark the flow from request validation to signed URL creation.
// mina-editorial-ai/server/index.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();

const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / curl (no Origin header)
    if (!origin) return cb(null, true);

    // if no allowlist configured, block (safer than accidentally allowing everyone)
    if (allowlist.length === 0) return cb(new Error("CORS not configured"), false);

    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "2mb" }));

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
  PORT,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.warn(
    "[R2] Missing env vars. Need: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"
  );
}

// Cloudflare R2 S3 endpoint + region auto (per Cloudflare docs) 
const S3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function extFromContentType(contentType = "") {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("mp4")) return ".mp4";
  return "";
}

function makeKey({ kind, contentType }) {
  // kind examples: "product", "logo", "inspo", "style", "generation"
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  const id = crypto.randomUUID();
  const ext = extFromContentType(contentType);

  return `${kind}/${yyyy}/${mm}/${dd}/${id}${ext}`;
}

function makePublicUrl(key) {
  // Recommended: set R2_PUBLIC_BASE_URL to your r2.dev or custom domain base
  // Cloudflare public buckets doc explains r2.dev/custom domain 
  if (!R2_PUBLIC_BASE_URL) return null;
  return `${R2_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
}

// Health
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/r2/presign
 * body: { kind: "product"|"logo"|"inspo"|"style"|"generation", contentType: "image/png" }
 * returns: { key, putUrl, getUrl, publicUrl }
 *
 * Cloudflare’s presigned URL examples show PutObject/GetObject with region:auto and endpoint. 
 */
app.post("/api/r2/presign", async (req, res) => {
  try {
    const { kind, contentType } = req.body || {};

    if (!kind || !contentType) {
      return res.status(400).json({ error: "kind and contentType are required" });
    }

    const key = makeKey({ kind, contentType });

    // PUT (upload)
    const putUrl = await getSignedUrl(
      S3,
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 60 * 10 } // 10 minutes
    );

    // GET (download) — useful even if you don't make the bucket public
    const getUrl = await getSignedUrl(
      S3,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
      { expiresIn: 60 * 60 } // 1 hour
    );

    const publicUrl = makePublicUrl(key);

    res.json({ key, putUrl, getUrl, publicUrl });
  } catch (err) {
    console.error("[/api/r2/presign] error:", err);
    res.status(500).json({ error: "Failed to presign" });
  }
});

// Serve Vite build (dist) in production
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "..", "dist");

app.use(express.static(distDir));
app.get("*", (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(Number(PORT) || 3000, () => {
  console.log(`Server listening on ${Number(PORT) || 3000}`);
});
