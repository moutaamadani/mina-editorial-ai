import express from "express";
import crypto from "crypto";
import { getSupabaseAdmin } from "../../supabase.js";
import { getMmaConfig } from "../mma/mma-config.js";

const router = express.Router();

// ---- Config ----
// You asked for password Falta101M.
// ✅ Best practice: set MMA_LOGADMIN_PASSWORD in Render env.
// We default to Falta101M if missing (so it still works).
const PASSWORD = process.env.MMA_LOGADMIN_PASSWORD || "Falta101M";

// MUST set this in prod (Render env) so cookie tokens can’t be forged.
const COOKIE_SECRET =
  process.env.MMA_LOGADMIN_COOKIE_SECRET ||
  process.env.COOKIE_SECRET ||
  "dev_insecure_change_me";

const COOKIE_NAME = "mma_logadmin";

router.use(express.urlencoded({ extended: false }));

// ---- Helpers ----
function isHttps(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return req.secure || xf === "https";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj || "");
  }
}

function hmacSha256(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function signToken(payloadObj) {
  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = hmacSha256(COOKIE_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expected = hmacSha256(COOKIE_SECRET, payloadB64);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function setAuthCookie(res, req) {
  const token = signToken({
    v: 1,
    exp: Date.now() + 1000 * 60 * 60 * 12, // 12h
  });

  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isHttps(req)) flags.push("Secure");

  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  );
}

function isAuthed(req) {
  const token = getCookie(req, COOKIE_NAME);
  return !!verifyToken(token);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect("/admin/mma/login");
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system; margin: 24px; color: #111; }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:16px; }
    .btn { border:1px solid #ddd; background:#fff; padding:8px 12px; border-radius:10px; cursor:pointer; }
    .btn:hover { background:#f7f7f7; }
    .muted { color:#666; }
    table { width:100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 10px 8px; vertical-align: top; }
    th { text-align:left; font-size:12px; color:#666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; white-space: pre-wrap; }
    .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid #ddd; }
    .bad { border-color:#ffb3b3; background:#fff5f5; }
    details { border:1px solid #eee; border-radius:12px; padding:10px; margin:10px 0; }
    summary { cursor:pointer; font-weight:600; }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .card { border:1px solid #eee; border-radius:12px; padding:12px; min-width:320px; flex:1; }
    input[type="text"], input[type="password"] { padding:10px; border:1px solid #ddd; border-radius:10px; width: 320px; }
    .err { color:#b00020; }
    a { color:#0b57d0; text-decoration:none; }
    a:hover { text-decoration:underline; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ---- Routes ----
router.get("/login", (req, res) => {
  const err = req.query.err ? String(req.query.err) : "";
  const html = layout(
    "MMA LogAdmin Login",
    `
    <div class="topbar">
      <h2>MMA LogAdmin</h2>
      <div class="muted">Backend: mina-editorial-ai-api</div>
    </div>

    <form method="POST" action="/admin/mma/login">
      <div style="margin:12px 0;">
        <label class="muted">Password</label><br/>
        <input type="password" name="password" placeholder="Password" />
      </div>
      ${err ? `<div class="err">${escapeHtml(err)}</div>` : ""}
      <button class="btn" type="submit">Login</button>
    </form>
  `
  );
  res.status(200).send(html);
});

router.post("/login", (req, res) => {
  const pw = String(req.body?.password || "");
  if (pw !== PASSWORD) return res.redirect("/admin/mma/login?err=Wrong%20password");
  setAuthCookie(res, req);
  return res.redirect("/admin/mma");
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  return res.redirect("/admin/mma/login");
});

router.get("/", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
  }

  const passId = (req.query.passId ? String(req.query.passId) : "").trim();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

  let q = supabase
    .from("mega_generations")
    .select(
      "mg_generation_id, mg_pass_id, mg_parent_id, mg_mma_mode, mg_mma_status, mg_status, mg_output_url, mg_prompt, mg_created_at"
    )
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (passId) q = q.eq("mg_pass_id", passId);

  const { data, error } = await q;
  if (error) {
    return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(error.message)}</div>`));
  }

  const rows = (data || []).map((g) => {
    const gid = g.mg_generation_id;
    const status = g.mg_mma_status || g.mg_status || "—";
    const mode = g.mg_mma_mode || "—";
    const out = g.mg_output_url || "";
    const badUrl =
      out && !String(out).includes("assets.faltastudio.com") && !String(out).includes("r2") ? "bad" : "";

    return `
      <tr>
        <td class="mono">${escapeHtml(g.mg_created_at || "")}</td>
        <td><span class="tag">${escapeHtml(status)}</span></td>
        <td><span class="tag">${escapeHtml(mode)}</span></td>
        <td class="mono">${escapeHtml(g.mg_pass_id || "")}</td>
        <td class="mono">${escapeHtml(g.mg_parent_id || "")}</td>
        <td class="mono ${badUrl}">
          ${out ? `<a href="${escapeHtml(out)}" target="_blank" rel="noreferrer">${escapeHtml(out)}</a>` : "—"}
          ${badUrl ? `<div class="muted">⚠️ not assets.faltastudio.com</div>` : ""}
        </td>
        <td class="mono">${escapeHtml(String(g.mg_prompt || "").slice(0, 160))}${String(g.mg_prompt || "").length > 160 ? "…" : ""}</td>
        <td><a href="/admin/mma/generation/${encodeURIComponent(gid)}">Open</a></td>
      </tr>
    `;
  });

  const html = layout(
    "MMA LogAdmin",
    `
    <div class="topbar">
      <div>
        <h2 style="margin:0;">MMA LogAdmin</h2>
        <div class="muted">Shows: inputs → GPT prompts → Replicate → R2 output → final</div>
      </div>
      <form method="POST" action="/admin/mma/logout">
        <button class="btn" type="submit">Logout</button>
      </form>
    </div>

    <form method="GET" action="/admin/mma" style="margin: 0 0 16px 0;">
      <input type="text" name="passId" value="${escapeHtml(passId)}" placeholder="Filter by passId (optional)" />
      <input type="text" name="limit" value="${escapeHtml(String(limit))}" style="width:90px;" />
      <button class="btn" type="submit">Apply</button>
      <a class="btn" href="/admin/mma" style="display:inline-block;">Reset</a>
    </form>

    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>Status</th>
          <th>Mode</th>
          <th>Pass</th>
          <th>Parent</th>
          <th>Output URL</th>
          <th>Prompt (snippet)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.join("\n")}
      </tbody>
    </table>
  `
  );

  res.status(200).send(html);
});

router.get("/generation/:id", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
  }

  const id = String(req.params.id || "").trim();
  if (!id) return res.redirect("/admin/mma");

  const { data: gen, error: genErr } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  if (genErr || !gen) {
    return res.status(404).send(layout("Not found", `<div class="err">Generation not found.</div>`));
  }

  const { data: steps, error: stepsErr } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  if (stepsErr) {
    return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(stepsErr.message)}</div>`));
  }

  const cfg = getMmaConfig();
  const vars = gen.mg_mma_vars || {};

  const stepsRows = (steps || []).map((s) => {
    const p = s.mg_payload || {};
    const timing = p?.timing || {};
    const started = timing.started_at || "";
    const ended = timing.ended_at || "";
    const dur = timing.duration_ms != null ? `${timing.duration_ms}ms` : "";
    return `
      <tr>
        <td class="mono">${escapeHtml(String(s.mg_step_no ?? ""))}</td>
        <td class="mono">${escapeHtml(s.mg_step_type || "")}</td>
        <td class="mono">${escapeHtml(started)}</td>
        <td class="mono">${escapeHtml(ended)}</td>
        <td class="mono">${escapeHtml(dur)}</td>
        <td>
          <details>
            <summary>View payload</summary>
            <pre class="mono">${escapeHtml(prettyJson(p))}</pre>
          </details>
        </td>
      </tr>
    `;
  });

  const out = String(gen.mg_output_url || "");
  const badUrl =
    out && !out.includes("assets.faltastudio.com") && !out.includes("r2") ? "bad" : "";

  const html = layout(
    `MMA Generation ${id}`,
    `
    <div class="topbar">
      <div>
        <a href="/admin/mma">← Back</a>
        <h2 style="margin:8px 0 0 0;">Generation: <span class="mono">${escapeHtml(id)}</span></h2>
        <div class="muted">Pass: <span class="mono">${escapeHtml(gen.mg_pass_id || "")}</span></div>
      </div>
      <div style="display:flex; gap:10px;">
        <a class="btn" href="/admin/mma/generation/${encodeURIComponent(id)}.json">Download JSON</a>
        <form method="POST" action="/admin/mma/logout" style="margin:0;">
          <button class="btn" type="submit">Logout</button>
        </form>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <div><b>Status:</b> <span class="tag">${escapeHtml(gen.mg_mma_status || gen.mg_status || "—")}</span></div>
        <div><b>Mode:</b> <span class="tag">${escapeHtml(gen.mg_mma_mode || "—")}</span></div>
        <div><b>Created:</b> <span class="mono">${escapeHtml(gen.mg_created_at || "")}</span></div>
        <div><b>Parent:</b> <span class="mono">${escapeHtml(gen.mg_parent_id || "")}</span></div>
        <div style="margin-top:10px;"><b>Output URL:</b></div>
        <div class="mono ${badUrl}">
          ${out ? `<a href="${escapeHtml(out)}" target="_blank" rel="noreferrer">${escapeHtml(out)}</a>` : "—"}
          ${badUrl ? `<div class="muted">⚠️ not assets.faltastudio.com (check R2_PUBLIC_BASE_URL)</div>` : ""}
        </div>
        ${gen.mg_error ? `<details><summary>Error</summary><pre class="mono">${escapeHtml(prettyJson(gen.mg_error))}</pre></details>` : ""}
      </div>

      <div class="card">
        <div><b>Final prompt</b></div>
        <pre class="mono">${escapeHtml(gen.mg_prompt || "")}</pre>
      </div>
    </div>

    <details open>
      <summary>MMA Vars (inputs/assets/settings/prompts/outputs)</summary>
      <pre class="mono">${escapeHtml(prettyJson(vars))}</pre>
    </details>

    <details>
      <summary>MMA Config snapshot (current runtime)</summary>
      <pre class="mono">${escapeHtml(prettyJson(cfg))}</pre>
    </details>

    <h3>Steps</h3>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Type</th>
          <th>Started</th>
          <th>Ended</th>
          <th>Duration</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody>
        ${stepsRows.join("\n")}
      </tbody>
    </table>
  `
  );

  res.status(200).send(html);
});

router.get("/generation/:id.json", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  const id = String(req.params.id || "").trim();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const { data: gen } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  const { data: steps } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  const cfg = getMmaConfig();
  return res.json({ ok: true, generation: gen || null, steps: steps || [], mma_config: cfg });
});

export default router;
