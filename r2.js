import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "node:crypto";

function required(name) {
const v = process.env[name];
if (!v) throw new Error(`Missing env var: ${name}`);
return v;
}

const accountId = required("R2_ACCOUNT_ID");
const bucket = required("R2_BUCKET");

const client = new S3Client({
region: "auto",
endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
credentials: {
accessKeyId: required("R2_ACCESS_KEY_ID"),
secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
},
});

/**

* Convert dataURL -> { buffer, contentType, ext }
  */
  export function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Invalid dataUrl (expected data:<mime>;base64,...)");
  const contentType = m[1];
  const b64 = m[2];
  const buffer = Buffer.from(b64, "base64");

// small, safe extension mapping
const ext =
contentType === "image/png"
? "png"
: contentType === "image/jpeg"
? "jpg"
: contentType === "image/webp"
? "webp"
: contentType === "image/gif"
? "gif"
: "bin";

return { buffer, contentType, ext };
}

export function makeKey({ kind = "uploads", ext = "png" } = {}) {
const id = crypto.randomUUID();
return `${kind}/${id}.${ext}`;
}

export async function putBufferToR2({ key, buffer, contentType }) {
await client.send(
new PutObjectCommand({
Bucket: bucket,
Key: key,
Body: buffer,
ContentType: contentType,
}),
);
return key;
}

/**

* Public URL for your app to use in <img src="...">
* You MUST set R2_PUBLIC_BASE_URL in Render.
  */
  export function publicUrlForKey(key) {
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (!base) {
  throw new Error(
  "Missing env var: R2_PUBLIC_BASE_URL (example: [https://pub-xxxx.r2.dev](https://pub-xxxx.r2.dev))",
  );
  }
  return `${base.replace(/\/+$/, "")}/${key}`;
  }

/**

* Store a remote image URL (ex: Replicate output) into R2.
  */
  export async function storeRemoteImageToR2({ url, kind = "generations" }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download remote image: ${res.status}`);

const contentType = res.headers.get("content-type") || "application/octet-stream";
const arrayBuffer = await res.arrayBuffer();
const buffer = Buffer.from(arrayBuffer);

const ext =
contentType.includes("png")
? "png"
: contentType.includes("jpeg")
? "jpg"
: contentType.includes("webp")
? "webp"
: "bin";

const key = makeKey({ kind, ext });
await putBufferToR2({ key, buffer, contentType });
return { key, url: publicUrlForKey(key), contentType, bytes: buffer.length };
}
