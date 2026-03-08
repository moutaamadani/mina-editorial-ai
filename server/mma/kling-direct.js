import crypto from "crypto";

function base64UrlEncode(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateKlingJwt(accessKey, secretKey, expiresInSec = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: accessKey,
    exp: now + expiresInSec,
    nbf: now - 5,
    iat: now,
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${headerB64}.${payloadB64}`)
    .digest();

  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

let _cachedToken = null;
let _cachedTokenExp = 0;

function getAuthToken() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in env");
  }

  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _cachedTokenExp > now + 300) {
    return _cachedToken;
  }

  const expiresIn = 1800;
  _cachedToken = generateKlingJwt(accessKey, secretKey, expiresIn);
  _cachedTokenExp = now + expiresIn;
  return _cachedToken;
}

const DEFAULT_BASE_URL = "https://api-singapore.klingai.com";

function getBaseUrl() {
  return (process.env.KLING_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function klingPost(path, body) {
  const url = `${getBaseUrl()}${path}`;
  const token = getAuthToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    const err = new Error(
      `KLING_API_ERROR: ${json.message || res.statusText || "unknown"} (code=${json.code}, http=${res.status})`
    );
    err.code = `KLING_HTTP_${res.status}`;
    err.provider = { kling: json };
    throw err;
  }

  return json;
}

async function klingGet(path) {
  const url = `${getBaseUrl()}${path}`;
  const token = getAuthToken();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    const err = new Error(
      `KLING_API_ERROR: ${json.message || res.statusText || "unknown"} (code=${json.code}, http=${res.status})`
    );
    err.code = `KLING_HTTP_${res.status}`;
    err.provider = { kling: json };
    throw err;
  }

  return json;
}

async function pollKlingTask(queryPath, taskId, { pollMs, maxPollMs } = {}) {
  const interval = Number(pollMs || process.env.KLING_POLL_MS || 3000) || 3000;
  const maxMs = Number(maxPollMs || process.env.KLING_MAX_POLL_MS || 900000) || 900000;
  const t0 = Date.now();

  while (true) {
    const elapsed = Date.now() - t0;
    if (elapsed > maxMs) {
      return { status: "timeout", task: null, timedOut: true };
    }

    const json = await klingGet(`${queryPath}/${taskId}`);
    const task = json?.data || {};
    const status = (task.task_status || "").toLowerCase();

    if (status === "succeed") {
      return { status: "succeed", task, timedOut: false };
    }

    if (status === "failed") {
      const msg = task.task_status_msg || "Task failed";
      const err = new Error(`KLING_TASK_FAILED: ${msg}`);
      err.code = "KLING_TASK_FAILED";
      err.provider = { kling: task };
      throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function extractVideoUrl(task) {
  const videos = task?.task_result?.videos;
  if (Array.isArray(videos) && videos.length > 0) {
    return videos[0].url || "";
  }
  return "";
}

function extractImageUrl(task) {
  const images = task?.task_result?.images;
  if (Array.isArray(images) && images.length > 0) {
    return images[0].url || "";
  }
  return "";
}

function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t || fallback;
}

function asHttpUrl(u) {
  const s = safeStr(u, "");
  return s.startsWith("http") ? s : "";
}

function nowIso() {
  return new Date().toISOString();
}

export async function runKlingDirect({
  prompt,
  startImage,
  endImage,
  duration,
  mode,
  negativePrompt,
  generateAudio,
  aspectRatio,
  multiShot,
  multiPrompt,
  input: forcedInput,
}) {
  const t0 = Date.now();

  const envModel = safeStr(
    process.env.MMA_KLING_MODEL_NAME || process.env.MMA_KLING_VERSION || "",
    ""
  ).toLowerCase();

  let modelName = "kling-v3";
  if (envModel.includes("v3-omni") || envModel.includes("kling-v3-omni")) {
    modelName = "kling-v3-omni";
  } else if (envModel.includes("v3") || envModel.includes("kling-v3")) {
    modelName = "kling-v3";
  } else if (envModel.includes("v2-6") || envModel.includes("v2.6")) {
    modelName = "kling-v2-6";
  } else if (envModel.includes("v2-1") || envModel.includes("v2.1")) {
    modelName = "kling-v2-1-master";
  }

  const isOmni = modelName === "kling-v3-omni";
  const hasStart = !!asHttpUrl(startImage);
  const hasEnd = !!asHttpUrl(endImage);

  const finalMode = safeStr(mode, "pro").toLowerCase();
  const apiMode = finalMode === "std" || finalMode === "standard" ? "std" : "pro";
  const rawDuration = Number(duration || 5) || 5;
  const apiDuration = String(Math.max(3, Math.min(15, Math.round(rawDuration))));
  const soundValue = generateAudio === false ? "off" : "on";
  const finalSound = hasEnd ? "off" : soundValue;
  const ar = safeStr(aspectRatio, "16:9");

  let body;
  let endpoint;
  let queryEndpoint;

  if (isOmni) {
    endpoint = "/v1/videos/omni-video";
    queryEndpoint = "/v1/videos/omni-video";

    const imageList = [];
    if (hasStart) imageList.push({ image_url: startImage, type: "first_frame" });
    if (hasEnd) imageList.push({ image_url: endImage, type: "end_frame" });

    body = {
      model_name: "kling-v3-omni",
      prompt: safeStr(prompt, ""),
      mode: apiMode,
      duration: apiDuration,
      sound: finalSound,
      ...(imageList.length ? { image_list: imageList } : { aspect_ratio: ar }),
    };

    if (multiShot && Array.isArray(multiPrompt) && multiPrompt.length > 0) {
      body.multi_shot = true;
      body.shot_type = "customize";
      body.prompt = "";
      body.multi_prompt = multiPrompt.map((mp, i) => ({
        index: mp.index || i + 1,
        prompt: mp.prompt || "",
        duration: String(mp.duration || 5),
      }));
    }
  } else if (hasStart || hasEnd) {
    endpoint = "/v1/videos/image2video";
    queryEndpoint = "/v1/videos/image2video";

    body = {
      model_name: modelName,
      prompt: safeStr(prompt, ""),
      mode: apiMode,
      duration: apiDuration,
      sound: finalSound,
      ...(hasStart ? { image: startImage } : {}),
      ...(hasEnd ? { image_tail: endImage } : {}),
      ...(safeStr(negativePrompt, "") ? { negative_prompt: negativePrompt } : {}),
    };

    if (multiShot && Array.isArray(multiPrompt) && multiPrompt.length > 0) {
      body.multi_shot = true;
      body.shot_type = "customize";
      body.prompt = "";
      body.multi_prompt = multiPrompt.map((mp, i) => ({
        index: mp.index || i + 1,
        prompt: mp.prompt || "",
        duration: String(mp.duration || 5),
      }));
    }
  } else {
    endpoint = "/v1/videos/text2video";
    queryEndpoint = "/v1/videos/text2video";

    body = {
      model_name: modelName,
      prompt: safeStr(prompt, ""),
      mode: apiMode,
      duration: apiDuration,
      aspect_ratio: ar,
      sound: finalSound,
      ...(safeStr(negativePrompt, "") ? { negative_prompt: negativePrompt } : {}),
    };

    if (multiShot && Array.isArray(multiPrompt) && multiPrompt.length > 0) {
      body.multi_shot = true;
      body.shot_type = "customize";
      body.prompt = "";
      body.multi_prompt = multiPrompt.map((mp, i) => ({
        index: mp.index || i + 1,
        prompt: mp.prompt || "",
        duration: String(mp.duration || 5),
      }));
    }
  }

  if (forcedInput && typeof forcedInput === "object") {
    body = { ...body, ...forcedInput };
  }

  const createResp = await klingPost(endpoint, body);
  const taskId = createResp?.data?.task_id;
  if (!taskId) {
    throw new Error(`KLING_NO_TASK_ID: ${JSON.stringify(createResp).slice(0, 500)}`);
  }

  const pollResult = await pollKlingTask(queryEndpoint, taskId);
  if (pollResult.timedOut) {
    return {
      input: body,
      out: null,
      task_id: taskId,
      prediction_id: taskId,
      prediction_status: "processing",
      timed_out: true,
      timing: {
        started_at: new Date(t0).toISOString(),
        ended_at: nowIso(),
        duration_ms: Date.now() - t0,
      },
      provider: { kling: { task_id: taskId, status: "processing" } },
    };
  }

  const task = pollResult.task;
  const videoUrl = extractVideoUrl(task);

  return {
    input: body,
    out: videoUrl || null,
    task_id: taskId,
    prediction_id: taskId,
    prediction_status: "succeed",
    timed_out: false,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { kling: task },
  };
}

export async function runKlingMotionControlDirect({
  prompt,
  image,
  video,
  mode,
  keepOriginalSound,
  characterOrientation,
  duration,
  referType,
  input: forcedInput,
}) {
  void characterOrientation;
  const t0 = Date.now();
  const hasImage = !!asHttpUrl(image);
  const hasVideo = !!asHttpUrl(video);

  if (!hasVideo) throw new Error("KLING_MOTION_CONTROL_MISSING_VIDEO");

  const apiMode = safeStr(mode, "pro").toLowerCase() === "std" ? "std" : "pro";
  const rawDuration = Number(duration || 5) || 5;
  const apiDuration = String(Math.max(3, Math.min(10, Math.round(rawDuration))));
  const keepSound = keepOriginalSound !== false ? "yes" : "no";
  const videoReferType = safeStr(
    referType || process.env.MMA_KLING_OMNI_VIDEO_REFERENCE_TYPE,
    "feature"
  );

  const imageList = [];
  if (hasImage) imageList.push({ image_url: image, type: "first_frame" });

  const videoList = [
    {
      video_url: video,
      refer_type: videoReferType,
      keep_original_sound: keepSound,
    },
  ];

  let body = {
    model_name: "kling-v3-omni",
    prompt: safeStr(prompt, ""),
    mode: apiMode,
    duration: apiDuration,
    sound: "off",
    ...(imageList.length ? { image_list: imageList } : { aspect_ratio: "16:9" }),
    video_list: videoList,
  };

  if (forcedInput && typeof forcedInput === "object") {
    body = { ...body, ...forcedInput };
  }

  const endpoint = "/v1/videos/omni-video";
  const queryEndpoint = "/v1/videos/omni-video";

  const createResp = await klingPost(endpoint, body);
  const taskId = createResp?.data?.task_id;
  if (!taskId) {
    throw new Error(`KLING_MC_NO_TASK_ID: ${JSON.stringify(createResp).slice(0, 500)}`);
  }

  const pollResult = await pollKlingTask(queryEndpoint, taskId);
  if (pollResult.timedOut) {
    return {
      input: body,
      out: null,
      task_id: taskId,
      prediction_id: taskId,
      prediction_status: "processing",
      timed_out: true,
      timing: {
        started_at: new Date(t0).toISOString(),
        ended_at: nowIso(),
        duration_ms: Date.now() - t0,
      },
      provider: { kling: { task_id: taskId, status: "processing" } },
    };
  }

  const task = pollResult.task;
  const videoUrl = extractVideoUrl(task);

  return {
    input: body,
    out: videoUrl || null,
    task_id: taskId,
    prediction_id: taskId,
    prediction_status: "succeed",
    timed_out: false,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { kling: task },
  };
}

export async function refreshKlingTask(taskId, type = "video") {
  if (type === "image") {
    try {
      const json = await klingGet(`/v1/images/omni-image/${taskId}`);
      const task = json?.data || {};
      if (task.task_status === "succeed") {
        return { ok: true, status: "succeed", url: extractImageUrl(task), task };
      }
      return { ok: true, status: task.task_status, url: null, task };
    } catch {
      const json = await klingGet(`/v1/images/generations/${taskId}`);
      const task = json?.data || {};
      if (task.task_status === "succeed") {
        return { ok: true, status: "succeed", url: extractImageUrl(task), task };
      }
      return { ok: true, status: task.task_status, url: null, task };
    }
  }

  const videoPaths = ["/v1/videos/omni-video", "/v1/videos/image2video", "/v1/videos/text2video"];
  for (const path of videoPaths) {
    try {
      const json = await klingGet(`${path}/${taskId}`);
      const task = json?.data || {};
      if (task.task_status === "succeed") {
        return { ok: true, status: "succeed", url: extractVideoUrl(task), task };
      }
      if (task.task_status) {
        return { ok: true, status: task.task_status, url: null, task };
      }
    } catch {
      continue;
    }
  }

  return { ok: false, status: "not_found", url: null, task: null };
}

export function klingDirectEnabled() {
  return !!(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY);
}
