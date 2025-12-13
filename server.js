//server.js
// =======================
// PART 1 – Imports & setup
// =======================
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { parseDataUrl, makeKey, putBufferToR2, publicUrlForKey, storeRemoteImageToR2 } from "./r2.js";
import multer from "multer";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
const PORT = process.env.PORT || 3000;
const MINA_BASELINE_USERS = 3651; // offset we add on top of DB users

// NOTE: We removed TypeScript interfaces here to keep this file pure JS.
// ============================
// R2 setup (Cloudflare R2 = S3 compatible)
// ============================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

// Optional override, otherwise computed from account id
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function safeName(name = "file") {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function r2PutAndSignGet({ key, body, contentType }) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );

  // Signed GET URL (works even if bucket is private)
  const signedUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: 60 * 60 * 24 * 7 } // 7 days
  );

  return signedUrl;
}

// Admin auth helper
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function ensureAdmin(req, res) {
  if (!ADMIN_SECRET) {
    console.warn("ADMIN_SECRET is not set; denying admin access");
    res.status(503).json({ error: "Admin API not configured" });
    return false;
  }

  const header = req.header("x-admin-secret");
  if (!header || header !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));


// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Models
const SEADREAM_MODEL =
  process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL =
  process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// =======================
// PART 2 – Style presets
// =======================

const STYLE_PRESETS = {
  "soft-desert-editorial": {
    name: "Soft Desert Editorial",
    profile: {
      keywords: [
        "warm-sand-tones",
        "soft-shadows",
        "minimal-backdrop",
        "hazy-light",
        "tactile-textures",
      ],
      description:
        "Soft beige and sand-inspired tones, minimal props, hazy sunlight and gentle shadows. Feels calm, warm and tactile, like a quiet desert morning.",
    },
    heroImageUrls: ["https://cdn.example.com/mina/styles/soft-desert-1.jpg"],
  },
  "chrome-neon-night": {
    name: "Chrome Neon Night",
    profile: {
      keywords: [
        "neon-rim-light",
        "high-contrast",
        "dark-background",
        "chrome-reflections",
        "futuristic",
      ],
      description:
        "Dark environments with strong neon rim lights and chrome reflections. High contrast, sharp edges and a futuristic, night-city atmosphere.",
    },
    heroImageUrls: ["https://cdn.example.com/mina/styles/chrome-neon-1.jpg"],
  },
  "bathroom-ritual": {
    name: "Bathroom Ritual",
    profile: {
      keywords: [
        "marble-surfaces",
        "soft-bathroom-light",
        "steam-mist",
        "care-ritual",
        "intimate-closeups",
      ],
      description:
        "Clean marble surfaces, soft bathroom lighting, hints of steam and water. Intimate close-ups that feel like a self-care ritual moment.",
    },
    heroImageUrls: [
      "https://cdn.example.com/mina/styles/bathroom-ritual-1.jpg",
    ],
  },
  // Add more presets later.
};

// =======================
// PART 3 – In-memory “DB”
// =======================

// In-memory likes per customer (for Vision Intelligence)
const likeMemory = new Map(); // customerId -> [likeEntry]
const MAX_LIKES_PER_CUSTOMER = 50;

// Style profile cache & history
const styleProfileCache = new Map(); // customerId -> { profile, likesCountAtCompute, updatedAt }
const styleProfileHistory = new Map(); // customerId -> [ { profile, likesCountAtCompute, createdAt } ]

const MIN_LIKES_FOR_FIRST_PROFILE = 20;
const LIKES_PER_PROFILE_REFRESH = 5;

// In-memory sessions & generations & feedback (replace with real DB later)
const sessions = new Map(); // sessionId -> { id, customerId, platform, title, createdAt }
const generations = new Map(); // generationId -> { id, type, sessionId, customerId, ... }
const feedbacks = new Map(); // feedbackId -> { ... }

// =======================
// PART 3b – Credits / coupons (in-memory + Prisma)
// =======================

const credits = new Map(); // customerId -> { balance, history: [{ delta, reason, source, at }] }

// Prisma / Postgres integration for credits persistence
let prisma = null;

async function hydrateCreditsFromDb() {
  if (!prisma) return;
  try {
    const rows = await prisma.customerCredit.findMany();
    for (const row of rows) {
      credits.set(row.customerId, {
        balance: row.balance,
        history: [],
      });
    }
    console.log(`Hydrated ${rows.length} credit records from database.`);
  } catch (err) {
    console.error("Failed to hydrate credits from DB:", err);
  }
}

async function persistCreditsBalance(customerId, balance) {
  if (!prisma) return;
  try {
    await prisma.customerCredit.upsert({
      where: { customerId },
      update: { balance },
      create: { customerId, balance },
    });
  } catch (err) {
    console.error("Failed to persist credits balance", customerId, err);
  }
}

// ---------------------------------------------
// History hydration + persistence (sessions, generations, feedback)
// ---------------------------------------------

async function hydrateHistoryFromDb() {
  if (!prisma) return;
  try {
    const [sessionRows, generationRows, feedbackRows] = await Promise.all([
      prisma.session.findMany(),
      prisma.generation.findMany(),
      prisma.feedback.findMany(),
    ]);

    sessions.clear();
    generations.clear();
    feedbacks.clear();

    for (const row of sessionRows) {
      sessions.set(row.id, {
        id: row.id,
        customerId: row.customerId,
        platform: row.platform,
        title: row.title,
        createdAt:
          row.createdAt?.toISOString?.() ?? new Date().toISOString(),
      });
    }

    for (const row of generationRows) {
      generations.set(row.id, {
        id: row.id,
        type: row.type,
        sessionId: row.sessionId || "",
        customerId: row.customerId,
        platform: row.platform,
        prompt: row.prompt,
        outputUrl: row.outputUrl,
        createdAt:
          row.createdAt?.toISOString?.() ?? new Date().toISOString(),
        meta: row.meta || null,
      });
    }

    for (const row of feedbackRows) {
      feedbacks.set(row.id, {
        id: row.id,
        sessionId: row.sessionId || "",
        generationId: row.generationId || "",
        customerId: row.customerId,
        resultType: row.resultType,
        platform: row.platform,
        prompt: row.prompt,
        comment: row.comment,
        imageUrl: row.imageUrl || "",
        videoUrl: row.videoUrl || "",
        createdAt:
          row.createdAt?.toISOString?.() ?? new Date().toISOString(),
      });
    }

    console.log(
      `[init] Hydrated ${sessionRows.length} sessions, ${generationRows.length} generations, ${feedbackRows.length} feedbacks from DB.`,
    );
  } catch (err) {
    console.error("[init] Failed to hydrate history from DB", err);
  }
}

async function persistSession(session) {
  if (!prisma) return;
  try {
    await prisma.session.upsert({
      where: { id: session.id },
      update: {
        customerId: session.customerId,
        platform: session.platform,
        title: session.title,
      },
      create: {
        id: session.id,
        customerId: session.customerId,
        platform: session.platform,
        title: session.title,
      },
    });
  } catch (err) {
    console.error("[db] Failed to persist session", session.id, err);
  }
}

async function persistGeneration(gen) {
  if (!prisma) return;
  try {
    await prisma.generation.upsert({
      where: { id: gen.id },
      update: {
        type: gen.type,
        sessionId: gen.sessionId || null,
        customerId: gen.customerId,
        platform: gen.platform,
        prompt: gen.prompt,
        outputUrl: gen.outputUrl,
        meta: gen.meta ?? undefined,
      },
      create: {
        id: gen.id,
        type: gen.type,
        sessionId: gen.sessionId || null,
        customerId: gen.customerId,
        platform: gen.platform,
        prompt: gen.prompt,
        outputUrl: gen.outputUrl,
        meta: gen.meta ?? undefined,
      },
    });
  } catch (err) {
    console.error("[db] Failed to persist generation", gen.id, err);
  }
}

async function persistFeedback(feedback) {
  if (!prisma) return;
  try {
    await prisma.feedback.upsert({
      where: { id: feedback.id },
      update: {
        sessionId: feedback.sessionId || null,
        generationId: feedback.generationId || null,
        customerId: feedback.customerId,
        resultType: feedback.resultType,
        platform: feedback.platform,
        prompt: feedback.prompt,
        comment: feedback.comment,
        imageUrl: feedback.imageUrl || null,
        videoUrl: feedback.videoUrl || null,
      },
      create: {
        id: feedback.id,
        sessionId: feedback.sessionId || null,
        generationId: feedback.generationId || null,
        customerId: feedback.customerId,
        resultType: feedback.resultType,
        platform: feedback.platform,
        prompt: feedback.prompt,
        comment: feedback.comment,
        imageUrl: feedback.imageUrl || null,
        videoUrl: feedback.videoUrl || null,
      },
    });
  } catch (err) {
    console.error("[db] Failed to persist feedback", feedback.id, err);
  }
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set; using in-memory credits only.");
    return;
  }
  try {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
    await hydrateCreditsFromDb();
    await hydrateHistoryFromDb();

    console.log("Database initialized.");
  } catch (err) {
    console.error(
      "Failed to initialize database, using in-memory credits only.",
      err
    );
    prisma = null;
  }
}

initDatabase();

// How many credits each operation costs
const IMAGE_CREDITS_COST = Number(process.env.IMAGE_CREDITS_COST || 1);
const MOTION_CREDITS_COST = Number(process.env.MOTION_CREDITS_COST || 5);

// Free credits ON FIRST USE, for testing. Set to 0 in production.
const DEFAULT_FREE_CREDITS = Number(process.env.DEFAULT_FREE_CREDITS || 50);

function getCreditsRecord(customerIdRaw) {
  const customerId = String(customerIdRaw || "anonymous");

  let rec = credits.get(customerId);
  if (!rec) {
    rec = {
      balance: 0,
      history: [],
    };

    if (DEFAULT_FREE_CREDITS > 0) {
      rec.balance = DEFAULT_FREE_CREDITS;
      rec.history.push({
        delta: DEFAULT_FREE_CREDITS,
        reason: "auto-welcome",
        source: "system",
        at: new Date().toISOString(),
      });
    }

    credits.set(customerId, rec);
    // save starting balance to DB
    persistCreditsBalance(customerId, rec.balance);
  }

  return rec;
}

function addCreditsInternal(customerIdRaw, delta, reason, source) {
  const customerId = String(customerIdRaw || "anonymous");
  const rec = getCreditsRecord(customerId);

  rec.balance += delta;
  rec.history.push({
    delta,
    reason: reason || "adjustment",
    source: source || "api",
    at: new Date().toISOString(),
  });

  // save new balance to DB
  persistCreditsBalance(customerId, rec.balance);

  return rec;
}

// =======================
// PART 3c – Billing & auto top-up settings
// =======================

// GET billing settings
app.get("/billing/settings", async (req, res) => {
  try {
    const customerIdRaw = req.query.customerId;
    if (!customerIdRaw) {
      return res.status(400).json({ error: "Missing customerId" });
    }
    const customerId = String(customerIdRaw);

    if (!prisma) {
      return res.json({
        customerId,
        enabled: false,
        monthlyLimitPacks: 0,
        source: "no-db",
      });
    }

    const setting = await prisma.autoTopupSetting.findUnique({
      where: { customerId },
    });

    if (!setting) {
      return res.json({
        customerId,
        enabled: false,
        monthlyLimitPacks: 0,
      });
    }

    return res.json({
      customerId: setting.customerId,
      enabled: setting.enabled,
      monthlyLimitPacks: setting.monthlyLimitPacks,
    });
  } catch (err) {
    console.error("GET /billing/settings error", err);
    res.status(500).json({ error: "Failed to load billing settings" });
  }
});

// POST billing settings
app.post("/billing/settings", async (req, res) => {
  try {
    const { customerId, enabled, monthlyLimitPacks } = req.body || {};

    if (!customerId) {
      return res.status(400).json({ error: "customerId is required" });
    }

    const packsNumber = Number.isFinite(monthlyLimitPacks)
      ? Math.max(0, Math.floor(monthlyLimitPacks))
      : 0;

    if (!prisma) {
      return res
        .status(500)
        .json({ error: "Database not available for billing settings" });
    }

    const setting = await prisma.autoTopupSetting.upsert({
      where: { customerId: String(customerId) },
      update: {
        enabled: Boolean(enabled),
        monthlyLimitPacks: packsNumber,
      },
      create: {
        customerId: String(customerId),
        enabled: Boolean(enabled),
        monthlyLimitPacks: packsNumber,
      },
    });

    res.json({
      customerId: setting.customerId,
      enabled: setting.enabled,
      monthlyLimitPacks: setting.monthlyLimitPacks,
    });
  } catch (err) {
    console.error("POST /billing/settings error", err);
    res.status(500).json({ error: "Failed to save billing settings" });
  }
});
// =========================
// R2 Upload + Store Remote  (SIGNED URL ALWAYS)
// =========================

app.post("/api/r2/upload", async (req, res) => {
  try {
    const { dataUrl, kind = "uploads", customerId = "anon", filename = "" } = req.body || {};
    if (!dataUrl) throw new Error("Missing dataUrl");

    const { buffer, contentType, ext } = parseDataUrl(dataUrl);

    const cid = String(customerId || "anon");
    const safeFile = safeName(filename || "upload");
    const uuid = crypto.randomUUID();

    const key = `${String(kind)}/${cid}/${Date.now()}-${uuid}-${safeFile}.${ext}`;

    const signedUrl = await r2PutAndSignGet({
      key,
      body: buffer,
      contentType,
    });

    res.json({ ok: true, key, url: signedUrl, contentType, bytes: buffer.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || "upload_failed" });
  }
});

app.post("/api/r2/store-remote", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) throw new Error("Missing url");

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download remote: ${resp.status}`);

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const ext =
      contentType.includes("png") ? "png" :
      contentType.includes("jpeg") ? "jpg" :
      contentType.includes("webp") ? "webp" :
      contentType.includes("gif") ? "gif" :
      contentType.includes("mp4") ? "mp4" :
      "bin";

    const cid = String(customerId || "anon");
    const uuid = crypto.randomUUID();

    const key = `${String(kind)}/${cid}/${Date.now()}-${uuid}.${ext}`;

    const signedUrl = await r2PutAndSignGet({
      key,
      body: buf,
      contentType,
    });

    res.json({
      ok: true,
      key,
      url: signedUrl,
      contentType,
      bytes: buf.length,
      sourceUrl: url,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || "store_remote_failed" });
  }
});


// =======================
// PART 3d – Small helpers
// =======================

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function rememberLike(customerIdRaw, entry) {
  if (!customerIdRaw) return;
  const customerId = String(customerIdRaw);
  const existing = likeMemory.get(customerId) || [];
  existing.push({
    resultType: entry.resultType || "image",
    platform: entry.platform || "tiktok",
    prompt: entry.prompt || "",
    comment: entry.comment || "",
    imageUrl: entry.imageUrl || null,
    videoUrl: entry.videoUrl || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });

  if (existing.length > MAX_LIKES_PER_CUSTOMER) {
    const excess = existing.length - MAX_LIKES_PER_CUSTOMER;
    existing.splice(0, excess);
  }

  likeMemory.set(customerId, existing);
}

function getLikes(customerIdRaw) {
  if (!customerIdRaw) return [];
  const customerId = String(customerIdRaw);
  return likeMemory.get(customerId) || [];
}

function getStyleHistory(customerIdRaw) {
  const likes = getLikes(customerIdRaw);
  return likes.map((like) => ({
    prompt: like.prompt,
    platform: like.platform,
    comment: like.comment || null,
  }));
}

function mergePresetAndUserProfile(presetProfile, userProfile) {
  if (presetProfile && userProfile) {
    const combinedKeywords = [
      ...(presetProfile.keywords || []),
      ...(userProfile.keywords || []),
    ]
      .map((k) => String(k).trim())
      .filter(Boolean);
    const dedupedKeywords = Array.from(new Set(combinedKeywords));

    const description = (
      "Base style: " +
      (presetProfile.description || "") +
      " Personal twist: " +
      (userProfile.description || "")
    ).trim();

    return {
      profile: {
        keywords: dedupedKeywords,
        description,
      },
      source: "preset+user",
    };
  } else if (userProfile) {
    return { profile: userProfile, source: "user_only" };
  } else if (presetProfile) {
    return { profile: presetProfile, source: "preset_only" };
  } else {
    return { profile: null, source: "none" };
  }
}

// Create or get a session (in-memory)
function createSession({ customerId, platform, title }) {
  const sessionId = `sess_${uuidv4()}`;
  const session = {
    id: sessionId,
    customerId,
    platform,
    title,
    createdAt: new Date().toISOString(),
  };

  sessions.set(sessionId, session);

  if (prisma) {
    void persistSession(session);
  }

  return session;
}

function ensureSession(sessionIdRaw, customerId, platform) {
  const platformNorm = safeString(platform || "tiktok").toLowerCase();
  const incomingId = safeString(sessionIdRaw || "");
  if (incomingId && sessions.has(incomingId)) {
    return sessions.get(incomingId);
  }
  return createSession({
    customerId,
    platform: platformNorm,
    title: "Mina session",
  });
}

// =======================
// PART 4 – Style profiles via GPT
// =======================

async function runChatWithFallback({ systemMessage, userContent, fallbackPrompt }) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        systemMessage,
        {
          role: "user",
          content: userContent,
        },
      ],
      temperature: 0.8,
      max_tokens: 280,
    });

    const prompt = completion.choices?.[0]?.message?.content?.trim();
    if (!prompt) throw new Error("Empty GPT response");

    return { prompt, usedFallback: false, gptError: null };
  } catch (err) {
    console.error("OpenAI error, falling back:", err?.status, err?.message);
    return {
      prompt: fallbackPrompt,
      usedFallback: true,
      gptError: {
        status: err?.status || null,
        message: err?.message || String(err),
      },
    };
  }
}

// Build style profile from likes, with vision on liked images
async function buildStyleProfileFromLikes(customerId, likes) {
  const recentLikes = likes.slice(-10);
  if (!recentLikes.length) {
    return {
      profile: { keywords: [], description: "" },
      usedFallback: false,
      gptError: null,
    };
  }

  const examplesText = recentLikes
    .map((like, idx) => {
      return `#${idx + 1} [${like.resultType} / ${like.platform}]
Prompt: ${like.prompt || ""}
UserComment: ${like.comment || "none"}
HasImage: ${like.imageUrl ? "yes" : "no"}
HasVideo: ${like.videoUrl ? "yes" : "no"}`;
    })
    .join("\n\n");

  const systemMessage = {
    role: "system",
    content:
      "You are an assistant that summarizes a user's aesthetic preferences " +
      "for AI-generated editorial product images and motion.\n\n" +
      "You will see liked generations with prompts, optional comments, and sometimes the final liked image.\n\n" +
      "IMPORTANT:\n" +
      "- Treat comments as preference signals. If user says they DON'T like something (e.g. 'I like the image but I don't like the light'), do NOT treat that attribute as part of their style. Prefer avoiding repeatedly disliked attributes.\n" +
      "- For images, use the actual image content (colors, lighting, composition, background complexity, mood) to infer style.\n" +
      "- For motion entries you only see prompts/comments, use those.\n\n" +
      "Return STRICT JSON only with 'keywords' and 'description'.",
  };

  const userText = `
Customer id: ${customerId}

Below are image/video generations this customer explicitly liked.

Infer what they CONSISTENTLY LIKE, not what they dislike.
If comments mention dislikes, subtract those from your style interpretation.

Return STRICT JSON only with this shape:
{
  "keywords": ["short-tag-1", "short-tag-2", ...],
  "description": "2-3 sentence natural-language description of their style"
}

Text data for last liked generations:
${examplesText}
`.trim();

  const imageParts = [];
  recentLikes.forEach((like) => {
    if (like.resultType === "image" && like.imageUrl) {
      imageParts.push({
        type: "image_url",
        image_url: { url: like.imageUrl },
      });
    }
  });

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  const fallbackPrompt = '{"keywords":[],"description":""}';

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  let profile = { keywords: [], description: "" };
  try {
    profile = JSON.parse(result.prompt);
    if (!Array.isArray(profile.keywords)) profile.keywords = [];
    if (typeof profile.description !== "string") profile.description = "";
  } catch (e) {
    profile = {
      keywords: [],
      description: result.prompt || "",
    };
  }

  return {
    profile,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}

async function getOrBuildStyleProfile(customerIdRaw, likes) {
  const customerId = String(customerIdRaw || "anonymous");
  const likesCount = likes.length;

  if (likesCount < MIN_LIKES_FOR_FIRST_PROFILE) {
    return {
      profile: null,
      meta: {
        source: "none",
        reason: "not_enough_likes",
        likesCount,
        minLikesForFirstProfile: MIN_LIKES_FOR_FIRST_PROFILE,
      },
    };
  }

  const cached = styleProfileCache.get(customerId);
  if (
    cached &&
    likesCount < cached.likesCountAtCompute + LIKES_PER_PROFILE_REFRESH
  ) {
    return {
      profile: cached.profile,
      meta: {
        source: "cache",
        likesCount,
        likesCountAtProfile: cached.likesCountAtCompute,
        updatedAt: cached.updatedAt,
        refreshStep: LIKES_PER_PROFILE_REFRESH,
      },
    };
  }

  const profileRes = await buildStyleProfileFromLikes(customerId, likes);
  const profile = profileRes.profile;
  const updatedAt = new Date().toISOString();

  styleProfileCache.set(customerId, {
    profile,
    likesCountAtCompute: likesCount,
    updatedAt,
  });

  const historyArr = styleProfileHistory.get(customerId) || [];
  historyArr.push({
    profile,
    likesCountAtCompute: likesCount,
    createdAt: updatedAt,
  });
  styleProfileHistory.set(customerId, historyArr);

  return {
    profile,
    meta: {
      source: "recomputed",
      likesCount,
      likesCountAtProfile: likesCount,
      updatedAt,
      refreshStep: LIKES_PER_PROFILE_REFRESH,
      usedFallback: profileRes.usedFallback,
      gptError: profileRes.gptError,
    },
  };
}

// =======================
// PART 5 – Prompt builders
// =======================

async function buildEditorialPrompt(payload) {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
    styleHistory = [],
    styleProfile = null,
    presetHeroImageUrls = [],
  } = payload;

  const fallbackPrompt = [
    safeString(
      brief,
      "Editorial still-life product photo of the hero product on a simple surface."
    ),
    tone ? `Tone: ${tone}.` : "",
    `Shot for ${platform}, clean composition, professional lighting.`,
    "Hero product in focus, refined minimal background, fashion/editorial style.",
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none yet – this might be their first liked result.";

  const profileDescription =
    styleProfile && styleProfile.description
      ? styleProfile.description
      : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords)
      ? styleProfile.keywords.join(", ")
      : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial art director for fashion & beauty. " +
      "You will see one product image and up to several style reference images. " +
      "You write ONE clear prompt for a generative image model. " +
      "Describe subject, environment, lighting, camera, mood, and style. " +
      "Do NOT include line breaks, lists, or bullet points. One paragraph max.",
  };

  const userText = `
You are creating a new ${mode} for Mina.

Current request brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer (history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached images are:
- Main product image as the hero subject
- Up to 3 style/mood references from the user
- Optional preset hero style image(s) defining a strong mood/look

Write the final prompt I should send to the image model.
`.trim();

  const imageParts = [];
  if (productImageUrl) {
    imageParts.push({
      type: "image_url",
      image_url: { url: productImageUrl },
    });
  }
  (styleImageUrls || [])
    .slice(0, 3)
    .filter((url) => !!url)
    .forEach((url) => {
      imageParts.push({
        type: "image_url",
        image_url: { url },
      });
    });

  (presetHeroImageUrls || [])
    .slice(0, 1)
    .filter((url) => !!url)
    .forEach((url) => {
      imageParts.push({
        type: "image_url",
        image_url: { url },
      });
    });

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });
}

// Motion prompt for Kling (used only when generating video)
async function buildMotionPrompt(options) {
  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
    styleHistory = [],
    styleProfile = null,
  } = options;

  const fallbackPrompt = [
    motionBrief ||
      "Short looping editorial motion of the product with a subtle camera move and gentle light changes.",
    tone ? `Tone: ${tone}.` : "",
    `Optimised for ${platform} vertical content.`,
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description
      ? styleProfile.description
      : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords)
      ? styleProfile.keywords.join(", ")
      : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for fashion & beauty. " +
      "You will see a reference still frame. " +
      "You describe a SHORT looping product motion for a generative video model like Kling. " +
      "Keep it 1–2 sentences, no line breaks.",
  };

  const userText = `
You are creating a short motion loop based on the attached still frame.

Desired motion description from the user:
${safeString(
  motionBrief,
  "subtle elegant camera move with a small motion in the scene."
)}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked image prompts for this customer (aesthetic history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached image is the reference frame to animate. Do NOT mention URLs. 
Write the final video generation prompt.
`.trim();

  const imageParts = [];
  if (lastImageUrl) {
    imageParts.push({
      type: "image_url",
      image_url: { url: lastImageUrl },
    });
  }

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });
}

// Motion idea suggestion for the textarea (1 sentence)
async function buildMotionSuggestion(options) {
  const {
    referenceImageUrl,
    tone,
    platform = "tiktok",
    styleHistory = [],
    styleProfile = null,
  } = options;

  const fallbackPrompt =
    "Slow, minimal editorial motion with a gentle camera drift and soft ASMR-like movement of light or props.";

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description
      ? styleProfile.description
      : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords)
      ? styleProfile.keywords.join(", ")
      : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for luxury still-life. " +
      "Given a reference image and style preferences, propose ONE short motion idea the user will see in a textarea. " +
      "The motion should feel editorial, minimal, ASMR-like: think subtle camera moves, soft breeze, melting, slow drips, gentle shadows.\n\n" +
      "Constraints:\n" +
      "- Return exactly ONE sentence, no bullet points, no quotes.\n" +
      "- Max ~220 characters.\n" +
      "- Do NOT mention 'TikTok' or 'platform', just describe the motion.",
  };

  const userText = `
We want a motion idea for an editorial product shot.

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer:
${historyText}

Style profile:
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached image is the still to animate. Propose one natural-language motion idea sentence.
`.trim();

  const imageParts = [];
  if (referenceImageUrl) {
    imageParts.push({
      type: "image_url",
      image_url: { url: referenceImageUrl },
    });
  }

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  return {
    text: result.prompt,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}

// =======================
// PART 6 – Core routes (health, credits, editorial, motion, feedback)
// =======================

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API",
    time: new Date().toISOString(),
  });
});

// public stats → total users on login screen
app.get("/public/stats/total-users", async (_req, res) => {
  const requestId = `stats_${Date.now()}`;

  // If Prisma/DB is not available, don't fake numbers
  if (!prisma) {
    return res.json({
      ok: false,
      requestId,
      source: "no_db",
      totalUsers: null,
    });
  }

  try {
    // Each row in customerCredit corresponds to one customerId
    const dbCount = await prisma.customerCredit.count();

    const total = dbCount + MINA_BASELINE_USERS;

    return res.json({
      ok: true,
      requestId,
      source: "db",
      totalUsers: total,
    });
  } catch (err) {
    console.error("[mina] total-users db error", err);
    return res.json({
      ok: false,
      requestId,
      source: "db_error",
      totalUsers: null,
    });
  }
});

// ---- Credits: balance ----
app.get("/credits/balance", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const customerIdRaw = req.query.customerId || "anonymous";
    const customerId = String(customerIdRaw);
    const rec = getCreditsRecord(customerId);
    res.json({
      ok: true,
      requestId,
      customerId,
      balance: rec.balance,
      historyLength: rec.history.length,
      meta: {
        imageCost: IMAGE_CREDITS_COST,
        motionCost: MOTION_CREDITS_COST,
      },
    });
  } catch (err) {
    console.error("Error in /credits/balance:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits balance.",
      requestId,
    });
  }
});

// ---- Credits: add (manual / via webhook) ----
app.post("/credits/add", (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";
    const amount =
      typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
    const reason = safeString(body.reason || "manual-topup");
    const source = safeString(body.source || "api");

    if (!amount || !Number.isFinite(amount)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AMOUNT",
        message: "amount is required and must be a number.",
        requestId,
      });
    }

    const rec = addCreditsInternal(customerId, amount, reason, source);

    res.json({
      ok: true,
      requestId,
      customerId,
      newBalance: rec.balance,
    });
  } catch (err) {
    console.error("Error in /credits/add:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits add.",
      requestId,
    });
  }
});

// --- Admin API (summary & credits customers/adjust) ---
app.get("/admin/summary", async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    if (!prisma) {
      return res.status(503).json({ error: "Database not available" });
    }

    const totalCustomers = await prisma.customerCredit.count();
    const sumResult = await prisma.customerCredit.aggregate({
      _sum: { balance: true },
    });
    const autoTopupOn = await prisma.autoTopupSetting.count({
      where: { enabled: true },
    });

    res.json({
      totalCustomers,
      totalCredits: sumResult._sum.balance || 0,
      autoTopupOn,
    });
  } catch (err) {
    console.error("GET /admin/summary error", err);
    res.status(500).json({ error: "Failed to load admin summary" });
  }
});

app.get("/admin/customers", async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    if (!prisma) {
      // Fallback: use in-memory map only
      const items = Array.from(credits.entries()).map(
        ([customerId, rec]) => ({
          customerId,
          balance: rec.balance,
        })
      );
      return res.json({ customers: items, source: "memory" });
    }

    const rows = await prisma.customerCredit.findMany({
      orderBy: { customerId: "asc" },
      take: 500,
    });

    res.json({ customers: rows, source: "db" });
  } catch (err) {
    console.error("GET /admin/customers error", err);
    res.status(500).json({ error: "Failed to load admin customers" });
  }
});

app.post("/admin/credits/adjust", async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const { customerId, delta, reason } = req.body || {};
    if (!customerId || typeof delta !== "number") {
      return res
        .status(400)
        .json({ error: "customerId and numeric delta are required" });
    }

    const rec = addCreditsInternal(
      customerId,
      delta,
      reason || "admin-adjust",
      "admin"
    );

    res.json({
      customerId: String(customerId),
      balance: rec.balance,
    });
  } catch (err) {
    console.error("POST /admin/credits/adjust error", err);
    res.status(500).json({ error: "Failed to adjust credits" });
  }
});

// ---- Session start ----
app.post("/sessions/start", (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const title = safeString(body.title || "Mina session");

    // ensure credits record exists for this customer
    getCreditsRecord(customerId);

    const session = createSession({ customerId, platform, title });

    res.json({
      ok: true,
      requestId,
      session,
    });
  } catch (err) {
    console.error("Error in /sessions/start:", err);
    res.status(500).json({
      ok: false,
      error: "SESSION_ERROR",
      message: err?.message || "Unexpected error during session start.",
      requestId,
    });
  }
});

// ---- Mina Editorial (image) ----
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const productImageUrl = safeString(body.productImageUrl);
    const styleImageUrls = Array.isArray(body.styleImageUrls)
      ? body.styleImageUrls
      : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!productImageUrl && !brief) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message:
          "Provide at least productImageUrl or brief so Mina knows what to create.",
        requestId,
      });
    }

    // Credits check
    const creditsRecord = getCreditsRecord(customerId);
    const imageCost = IMAGE_CREDITS_COST;
    if (creditsRecord.balance < imageCost) {
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${imageCost}, you have ${creditsRecord.balance}.`,
        requiredCredits: imageCost,
        currentCredits: creditsRecord.balance,
        requestId,
      });
    }

    // Session
    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = getLikes(customerId);
      styleHistory = getStyleHistory(customerId);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        userStyleProfile
      );
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        null
      );
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const promptResult = await buildEditorialPrompt({
      productImageUrl,
      styleImageUrls,
      brief,
      tone,
      platform,
      mode: "image",
      styleHistory,
      styleProfile: finalStyleProfile,
      presetHeroImageUrls: preset?.heroImageUrls || [],
    });

    const prompt = promptResult.prompt;

    // Map platform to aspect ratio (allow explicit override from client)
const requestedAspect = safeString(body.aspectRatio || "");
const validAspects = new Set(["9:16", "3:4", "2:3", "1:1", "4:5", "16:9"]);

let aspectRatio = "2:3";

// 1) Client override wins (your UI sends this)
if (validAspects.has(requestedAspect)) {
  aspectRatio = requestedAspect;
} else {
  // 2) Otherwise infer from platform keys
  if (platform === "tiktok" || platform.includes("reel")) aspectRatio = "9:16";
  else if (platform === "instagram-post") aspectRatio = "3:4";
  else if (platform === "print") aspectRatio = "2:3";
  else if (platform === "square") aspectRatio = "1:1";
  else if (platform.includes("youtube")) aspectRatio = "16:9";
}

    const input = {
      prompt,
      image_input: productImageUrl
        ? [productImageUrl, ...styleImageUrls]
        : styleImageUrls,
      max_images: body.maxImages || 1,
      size: "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run(SEADREAM_MODEL, { input });

    let imageUrls = [];
    if (Array.isArray(output)) {
      imageUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            return item.url || item.image || null;
          }
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      imageUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") imageUrls = [output.url];
      else if (Array.isArray(output.output)) {
        imageUrls = output.output.filter((v) => typeof v === "string");
      }
    }

    const imageUrl = imageUrls[0] || null;

    // Spend credits AFTER successful generation
    creditsRecord.balance -= imageCost;
    creditsRecord.history.push({
      delta: -imageCost,
      reason: "image-generate",
      source: "api",
      at: new Date().toISOString(),
    });
    persistCreditsBalance(customerId, creditsRecord.balance);

    // Save image generation in memory + DB
    const generationId = `gen_${uuidv4()}`;

    const generationRecord = {
      id: generationId,
      type: "image",
      sessionId,
      customerId,
      platform,
      prompt: prompt || "",
      outputUrl: imageUrl,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        productImageUrl,
        styleImageUrls,
        aspectRatio,
      },
    };

    generations.set(generationId, generationRecord);

    if (prisma) {
      void persistGeneration(generationRecord);
    }

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt,
      imageUrl,
      imageUrls,
      rawOutput: output,
      payload: body,
      generationId,
      sessionId,
      credits: {
        balance: creditsRecord.balance,
        cost: imageCost,
      },
      gpt: {
        usedFallback: promptResult.usedFallback,
        error: promptResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
      },
    });
  } catch (err) {
    console.error("Error in /editorial/generate:", err);
    res.status(500).json({
      ok: false,
      error: "EDITORIAL_GENERATION_ERROR",
      message: err?.message || "Unexpected error during image generation.",
      requestId,
    });
  }
});

// ---- Motion suggestion (for textarea) ----
app.post("/motion/suggest", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const referenceImageUrl = safeString(body.referenceImageUrl);
    if (!referenceImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_REFERENCE_IMAGE",
        message: "referenceImageUrl is required to suggest motion.",
        requestId,
      });
    }

    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;

    if (minaVisionEnabled && customerId) {
      const likes = getLikes(customerId);
      styleHistory = getStyleHistory(customerId);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;
      finalStyleProfile = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        userStyleProfile
      ).profile;
    } else {
      styleHistory = [];
      finalStyleProfile = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        null
      ).profile;
    }

    const suggestionRes = await buildMotionSuggestion({
      referenceImageUrl,
      tone,
      platform,
      styleHistory,
      styleProfile: finalStyleProfile,
    });

    res.json({
      ok: true,
      requestId,
      suggestion: suggestionRes.text,
      gpt: {
        usedFallback: suggestionRes.usedFallback,
        error: suggestionRes.gptError,
      },
    });
  } catch (err) {
    console.error("Error in /motion/suggest:", err);
    res.status(500).json({
      ok: false,
      error: "MOTION_SUGGESTION_ERROR",
      message: err?.message || "Unexpected error during motion suggestion.",
      requestId,
    });
  }
});

// ---- Mina Motion (video) ----
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    // Credits check
    const creditsRecord = getCreditsRecord(customerId);
    const motionCost = MOTION_CREDITS_COST;
    if (creditsRecord.balance < motionCost) {
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${motionCost}, you have ${creditsRecord.balance}.`,
        requiredCredits: motionCost,
        currentCredits: creditsRecord.balance,
        requestId,
      });
    }

    // Session
    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = getLikes(customerId);
      styleHistory = getStyleHistory(customerId);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        userStyleProfile
      );
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(
        preset ? preset.profile : null,
        null
      );
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const motionResult = await buildMotionPrompt({
      motionBrief: motionDescription,
      tone,
      platform,
      lastImageUrl,
      styleHistory,
      styleProfile: finalStyleProfile,
    });

    const prompt = motionResult.prompt;
    let durationSeconds = Number(body.durationSeconds || 5);
    if (durationSeconds > 10) durationSeconds = 10;
    if (durationSeconds < 1) durationSeconds = 1;

    const input = {
      mode: "standard",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: "",
    };

    const output = await replicate.run(KLING_MODEL, { input });

    let videoUrl = null;
    if (typeof output === "string") {
      videoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") {
        videoUrl = first;
      } else if (first && typeof first === "object") {
        if (typeof first.url === "string") videoUrl = first.url;
        else if (typeof first.video === "string") videoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") videoUrl = output.url;
      else if (typeof output.video === "string") videoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") {
          videoUrl = output.output[0];
        }
      }
    }

    // Spend credits AFTER successful generation
    creditsRecord.balance -= motionCost;
    creditsRecord.history.push({
      delta: -motionCost,
      reason: "motion-generate",
      source: "api",
      at: new Date().toISOString(),
    });
    persistCreditsBalance(customerId, creditsRecord.balance);

    // Save motion generation in memory + DB
    const generationId = `gen_${uuidv4()}`;

    const generationRecord = {
      id: generationId,
      type: "motion",
      sessionId,
      customerId,
      platform,
      prompt: motionDescription || "",
      outputUrl: videoUrl,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        lastImageUrl,
        durationSeconds,
      },
    };

    generations.set(generationId, generationRecord);

    if (prisma) {
      void persistGeneration(generationRecord);
    }

    res.json({
      ok: true,
      message: "Mina Motion video generated via Kling.",
      requestId,
      prompt,
      videoUrl,
      rawOutput: output,
      generationId,
      sessionId,
      payload: {
        lastImageUrl,
        motionDescription,
        tone,
        platform,
        durationSeconds,
        customerId,
        stylePresetKey,
      },
      credits: {
        balance: creditsRecord.balance,
        cost: motionCost,
      },
      gpt: {
        usedFallback: motionResult.usedFallback,
        error: motionResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
      },
    });
  } catch (err) {
    console.error("Error in /motion/generate:", err);
    res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});

// ---- Feedback / likes (image + motion) ----
app.post("/feedback/like", (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";
    const resultType = safeString(body.resultType || "image");
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const prompt = safeString(body.prompt);
    const comment = safeString(body.comment);
    const imageUrl = safeString(body.imageUrl || "");
    const videoUrl = safeString(body.videoUrl || "");
    const sessionId = safeString(body.sessionId || "");
    const generationId = safeString(body.generationId || "");

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_PROMPT",
        message: "Prompt is required to store like feedback.",
        requestId,
      });
    }

    // Save in Vision memory
    rememberLike(customerId, {
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
    });

    // Save feedback in in-memory DB
    const feedbackId = `fb_${uuidv4()}`;
    const feedback = {
      id: feedbackId,
      sessionId: sessionId || null,
      generationId: generationId || null,
      customerId,
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      createdAt: new Date().toISOString(),
    };

    feedbacks.set(feedbackId, feedback);

    if (prisma) {
      void persistFeedback(feedback);
    }

    const totalLikes = getLikes(customerId).length;

    res.json({
      ok: true,
      message: "Like stored for Mina Vision Intelligence.",
      requestId,
      payload: {
        customerId,
        resultType,
        platform,
        sessionId: sessionId || null,
        generationId: generationId || null,
      },
      totals: {
        likesForCustomer: totalLikes,
      },
    });
  } catch (err) {
    console.error("Error in /feedback/like:", err);
    res.status(500).json({
      ok: false,
      error: "FEEDBACK_ERROR",
      message: err?.message || "Unexpected error while saving feedback.",
      requestId,
    });
  }
});

// =========================
// PART 7 – Shopify credits integration (no Flow)
// =========================

/**
 * Map of SKU -> credits per unit.
 * Example: "MINA-50" gives 50 credits per quantity 1.
 */
const CREDIT_SKUS = {
  "MINA-50": 50, // Mina 50 Machta
  // later: "MINA-200": 200, etc.
};

/**
 * Shopify Admin will POST the full order JSON to:
 *   /api/credits/shopify-order?secret=YOUR_SECRET
 */
app.post("/api/credits/shopify-order", async (req, res) => {
  try {
    const secretFromQuery = req.query.secret;
    if (
      !secretFromQuery ||
      secretFromQuery !== process.env.SHOPIFY_ORDER_WEBHOOK_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Invalid webhook secret",
      });
    }

    const order = req.body;
    if (!order) {
      return res.status(400).json({
        ok: false,
        error: "NO_ORDER",
        message: "Missing order payload",
      });
    }

    if (!order.customer || !order.customer.id) {
      return res.status(400).json({
        ok: false,
        error: "NO_CUSTOMER",
        message: "Order has no customer.id",
      });
    }

    const customerId = String(order.customer.id);

    let creditsToAdd = 0;
    const items = order.line_items || [];

    for (const item of items) {
      const sku = item.sku;
      const quantity = item.quantity || 1;

      if (sku && CREDIT_SKUS[sku]) {
        const perUnit = CREDIT_SKUS[sku];
        const totalForItem = perUnit * quantity;
        creditsToAdd += totalForItem;
      }
    }

    if (creditsToAdd <= 0) {
      console.log(
        "[SHOPIFY_WEBHOOK] Order has no credit SKUs. Doing nothing."
      );
      return res.json({
        ok: true,
        message: "No credit products found in order.",
        added: 0,
      });
    }

    const updated = addCreditsInternal(
      customerId,
      creditsToAdd,
      `shopify-order:${order.id || "unknown"}`,
      "shopify"
    );

    return res.json({
      ok: true,
      message: "Credits added from Shopify order.",
      customerId,
      added: creditsToAdd,
      balance: updated.balance,
    });
  } catch (err) {
    console.error("Error in /api/credits/shopify-order:", err);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Failed to process Shopify order webhook",
    });
  }
});

// =========================
// PART 8 – Debug credits endpoint
// =========================

app.get("/api/credits/:customerId", (req, res) => {
  const customerId = String(req.params.customerId || "anonymous");
  const rec = getCreditsRecord(customerId);
  return res.json({
    ok: true,
    customerId,
    balance: rec.balance,
    history: rec.history,
  });
});

// =========================
// PART 9 – History endpoints
// =========================

app.get("/history/customer/:customerId", (req, res) => {
  try {
    const customerId = String(req.params.customerId || "anonymous");

    const generationsForCustomer = Array.from(generations.values()).filter(
      (g) => g.customerId === customerId
    );

    const feedbacksForCustomer = Array.from(feedbacks.values()).filter(
      (f) => f.customerId === customerId
    );

    const creditsRecord = getCreditsRecord(customerId);

    return res.json({
      ok: true,
      customerId,
      credits: {
        balance: creditsRecord.balance,
        history: creditsRecord.history,
      },
      generations: generationsForCustomer,
      feedbacks: feedbacksForCustomer,
    });
  } catch (err) {
    console.error("Error in /history/customer/:customerId", err);
    return res.status(500).json({
      ok: false,
      error: "HISTORY_ERROR",
      message: err?.message || "Unexpected error while loading history.",
    });
  }
});

const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY || "";

app.get("/history/admin/overview", (req, res) => {
  try {
    if (!ADMIN_DASHBOARD_KEY) {
      return res.status(500).json({
        ok: false,
        error: "ADMIN_KEY_NOT_SET",
        message:
          "ADMIN_DASHBOARD_KEY is not configured on the server. Set it in Render env vars.",
      });
    }

    const key = req.query.key;
    if (!key || key !== ADMIN_DASHBOARD_KEY) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Invalid admin key.",
      });
    }

    const allGenerations = Array.from(generations.values()).sort((a, b) => {
      const tA = new Date(a.createdAt || 0).getTime();
      const tB = new Date(b.createdAt || 0).getTime();
      return tB - tA;
    });

    const allFeedbacks = Array.from(feedbacks.values()).sort((a, b) => {
      const tA = new Date(a.createdAt || 0).getTime();
      const tB = new Date(b.createdAt || 0).getTime();
      return tB - tA;
    });

    const creditsArray = Array.from(credits.entries()).map(
      ([customerId, rec]) => ({
        customerId,
        balance: rec.balance,
        history: rec.history,
      })
    );

    return res.json({
      ok: true,
      totals: {
        customersWithCredits: creditsArray.length,
        generations: allGenerations.length,
        feedbacks: allFeedbacks.length,
      },
      generations: allGenerations,
      feedbacks: allFeedbacks,
      credits: creditsArray,
    });
  } catch (err) {
    console.error("Error in /history/admin/overview", err);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_HISTORY_ERROR",
      message: err?.message || "Unexpected error while loading admin overview.",
    });
  }
});

// ============================
// 3B) Store remote generation (Replicate/OpenAI result URL -> R2)
// ============================
app.post("/store-remote-generation", async (req, res) => {
  try {
    const { url, urls, customerId, folder } = req.body || {};

    const remoteUrl =
      (typeof url === "string" && url) ||
      (Array.isArray(urls) && typeof urls[0] === "string" ? urls[0] : "");

    if (!remoteUrl) {
      return res.status(400).json({ ok: false, error: "NO_URL" });
    }

    const cid = (customerId || "anon").toString();
    const fold = (folder || "generations").toString();

    const resp = await fetch(remoteUrl);
    if (!resp.ok) {
      return res.status(400).json({
        ok: false,
        error: "REMOTE_FETCH_FAILED",
        status: resp.status,
      });
    }

    const contentType =
      resp.headers.get("content-type") || "application/octet-stream";
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const uuid = crypto.randomUUID();

    // small extension guess
    const ext =
      contentType.includes("png")
        ? "png"
        : contentType.includes("jpeg")
        ? "jpg"
        : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
        ? "gif"
        : contentType.includes("mp4")
        ? "mp4"
        : "";

    const key = `${fold}/${cid}/${Date.now()}-${uuid}${
      ext ? `.${ext}` : ""
    }`;

    const storedUrl = await r2PutAndSignGet({
      key,
      body: buf,
      contentType,
    });

    return res.json({
      ok: true,
      key,
      url: storedUrl, // signed GET url
      contentType,
      size: buf.length,
      sourceUrl: remoteUrl,
    });
  } catch (err) {
    console.error("POST /store-remote-generation error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED" });
  }
});
// =========================
// PART X – R2 Signed Uploads (ADD-ONLY, does not replace your existing routes)
// =========================
//
// Why: your current /api/r2/upload returns publicUrlForKey(key) which can be empty
// when the bucket is private. These new endpoints always return a SIGNED URL.
//
// New endpoints:
// 1) POST /api/r2/upload-signed
// 2) POST /api/r2/store-remote-signed
// 3) GET  /debug/r2

function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
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

app.get("/debug/r2", (_req, res) => {
  const missing = [];
  if (!process.env.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
  if (!process.env.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!process.env.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!process.env.R2_BUCKET) missing.push("R2_BUCKET");

  res.json({
    ok: missing.length === 0,
    missing,
    hasEndpointOverride: !!process.env.R2_ENDPOINT,
    nodeVersion: process.version,
  });
});

// 1) Upload a dataUrl -> R2 and return SIGNED url
app.post("/api/r2/upload-signed", async (req, res) => {
  try {
    const { dataUrl, kind = "uploads", customerId = "anon", filename = "" } =
      req.body || {};

    if (!dataUrl) {
      return res.status(400).json({ ok: false, error: "MISSING_DATAURL" });
    }

    const { buffer, contentType, ext } = parseDataUrl(dataUrl);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const base = safeName(filename || "upload");
    const uuid = crypto.randomUUID();

    // ext from dataUrl parser OR content-type guess
    const extGuess = ext || guessExtFromContentType(contentType);
    const key = `${folder}/${cid}/${Date.now()}-${uuid}-${base}${
      extGuess && !base.toLowerCase().endsWith(`.${extGuess}`)
        ? `.${extGuess}`
        : ""
    }`;

    const signedUrl = await r2PutAndSignGet({
      key,
      body: buffer,
      contentType,
    });

    return res.json({
      ok: true,
      key,
      url: signedUrl, // ✅ always signed
      contentType,
      bytes: buffer.length,
    });
  } catch (err) {
    console.error("POST /api/r2/upload-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "UPLOAD_SIGNED_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

// 2) Store a remote URL -> R2 and return SIGNED url
app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) {
      return res.status(400).json({ ok: false, error: "MISSING_URL" });
    }

    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(400).json({
        ok: false,
        error: "REMOTE_FETCH_FAILED",
        status: resp.status,
      });
    }

    const contentType =
      resp.headers.get("content-type") || "application/octet-stream";

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const uuid = crypto.randomUUID();
    const extGuess = guessExtFromContentType(contentType);

    const key = `${folder}/${cid}/${Date.now()}-${uuid}${
      extGuess ? `.${extGuess}` : ""
    }`;

    const signedUrl = await r2PutAndSignGet({
      key,
      body: buf,
      contentType,
    });

    return res.json({
      ok: true,
      key,
      url: signedUrl, // ✅ always signed
      contentType,
      size: buf.length,
      sourceUrl: url,
    });
  } catch (err) {
    console.error("POST /api/r2/store-remote-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "STORE_REMOTE_SIGNED_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

// =======================
// PART 10 – Start server
// =======================

app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
