# Costs and third parties (MINA) — 2025-12-19

Currency: **USD** unless stated. Region notes: Shopify numbers below are from **Shopify UAE** pricing page (UAE checkout context).  
This file focuses on **what each third party does, why we use it, and what becomes paid as we scale**.

---

## 1) Third parties we use (and why)

### Cloudflare R2 (Object Storage for outputs + inputs)
**What:** Store all user assets (uploads + generated stills + videos) as *non-expiring public URLs* (your “R2 public domain”).  
**Why:** Cheap storage, **no egress fees**, and a clean fit for “MEGA-only: permanent asset URL rule”.  
**Costs (public list):**
- Storage: **$0.015 / GB-month** (Standard), **$0.01 / GB-month** (Infrequent Access)  
- Operations: **Class A $4.50 / million**, **Class B $0.36 / million**  
- Egress: **Free**  
- Free tier: **10 GB-month**, **1M Class A**, **10M Class B / month**  
Source (retrieved 2025-12-19): Cloudflare R2 pricing docs: https://developers.cloudflare.com/r2/pricing/

**What becomes paid later:** after you exceed the free tier, storage and operations become usage-billed.

---

### Render (API hosting)
**What:** Host Mina backend(s) (Node/Express or similar) and any cron/background worker.  
**Why:** Very fast to deploy, easy env vars, good operational defaults.  
**Costs (public list):**
- Platform (seat) plans: **Free $0**, **Developer $19/user/mo**, **Team $29/user/mo**, **Enterprise $99/user/mo** (includes different seat features)  
- Compute instances (Web Services): **Starter $7/mo**, **Standard $25/mo**, **Pro $85/mo**  
- Persistent disk (SSD): **$0.25 / GB-month**  
Source (retrieved 2025-12-19): Render pricing page: https://render.com/pricing

**What becomes paid later:** any always-on backend + additional instances (worker, admin API, etc.).

---

### Supabase (Auth + Postgres DB)
**What:**
- **Auth**: OTP/email login, session management, OAuth, etc.
- **Database**: Postgres for MEGA tables (+ MMA payload/ledger storage).
**Why:** Postgres + auth + policies in one place; fast iteration.
**Costs (public list):**
- **Free**: $0/mo (includes **50,000 MAU**, **500MB DB**, small egress/storage; free projects pause after inactivity)  
- **Pro**: from **$25/mo** (includes **100,000 MAU**, **8GB disk**, **250GB egress**, etc.; overages billed)  
Source (retrieved 2025-12-19): Supabase pricing: https://supabase.com/pricing

**What becomes paid later:** as soon as you need “always-on prod”, larger DB, higher MAU, higher egress, longer logs/backups.

---

### OpenAI (GPT for MMA)
**What:** MMA uses GPT for:
- image scanning + short “human userMessages” while loading
- translating user intent to prompt(s)
- feedback loop prompt rewriting
**Why:** Best-in-class instruction following and vision/text reliability for orchestration.
**Costs (public list, token-based):**
- **gpt-4o-mini** text tokens (per 1M tokens): **$0.15 input**, **$0.60 output** (cached input discounted)  
- **gpt-4.1-mini** text tokens (per 1M tokens): **$0.40 input**, **$1.60 output** (cached input discounted)  
Sources (retrieved 2025-12-19):
- OpenAI pricing page: https://platform.openai.com/pricing
- GPT‑4.1 pricing (OpenAI blog): https://openai.com/index/gpt-4-1/

**What becomes paid later:** token spend rises linearly with usage; caching + batching can reduce cost for repeated contexts.

---

### Replicate (optional model gateway / alternative providers)
**What:** Run ML models through a single API (time-based or I/O-based billing), and/or host your own models.  
**Why:** Lets you add new AIs quickly without building your own GPU infra.  
**Costs (examples, public list):**
- Hardware billed per second/hour (examples): CPU-small **$0.09/hr**, A100 80GB **$5.04/hr**, H100 **$5.49/hr**  
- Some public models are billed per output (e.g., “$0.04 / output image” for some image models)  
Source (retrieved 2025-12-19): Replicate pricing: https://replicate.com/pricing

**What becomes paid later:** anything beyond tiny testing—especially private models (you pay for idle time unless using “fast booting” modes).

---

### Shopify (Top-ups + checkout + invoices)
**What:** Sell credit packs like **MINA‑50** as a Shopify SKU; handle taxes, receipts, payment methods.  
**Why:** Fastest “real money” path + trust + billing history; also clean for subscriptions/discounts later.
**Costs (UAE pricing page):**
- Plan examples (annual billing shown): **Basic $24/mo**, **Grow $69/mo**, **Advanced $299/mo**, **Plus $2,300/mo**  
- Online card rates starting at: **2.9% + AED 1.00** (Basic), **2.8% + AED 1.00** (Grow), **2.7% + AED 1.00** (Advanced)  
- Additional “3rd‑party payment provider” fee (if not using Shopify Payments): **2%** (Basic), **1%** (Grow), **0.6%** (Advanced)  
Source (retrieved 2025-12-19): Shopify UAE pricing page: https://www.shopify.com/ae/pricing

**What becomes paid later:** plan subscription + payment processing fees scale with GMV.

---

### Namecheap (Domain registrar)
**What:** Buy/renew domains (mina-app.com etc).  
**Why:** Simple registrar, decent UX.
**Costs (example):**
- .COM renewal/reactivate (standard): **$16.88** (effective Sep 1, 2024)  
Source (retrieved 2025-12-19): Namecheap blog announcement: https://www.namecheap.com/blog/price-increase-for-com-xyz-and-more-domains/

**What becomes paid later:** domain renewals + any premium DNS/SSL add-ons (optional).

---

### Zoho Mail (Team email)
**What:** Business email (support@, hello@, etc.).  
**Why:** Cheap, good enough, avoids using personal email.
**Costs:**
- Zoho confirms a **Free plan** exists (up to 5 users, 5GB/user, web-only access; availability depends on data center/region)  
Source (retrieved 2025-12-19): Zoho admin help doc: https://www.zoho.com/mail/help/adminconsole/subscription.html

- USD plan prices are **region-dependent** and Zoho’s public pages often render pricing dynamically. An aggregated snapshot (non-official) lists (as of **2025-02-14**):  
  - Mail Lite (10GB): **$1/user/month** (annual)  
  - Mail Premium: **$4/user/month** (annual)  
  Source (retrieved 2025-12-19): PriceTimeline (3rd party): https://pricetimeline.com/data/hosting/zoho-mail-price-history

**What becomes paid later:** once you need IMAP/clients, retention/eDiscovery, more users, etc.

---

### GitHub (source control) + Codex (coding assistant)
**What:**
- GitHub: repos, PRs, issues, CI/CD (GitHub Actions if used)
- Codex: faster engineering throughput (paired with OpenAI pricing above)
**Why:** Standard dev workflow + lower iteration time.
**Cost note:** GitHub has free and paid plans; pricing depends on private repos, seats, and features. (Not expanded here to avoid stale numbers.)

---

## 2) Generation cost model (MINA credits)

**Credit mapping (your spec):**
- **1 still = 1 credit**
- **1 video = 5 credits**
- **MINA‑50** pack = **50 credits** = up to **50 stills** or **10 videos** (or a mix)

**Vendor variable costs you stated (inputs):**
- **Seedream still:** **$0.03 / still**
- **Kling video:** **$0.90 / video**

> Note: GPT overhead + storage ops are additional variable costs (see OpenAI + R2 sections).

---

## 3) Summary table (Now vs future)

Definitions:
- **Fixed on generation** = cost that scales *per still/video/GPT call*.
- **Now Monthly** = what you pay today (often $0 on free tiers).
- **After X Monthly** = after exceeding free tiers / early traction (typical “first paid plan”).
- **After Y Monthly** = scaled stage (team + multi-instance + bigger DB + higher email tier).

| Vendor / bucket | Fixed on generation | Now Monthly | After X Monthly | After Y Monthly |
|---|---:|---:|---:|---:|
| Seedream (still) | **$0.03 / still** (input) | $0 | same (usage) | same (usage) |
| Kling (video) | **$0.90 / video** (input) | $0 | same (usage) | same (usage) |
| OpenAI GPT (MMA) | token-based (e.g. **gpt-4o-mini $0.15/$0.60 per 1M in/out tokens**) | $0 | usage spend | usage spend |
| Cloudflare R2 | storage + ops (see pricing) | **$0** if within free tier | usage billed beyond free tier | higher usage billed |
| Render (hosting) | - | maybe $0 if paused/free | **$7–$85+/mo per service** + seats | multi-service + more instances + seats |
| Supabase (DB+Auth) | - | **$0** on Free | **$25/mo** Pro + overages | larger compute/add-ons |
| Shopify | - | depends on plan (trial promos exist) | plan subscription + payment fees | higher plan + higher GMV fees |
| Zoho Mail | - | possibly $0 (if free plan available in your DC) | $/user/mo | $/user/mo (higher tier) |
| Namecheap | - | $0 (until renewal) | ~$16.88/yr per .com domain | same + extra domains |
| GitHub | - | $0 (if staying on free) | paid seats if needed | paid seats if larger team |

---

## 4) MINA‑50 pricing proposal (single pack)

This is **only variable cost vs price** (ignores infra + GPT + storage ops).

Assumptions:
- MINA‑50 = 50 credits
- Still cost = $0.03
- Video cost = $0.90
- Credits: 1 still=1, 1 video=5

Worst/best-case variable costs per pack:
- **All stills**: 50 × $0.03 = **$1.50**
- **All videos**: 10 × $0.90 = **$9.00**

Recommended retail price: **$14.99** (MINA‑50)

| MINA‑50 Price | Costs % — $ | Profits % — $ |
|---:|---:|---:|
| $14.99 | **10%–60%** (≈$1.50–$9.00) | **40%–90%** (≈$5.99–$13.49) |

---

## 5) What to watch (the “surprise” costs)

- **Payment processing** (Shopify) grows with GMV (it can dwarf infra at scale).
- **GPT tokens** can balloon if prompts become long (add caching + enforce compact schemas).
- **Storage** stays cheap, but **video storage** can grow quickly (R2 storage GB-month).
- **Render** cost grows with always-on instances + concurrency (web + worker split).
- **Supabase** grows with MAU, DB size, and egress if you serve files from Supabase Storage (prefer R2 for assets).
