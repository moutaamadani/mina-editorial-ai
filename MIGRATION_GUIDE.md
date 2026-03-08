# Kling Direct API Migration Guide

## How to switch from Replicate to Kling Direct API

1. Add `server/mma/kling-direct.js`.
2. Set required env vars:

```env
KLING_ACCESS_KEY=your_access_key_here
KLING_SECRET_KEY=your_secret_key_here
```

Optional env vars:

```env
KLING_API_BASE_URL=https://api-singapore.klingai.com
KLING_POLL_MS=3000
KLING_MAX_POLL_MS=900000
```

## What was changed in `mma-controller.js`

- Added imports from `./kling-direct.js`.
- `runKling()` now checks `klingDirectEnabled()` and uses `runKlingDirect()` before falling back to Replicate.
- `runKlingMotionControl()` now checks `klingDirectEnabled()` and uses `runKlingMotionControlDirect()` before falling back to Replicate.
- `refreshFromReplicate()` now checks stored Kling `task_id` values and refreshes via `refreshKlingTask()`.
- Video pipelines now store both legacy `prediction_id` and direct `task_id` values for recovery:
  - `kling_task_id`
  - `kling_motion_control_task_id`

## Key parameter mappings

| Existing usage | Kling direct usage |
|---|---|
| `start_image` | `image` (image2video) or `image_list` (omni) |
| `end_image` | `image_tail` (image2video) or `image_list` (omni) |
| `generate_audio: true` | `sound: "on"` |
| `duration: 5` | `duration: "5"` |
| motion-control model | omni-video `video_list` |

## Notes

- Return shape from direct functions is kept compatible (`input`, `out`, `prediction_id`, `timed_out`, `timing`, `provider`) and also includes `task_id`.
- Existing SSE/status/credits/database flow remains unchanged.
