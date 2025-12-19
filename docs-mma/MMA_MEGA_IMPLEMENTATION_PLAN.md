# MMA/MEGA Implementation Plan (backend)

## Objectives
- Implement Mina Mind API (MMA) pipelines (still + video + tweak loops) end-to-end while preserving existing frontend contracts and routes.
- Migrate persistence to MEGA-only tables per `MEGA_MMA.md`, including audit and error logging.
- Enforce credit debits consistently with legacy pricing while recording ledger entries in MEGA.

## Current State (survey)
- Express server hosts routes such as `/sessions/start`, `/editorial/generate`, `/motion/suggest`, `/motion/generate`, `/feedback/like`, and billing/history admin endpoints. These operate on Supabase through helper layers (`sbEnsureCustomer`, `sbGetCredits`, session persistence) and return JSON shapes already used by the frontend. Key image generation currently runs through `/editorial/generate` and uses Seedream via Replicate; motion generation uses Kling adapters in `/motion/generate`. Credit checks happen before generation and use legacy helpers. Error logging and runtime config fetches already exist but target legacy schemas.
- MEGA helper module (`mega-db.js`) exposes `megaEnsureCustomer`, write helpers for generation/feedback/credit transactions, and parity checks but lacks MMA-specific step/event writers and MMA columns (parent/step/type/status/vars) described in `MEGA_MMA.md`.

## Gaps vs. MMA/MEGA requirements
1. **Schema coverage**: MEGA tables need MMA columns (`mg_parent_id`, `mg_step_no`, `mg_step_type`, `mg_mma_mode`, `mg_mma_status`, `mg_mma_vars`) and customer preference fields (`mg_mma_preferences`, `mg_mma_preferences_updated_at`). Required indexes from MEGA docs are not yet in migrations.
2. **Route compatibility**: MMA introduces new pipelines (`/mma/still/create`, `/mma/still/tweak`, `/mma/video/create`, `/mma/video/tweak`) with step logging and canonical MMA variable map, but current routes are legacy (`/editorial/generate`, `/motion/generate`, etc.). We must add MMA routes while keeping legacy responses intact and adapt MEGA reads to legacy DTOs.
3. **Persistence model**: Current writes mix legacy tables and partial MEGA calls; MMA requires MEGA-only writes (generations, credit txns, mma_step, mma_event, error logs) and storage of permanent public URLs only.
4. **Pipeline orchestration**: MMA step order (scan_product → scan_logo → scan_inspiration → like_history → gpt_reader → seedream_generate → postscan_output_still, etc.) is not encoded. Tweak flows (still/video) and motion suggestion branches are missing.
5. **Error + audit logging**: Need MG_ADMIN error rows with structured payloads and step-level `mg_payload.error` recording; also attach request_id, pass_id, generation_id, step_type, provider/model, ctx_version, and settings_version.
6. **Credit enforcement**: Credits must deduct per mode (still=1, video=5) with ledger writes (`credit_transaction`) and customer balance updates. Behavior on provider failure should be defined (e.g., refund on failure) and kept backward compatible with current insufficient-credit error shape.
7. **Testing + compatibility**: No contract tests exist for legacy routes; MMA happy-path multi-step scenario is untested.

## Proposed changes
1. **Schema migration**
   - Add a single SQL migration under `supabase/migrations` to alter MEGA tables: add MMA fields to `mega_customers` and `mega_generations`, create indexes per `MEGA_MMA.md` and `MEGA_LOGS.md`, and ensure idempotency (IF NOT EXISTS guards).
2. **MEGA repository extension**
   - Expand `mega-db.js` with explicit functions: `ensureCustomer` (alias to `megaEnsureCustomer`), `insertGeneration`, `insertMmaStep`, `insertMmaEvent`, `creditTransaction`, and `errorLog` that write to MEGA tables with namespaced ids. Include helpers for ctx/settings versions and canonical mma_vars persistence.
3. **Route layer**
   - Introduce MMA endpoints (`/mma/still/create`, `/mma/still/tweak`, `/mma/video/create`, `/mma/video/tweak`) that wrap the new orchestration while keeping legacy endpoints untouched. Provide response adapters so legacy routes can read MEGA rows and return existing fields (`ok`, `requestId`, `passId`, `generation`, URLs) without schema drift.
4. **Pipeline orchestration**
   - Implement a coordinator module to run still/video pipelines with step_no increments and write `mma_step` rows for each stage, capturing `{input, output, timing, error}` payloads and ctx/settings identifiers. Persist final `mg_mma_vars` on the generation row using the canonical variable map from `MMA_SPEC.md`.
   - Support tweak loops by creating new generation ids and chaining parent references (`mg_parent_id`) to preserve history.
5. **Credit handling**
   - Centralize credit checks/debits in the MMA handlers: debit 1 credit for still create/tweak and 5 for video create/tweak. Write ledger rows (`mg_record_type='credit_transaction'`) and update customer balance in MEGA. Decide and document rollback (e.g., auto-refund on provider failure) to preserve UX parity.
6. **Error + logging utilities**
   - Build an error utility that logs to `MEGA_ADMIN` with `mg_record_type='error'` and enriches `mma_step` payloads when failures occur. Ensure generation status reflects failure and errors propagate in legacy response format.
7. **Testing**
   - Add contract tests asserting current JSON responses for legacy routes and new MMA endpoints. Include a scripted happy-path test covering still create → 3 tweaks → animate(type_for_me) → 1 tweak → like+download, verifying MEGA ledger writes and credit debits.
8. **Documentation + rollout**
   - Document migration execution, rollout sequence (dev → staging → prod), and verification queries for MEGA parity. Provide Route Compatibility Matrix detailing handlers and response shapes used by the frontend.

## Deliverables
- SQL migration file under `supabase/migrations` with MEGA schema updates and indexes.
- Updated MEGA repository layer with MMA functions and write-path changes in handlers.
- New MMA route handlers plus adapters for legacy routes to consume MEGA data without response changes.
- Error logging utility hooked into routes and pipeline steps.
- Tests for route contracts and MMA happy path.
- Rollout/runbook summarizing deployment steps and verification queries.
