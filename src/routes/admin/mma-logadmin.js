import express from "express";
import { getSupabaseAdmin } from "../../supabase.js";
import { getMmaConfig } from "../mma/mma-config.js";

const router = express.Router();

// ------------------------------------
// Password gate (simple, no Supabase)
// ------------------------------------
// ✅ You asked for this exact password.
// ⚠️ Recommended: set MMA_ADMIN_PASSWORD in env instead of relying on default.
const ADMIN_PASS = process.env.MMA_ADMIN_PASSWORD || "Falta101M";
const COOKIE_NAME = "mma_admin";
const COOKIE_OK_VALUE = "1";

// parse cookies without cookie-parser dependency
function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  raw.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prettyJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function safeEnvSnapshot() {
  // ✅ show only non-secret MMA-related settings
  const pick = (k) => (process.env[k] !== undefined ? String(process.env[k]) : undefined);
  const keys = [
    "NODE_ENV",
    "MMA_SEADREAM_VERSION",
    "MMA_SEADREAM_MODEL_VERSION",
    "MMA_SEADREAM_SIZE",
    "MMA_SEADREAM_ASPECT_RATIO",
    "MMA_SEADREAM_ENHANCE_PROMPT",
    "NEGATIVE_PROMPT_SEADREAM",
    "MMA_NEGATIVE_PROMPT_SEADREAM",
    "MMA_KLING_VERSION",
    "MMA_KLING_MODEL_VERSION",
    "MMA_KLING_MODE",
    "MMA_KLING_DURATION",
    "NEGATIVE_PROMPT_KLING",
    "MMA_NEGATIVE_PROMPT_KLING",
    "R2_PUBLIC_BASE_URL",
    "R2_BUCKET",
  ];

  const out = {};
  for (const k of keys) {
    const v = pick(k);
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function isAuthed(req) {
  // header option (good for curl):
  //   X-MMA-Admin-Pass: Falta101M
  const headerPass = req.headers["x-mma-admin-pass"];
  if (headerPass && String(headerPass) === ADMIN_PASS) return true;

  // cookie option (browser login)
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies[COOKIE_NAME] === COOKIE_OK_VALUE) return true;

  return false;
}

function renderShell(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system; margin: 0; background: #0b0c10; color: #e9eef5; }
    a { color: #a7c7ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 18px; }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom: 16px; }
    .badge { padding: 6px 10px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; font-size: 12px; opacity: .9; }
    .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.10); border-radius: 14px; padding: 14px; margin: 12px 0; }
    .h1 { font-size: 22px; font-weight: 700; }
    .muted { opacity: .7; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid rgba(255,255,255,.10); padding: 10px; vertical-align: top; text-align: left; }
    th { font-weight: 700; opacity: .9; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    details { border: 1px solid rgba(255,255,255,.10); border-radius: 12px; padding: 10px; background: rgba(0,0,0,.20); margin: 10px 0; }
    summary { cursor: pointer; font-weight: 700; }
    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 920px) { .grid2 { grid-template-columns: 1fr; } }
    .btn { display:inline-block; padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.06); color: #fff; }
    .btn:hover { background: rgba(255,255,255,.10); }
    input[type=password] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.3); color: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function renderLoginPage(message = "") {
  return renderShell("MMA Log Admin", `
    <div class="topbar">
      <div class="h1">MMA Log Admin</div>
      <span class="badge">password required</span>
    </div>
    <div class="card">
      <div class="muted" style="margin-bottom:10px;">
        Enter password to view MMA pipeline logs (vars, GPT, Replicate, R2, outputs).
      </div>
      ${message ? `<div class="card" style="border-color: rgba(255,80,80,.3);">${escapeHtml(message)}</div>` : ""}
      <form method="POST" action="/admin/mma/login">
        <label class="muted">Password</label>
        <div style="height:8px;"></div>
        <input type="password" name="password" autocomplete="current-password" />
        <div style="height:12px;"></div>
        <button class="btn" type="submit">Login</button>
      </form>
      <div class="muted" style="margin-top:10px;">
        Tip: for curl, send header <span class="mono">X-MMA-Admin-Pass</span>.
      </div>
    </div>
  `);
}

router.use(express.urlencoded({ extended: false }));

router.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/admin/mma/logs");
  return res.status(200).send(renderLoginPage());
});

router.post("/login", (req, res) => {
  const pw = String(req.body?.password || "");
  if (pw !== ADMIN_PASS) return res.status(401).send(renderLoginPage("Wrong password."));
  // set 1-day cookie
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${COOKIE_OK_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24}`
  );
  return res.redirect("/admin/mma/logs");
});

router.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res.redirect("/admin/mma/login");
});

// ------------------------------------
// LIST: /admin/mma/logs
// ------------------------------------
router.get("/logs", async (req, res) => {
  if (!isAuthed(req)) return res.status(401).redirect("/admin/mma/login");

  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).send("SUPABASE_NOT_CONFIGURED");

  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80) || 80));

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_pass_id, mg_mma_status, mg_status, mg_mma_mode, mg_created_at, mg_output_url, mg_prompt")
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).send(`DB_ERROR: ${escapeHtml(error.message)}`);

  const rows = (data || []).map((r) => ({
    id: r.mg_generation_id,
    passId: r.mg_pass_id,
    status: r.mg_mma_status || r.mg_status,
    mode: r.mg_mma_mode || "",
    createdAt: r.mg_created_at,
    outputUrl: r.mg_output_url || "",
    prompt: r.mg_prompt || "",
  }));

  const table = `
    <div class="topbar">
      <div>
        <div class="h1">MMA Logs</div>
        <div class="muted">Showing latest ${rows.length} generations</div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <a class="btn" href="/admin/mma/logout">Logout</a>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Generation</th>
            <th>Mode</th>
            <th>Status</th>
            <th>PassId</th>
            <th>Output</th>
            <th>Prompt</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r) => {
              const promptShort = r.prompt ? escapeHtml(r.prompt.slice(0, 120) + (r.prompt.length > 120 ? "…" : "")) : "";
              const outLink = r.outputUrl ? `<a href="${escapeHtml(r.outputUrl)}" target="_blank" rel="noreferrer">open</a>` : "—";
              return `
                <tr>
                  <td class="mono">${escapeHtml(r.createdAt || "")}</td>
                  <td><a href="/admin/mma/logs/${escapeHtml(r.id)}">${escapeHtml(r.id)}</a></td>
                  <td>${escapeHtml(r.mode || "")}</td>
                  <td>${escapeHtml(r.status || "")}</td>
                  <td class="mono">${escapeHtml(r.passId || "")}</td>
                  <td>${outLink}</td>
                  <td>${promptShort || "—"}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  return res.status(200).send(renderShell("MMA Logs", table));
});

// ------------------------------------
// DETAIL: /admin/mma/logs/:id
// ------------------------------------
router.get("/logs/:id", async (req, res) => {
  if (!isAuthed(req)) return res.status(401).redirect("/admin/mma/login");

  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).send("SUPABASE_NOT_CONFIGURED");

  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).send("Missing generation id");

  const { data: gen, error: genErr } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", id)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (genErr) return res.status(500).send(`DB_ERROR: ${escapeHtml(genErr.message)}`);
  if (!gen) return res.status(404).send("Not found");

  const { data: steps, error: stepsErr } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", id)
    .eq("mg_record_type", "mma_step")
    .order("mg_step_no", { ascending: true });

  if (stepsErr) return res.status(500).send(`DB_ERROR: ${escapeHtml(stepsErr.message)}`);

  const cfg = getMmaConfig();
  const envSnap = safeEnvSnapshot();

  const summaryTable = `
    <div class="topbar">
      <div>
        <div class="h1">MMA Log Detail</div>
        <div class="muted">generation: <span class="mono">${escapeHtml(id)}</span></div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <a class="btn" href="/admin/mma/logs">Back</a>
        <a class="btn" href="/admin/mma/logout">Logout</a>
      </div>
    </div>

    <div class="card">
      <table>
        <tbody>
          <tr><th>Generation ID</th><td class="mono">${escapeHtml(gen.mg_generation_id)}</td></tr>
          <tr><th>Pass ID</th><td class="mono">${escapeHtml(gen.mg_pass_id || "")}</td></tr>
          <tr><th>Mode</th><td>${escapeHtml(gen.mg_mma_mode || "")}</td></tr>
          <tr><th>Status</th><td>${escapeHtml(gen.mg_mma_status || gen.mg_status || "")}</td></tr>
          <tr><th>Created</th><td class="mono">${escapeHtml(gen.mg_created_at || "")}</td></tr>
          <tr><th>Output URL</th><td>${gen.mg_output_url ? `<a href="${escapeHtml(gen.mg_output_url)}" target="_blank" rel="noreferrer">${escapeHtml(gen.mg_output_url)}</a>` : "—"}</td></tr>
          <tr><th>Final Prompt</th><td class="mono">${escapeHtml(gen.mg_prompt || "")}</td></tr>
          <tr><th>Error</th><td class="mono">${escapeHtml(prettyJson(gen.mg_error || null))}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const configBlock = `
    <div class="grid2">
      <div class="card">
        <div class="h1" style="font-size:16px;">Predefined settings (getMmaConfig)</div>
        <div class="mono">${escapeHtml(prettyJson(cfg))}</div>
      </div>
      <div class="card">
        <div class="h1" style="font-size:16px;">Env snapshot (safe)</div>
        <div class="mono">${escapeHtml(prettyJson(envSnap))}</div>
      </div>
    </div>
  `;

  const varsBlock = `
    <div class="card">
      <div class="h1" style="font-size:16px;">Stored vars (mg_mma_vars)</div>
      <div class="mono">${escapeHtml(prettyJson(gen.mg_mma_vars || {}))}</div>
    </div>
  `;

  const stepsBlock = `
    <div class="card">
      <div class="h1" style="font-size:16px;">Steps (GPT ↔ Replicate ↔ R2)</div>
      ${(steps || [])
        .map((s) => {
          const title = `#${s.mg_step_no || "?"} — ${s.mg_step_type || "step"}`;
          const when = s.mg_created_at || "";
          const payload = s.mg_payload || {};
          return `
            <details>
              <summary>${escapeHtml(title)} <span class="muted">(${escapeHtml(when)})</span></summary>
              <div class="mono" style="margin-top:10px;">${escapeHtml(prettyJson(payload))}</div>
            </details>
          `;
        })
        .join("")}
    </div>
  `;

  return res
    .status(200)
    .send(renderShell(`MMA Log ${id}`, `${summaryTable}${configBlock}${varsBlock}${stepsBlock}`));
});

export default router;
