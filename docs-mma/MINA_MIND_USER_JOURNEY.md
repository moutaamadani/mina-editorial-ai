# MINA Mind — Plain-English User Journey + Scenario Schema (Image → 3 Tweaks → Animate “Type for me” → 1 Tweak → Like + Download)

**Date:** 2025-12-19 (Asia/Dubai)  
**Audience:** Product + Frontend + Backend (no prompt-engineering required)  
**Goal:** Explain **how Mina Mind works for users**, then show a **complete scenario schema** with **all key “ifs”** and what MINA/MMA does at each step.

---

## 1) How Mina Mind works (plain English)

When someone uses MINA, **Mina Mind** is the brain that does three things:

1) **Understands what the user gave you**
- If they upload images, Mina Mind “reads” them and understands what’s inside (product, logo, inspiration style).
- If they don’t upload images, Mina Mind skips scanning and uses only text.

2) **Learns the user’s taste automatically**
- Mina Mind checks what the user liked/downloaded recently.
- If the user dislikes something strongly (example: “no light movements ever”), Mina Mind remembers it and avoids it in the future.

3) **Translates the user’s intent into the right prompt for the right AI**
- The user writes normal human language.
- Mina Mind writes the real “clean prompt” adapted to Seedream/Kling (and future AIs).

While the system is working, Mina Mind generates **friendly userMessages** so the user feels guided instead of waiting on a blank loader.

Everything is saved for later:
- what the user uploaded
- what Mina Mind understood
- the prompt that was sent to the AI
- the settings used
- what was generated
- what the user liked/disliked

This makes MINA both **personalized** and **debuggable**.

---

## 2) Scenario: User journey you asked for (one concrete story)

**Scenario:** User creates a still image → does **3 feedback tweaks** → then animates that final still with **“Type for me”** → does **1 motion tweak** → then **Likes** and **Downloads**.

### User actions (what they click)
1) Upload product image + optional logo + up to 4 inspirations
2) Type a brief + pick a style → click **Create**
3) Provide feedback 1 → click **Tweak**
4) Provide feedback 2 → click **Tweak**
5) Provide feedback 3 → click **Tweak**
6) Click **Animate this** on the latest still
7) Choose movement style + type a motion brief + toggle **Type for me** → click **Animate**
8) Provide motion feedback 1 → click **Tweak**
9) Click **Like**
10) Click **Download**

---

## 3) All “IFs” (decision points Mina Mind handles)

### 3.1 Input asset IFs (scanning)
- **IF** product image uploaded → run `scan_product` → store `product_crt`
- **IF** logo image uploaded → run `scan_logo` → store `logo_crt`
- **IF** inspiration images uploaded → run `scan_inspiration` → store `inspiration_crt[]`
- **IF** none uploaded → skip all scans (still works from text only)

### 3.2 Like history IFs (personalization)
- **IF** “vision intelligence” toggle ON → scan last **5** liked/downloaded items (images + prompts)
- **IF** “vision intelligence” toggle OFF → scan last **20** liked/downloaded items (images only)
- Output becomes `style_history_csv` (preferences tags)

### 3.3 Prompt building IFs
- **IF** user has hard blocks (example: “no light movements”) → Mina Mind injects constraints into prompts/settings
- **IF** provider changes (Seedream vs other) → prompt format adapts via provider context/presets

### 3.4 Animate flow IFs (“Type for me”)
- **IF** user enabled “Type for me”:
  - run `motion_suggestion` to create a simple motion prompt
  - Kling gets `motion_sugg_prompt`
- **ELSE**:
  - run `gpt_reader_motion` to produce a more direct Kling motion prompt
  - Kling gets `motion_prompt`

### 3.5 Tweak IFs
- **IF** tweak still:
  - use previous output image + its caption + feedback text → build new prompt → regenerate still
- **IF** tweak motion:
  - use previous motion prompt + feedback → build new motion prompt → regenerate video

---

## 4) Schema: end-to-end journey (Mermaid flow)

```mermaid
flowchart TD
  A[User: Create Still] --> B{Has product image?}
  B -- Yes --> B1[scan_product -> product_crt + scan line]
  B -- No --> C{Has logo image?}
  B1 --> C{Has logo image?}
  C -- Yes --> C1[scan_logo -> logo_crt + scan line]
  C -- No --> D{Has inspiration images?}
  C1 --> D{Has inspiration images?}
  D -- Yes --> D1[scan_inspiration -> inspiration_crt[] + scan lines]
  D -- No --> E{Vision intelligence ON?}
  D1 --> E{Vision intelligence ON?}
  E -- Yes --> E1[like_history(window=5) -> style_history_csv]
  E -- No --> E2[like_history(window=20) -> style_history_csv]
  E1 --> F[gpt_reader -> clean_prompt + final userMessage]
  E2 --> F[gpt_reader -> clean_prompt + final userMessage]
  F --> G[seedream_generate -> still image]
  G --> H[postscan_output_still -> output_still_crt]
  H --> I[User: Tweak Still #1]
  I --> J[gpt_feedback_still -> prompt]
  J --> K[seedream_generate_feedback -> still image v2]
  K --> L[postscan_output_still_feedback]
  L --> M[User: Tweak Still #2]
  M --> J2[gpt_feedback_still -> prompt]
  J2 --> K2[seedream_generate_feedback -> still image v3]
  K2 --> L2[postscan_output_still_feedback]
  L2 --> N[User: Tweak Still #3]
  N --> J3[gpt_feedback_still -> prompt]
  J3 --> K3[seedream_generate_feedback -> still image v4]
  K3 --> O[postscan_output_still_feedback]
  O --> P[User: Animate this]
  P --> Q[scan_input_still (if missing) -> still_crt + scan line]
  Q --> R{Type for me ON?}
  R -- Yes --> R1[motion_suggestion -> motion_sugg_prompt]
  R -- No --> R2[gpt_reader_motion -> motion_prompt]
  R1 --> S[kling_generate -> video v1]
  R2 --> S[kling_generate -> video v1]
  S --> T[User: Tweak Motion #1]
  T --> U[gpt_feedback_motion -> motion prompt v2]
  U --> V[kling_generate_feedback -> video v2]
  V --> W[User: Like]
  W --> X[mma_event: like]
  X --> Y[User: Download]
  Y --> Z[mma_event: download]
```

---

## 5) Schema: what MEGA stores at each action (MEGA-only summary)

Below is the **minimum** MEGA write pattern to cover the scenario.

### 5.1 Still creation (first create)
**Write 1 generation row**
- `MEGA_GENERATIONS`:
  - `mg_id = generation:<gen1>`
  - `mg_record_type = generation`
  - `mg_provider = seedream`
  - `mg_output_url = <final image url>` (after complete)
  - `mg_mma_vars = { full variable map }`
  - `mg_mma_status = done|error`

**Write N step rows**
- `MEGA_GENERATIONS` step rows:
  - `mg_id = mma_step:<gen1>:<step_no>`
  - `mg_record_type = mma_step`
  - `mg_generation_id = <gen1>`
  - `mg_step_type = scan_product|scan_logo|...|gpt_reader|seedream_generate|postscan_output_still`
  - `mg_payload.input` / `mg_payload.output` (includes ctx_version + settings_version when used)

### 5.2 3 still tweaks
Recommended: **new generation id per tweak** (immutable history).
- `gen2` tweak #1
- `gen3` tweak #2
- `gen4` tweak #3 (this is the still you animate)

Each tweak writes:
- 1 generation row (`generation:<genN>`)
- step rows including:
  - `gpt_feedback_still`
  - `seedream_generate_feedback`
  - `postscan_output_still_feedback`

### 5.3 Animate (Type for me)
Recommended: new generation id for video:
- `vid1` (video result)

Writes:
- generation row `generation:<vid1>` with `mg_provider=kling`, `mg_type=motion`, `mg_output_url=<video>`
- step rows including:
  - `scan_input_still` (if still_crt missing)
  - `motion_suggestion` (only if type_for_me=ON)
  - `kling_generate`

### 5.4 Motion tweak (1 time)
Recommended: new generation id for tweak video:
- `vid2` (video tweaked)

Writes:
- generation row `generation:<vid2>`
- step rows including:
  - `gpt_feedback_motion`
  - `kling_generate_feedback`

### 5.5 Like + Download
Write 2 event rows as ledger entries:
- `MEGA_GENERATIONS`:
  - `mg_record_type = mma_event`
  - `mg_id = mma_event:<event_id>`
  - `mg_meta.event_type = like`
  - `mg_generation_id = <vid2>` (or the artifact they liked)
- same for `download`

Also update preference snapshot (optional but recommended):
- `MEGA_CUSTOMERS.mg_mma_preferences` updated if dislike/preference_set occurs (like/download may adjust weights).

---

## 6) “Exact read” cheat-sheet for the scenario (common questions)

### 6.1 “What was Input_gpt_reader for the first create?”
Read:
- Table: `MEGA_GENERATIONS`
- Row filter:
  - `mg_record_type='mma_step'`
  - `mg_generation_id = <gen1>`
  - `mg_step_type='gpt_reader'`
- JSON path:
  - `mg_payload.input.input_gpt_reader`
  - (optional) `mg_payload.input.parts`

### 6.2 “What prompt did we send to Seedream on tweak #2?”
Read:
- `mg_generation_id=<gen3>`
- `mg_step_type='seedream_generate_feedback'`
- JSON path:
  - `mg_payload.input.prompt`

### 6.3 “Did the user use Type for me on the animation?”
Read:
- `mg_generation_id=<vid1>`
- check if a step exists:
  - `mg_step_type='motion_suggestion'`
If yes → Type for me was ON.

### 6.4 “What was the motion prompt sent to Kling after the tweak?”
Read:
- `mg_generation_id=<vid2>`
- `mg_step_type='kling_generate_feedback'`
- JSON path:
  - `mg_payload.input.prompt` (or `motion_prompt` depending on your contract)

---

## 7) Recommended stable step_type names (string contract)

**Still create**
- `scan_product`
- `scan_logo`
- `scan_inspiration`
- `like_history`
- `gpt_reader`
- `seedream_generate`
- `postscan_output_still`

**Still tweak**
- `gpt_feedback_still`
- `seedream_generate_feedback`
- `postscan_output_still_feedback`

**Video animate**
- `scan_input_still`
- `motion_suggestion` (Type for me only)
- `gpt_reader_motion` (if Type for me is OFF)
- `kling_generate`
- `postscan_output_video` (optional)

**Video tweak**
- `gpt_feedback_motion`
- `kling_generate_feedback`
- `postscan_output_video_feedback` (optional)

---

## 8) Frontend API call sequence (simple)
This is the minimum call sequence for the scenario:

1) `POST /mma/still/create` → returns `{generation_id: gen1, sse_url}`
2) `POST /mma/still/{gen1}/tweak` → returns `{generation_id: gen2}`
3) `POST /mma/still/{gen2}/tweak` → returns `{generation_id: gen3}`
4) `POST /mma/still/{gen3}/tweak` → returns `{generation_id: gen4}`
5) `POST /mma/video/animate` (input_still_image_id = gen4 output, type_for_me=true) → returns `{generation_id: vid1}`
6) `POST /mma/video/{vid1}/tweak` → returns `{generation_id: vid2}`
7) `POST /mma/events` with `{event_type: "like", generation_id: vid2}`
8) `POST /mma/events` with `{event_type: "download", generation_id: vid2}`

---

## 9) What the user sees (UX summary)
- While scanning: friendly lines appear (userMessages)
- After generate: final image appears
- Each tweak: image updates (v2, v3, v4)
- Animate: video appears
- Motion tweak: video updates
- Like/download: stored, and future results adapt to their preferences

---
