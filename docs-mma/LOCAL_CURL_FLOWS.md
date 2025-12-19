# Local MMA curl flows (current container)

## Required environment
Set the following before starting the API:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the PostgREST endpoint used by MEGA tables.【F:server.js†L74-L103】
- `OPENAI_API_KEY` for the GPT client; the server exits early when the key is missing.【F:server.js†L1673-L1683】【c15358†L1-L14】
- `REPLICATE_API_TOKEN` for SeaDream/Kling calls.【F:server.js†L1673-L1684】
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and optionally `R2_ENDPOINT`/`R2_PUBLIC_BASE_URL` for Cloudflare R2 storage helpers.【F:r2.js†L15-L86】

Example exports used for these runs (Supabase and R2 hosts were not reachable in the container):

```bash
export OPENAI_API_KEY=dummy
export REPLICATE_API_TOKEN=dummy
export SUPABASE_URL=http://localhost:54321
export SUPABASE_SERVICE_ROLE_KEY=dummy
export R2_ENDPOINT=http://localhost:9000
export R2_ACCESS_KEY_ID=dummy
export R2_SECRET_ACCESS_KEY=dummy
export R2_BUCKET=test
export R2_PUBLIC_BASE_URL=http://localhost:9000/test
node server.js
```

The server boots with the dummy values, but every call that touches Supabase fails with `fetch failed` because no database is listening on port 54321.【153fda†L1-L8】【34b32a†L1-L37】

## Still image: create → stream → fetch

```bash
curl -i -X POST http://localhost:3000/mma/still/create \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"demo-shopify","assets":{"product_image_id":"https://example.com/product.png"},"inputs":{"prompt":"Test still"}}'
```
Response: `500` with `MMA_STILL_CREATE_ERROR` and `TypeError: fetch failed` because Supabase was unreachable.【8fc619†L1-L12】

```bash
curl -i http://localhost:3000/mma/stream/test-gen
```
SSE response immediately returns an `error` event with `TypeError: fetch failed`.【1db1be†L1-L12】

```bash
curl -i http://localhost:3000/mma/generations/test-gen
```
Response: `500` `MMA_GENERATION_FETCH_ERROR` with the same fetch failure message.【922ab2†L1-L11】

## Video: animate → fetch

```bash
curl -i -X POST http://localhost:3000/mma/video/animate \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"demo-shopify","assets":{"input_still_image_id":"https://example.com/still.png"},"inputs":{"prompt":"Animate sample"}}'
```
Response: `500` with `MMA_VIDEO_ANIMATE_ERROR` and `TypeError: fetch failed`.【065656†L1-L11】

```bash
curl -i http://localhost:3000/mma/generations/video-test
```
Response: `500` `MMA_GENERATION_FETCH_ERROR` with the fetch failure message.【3dd361†L1-L11】

## Preference event

```bash
curl -i -X POST http://localhost:3000/mma/events \
  -H "Content-Type: application/json" \
  -d '{"event_type":"preference_set","payload":{"style":"bold"}}'
```
Response: `500` `MMA_EVENT_ERROR` with the same Supabase fetch failure details.【ce3263†L1-L11】

## Failure path notes
- Because Supabase was unreachable, the API could not persist `mega_admin` error rows or generation status updates; requests bubble up as `TypeError: fetch failed` errors instead.【34b32a†L1-L37】
- The SSE stream shows `error` status immediately, which is the closest available signal to a generation error status in this environment.【1db1be†L1-L12】
