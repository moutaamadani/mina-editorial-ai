# Kling AI Series 3.0 — Model Capability, Inputs, and Pricing Summary

> Based on the specification text you provided. This file is formatted for GitHub Markdown and optimized around your rule: **always choose the highest quality available**.

---

## Best default choices

| Need | Best model | Best quality setting | Why |
|---|---|---|---|
| Most flexible video generation | `kling-v3-omni` | `mode: pro` | Best mixed-input video model: text, images, elements, video reference, start/end frame, multi-shot |
| Best standard video model with voice options | `kling-v3` | `mode: pro` | Supports text-to-video and image-to-video, multi-shot, and voice/native audio billing paths |
| Best image generation overall | `kling-v3-omni` | `resolution: 4k` | Highest image quality in the spec, plus text/image/element support and series generation |
| Simpler image generation | `kling-image-o1` | intelligent aspect ratio | Good image model, but less flexible than omni |
| Legacy/simple image generation | `kling-v3` | `resolution: 2k` | More limited than omni |

---

## Video models summary

| Model | API endpoint | Main input types | Capabilities | Highest quality available | Price in provided spec |
|---|---|---|---|---|---|
| `kling-v3-omni` | `/v1/videos/omni-video` | text prompt, `image_list`, `element_list`, `video_list` | text-to-video, image-to-video, single-shot, multi-shot, start/end frame, element control, reference video | `mode: pro` (1080p) | Yes |
| `kling-video-o1` | `/v1/videos/omni-video` | same Omni endpoint inputs | text-to-video single-shot only, image-to-video single-shot, start/end frame, limited element/video reference | `mode: pro` (1080p) | No price shown |
| `kling-v3` | `/v1/videos/text2video` and `/v1/videos/image2video` | text prompt; or `image` / `image_tail`; optional `element_list`, `voice_list` | text-to-video, image-to-video, single-shot, multi-shot, start/end frame, element control, voice/native audio path | `mode: pro` (1080p) | Yes |

---

## Image models summary

| Model | API endpoint | Main input types | Capabilities | Highest quality available | Price in provided spec |
|---|---|---|---|---|---|
| `kling-v3-omni` | `/v1/images/omni-image` | text prompt, `image_list`, `element_list` | text-to-image, image-to-image, single image, series image, element control | `resolution: 4k` | Yes (listed as **Kolors Image-3O**) |
| `kling-image-o1` | `/v1/images/omni-image` | text prompt, `image_list`, `element_list` | text-to-image, image-to-image, element control; less flexible than omni | intelligent aspect ratio | No price shown |
| `kling-v3` | `/v1/images/generations` | text prompt, optional `image`, optional `element_list` | text-to-image, limited image-to-image, limited element control | `resolution: 2k` | Yes (listed as **Kolors V3.0**) |

---

# 1) Detailed model tables

## A. `kling-v3-omni` video

**Endpoint:** `/v1/videos/omni-video`

| Category | Details |
|---|---|
| Best for | Most advanced video workflow |
| Main inputs | `prompt`, `multi_prompt`, `image_list`, `element_list`, `video_list`, `sound`, `mode`, `aspect_ratio`, `duration` |
| Accepts | Text, reference images, elements, reference/edit video |
| Text-to-video | Yes |
| Image-to-video | Yes |
| Multi-shot | Yes |
| Start/end frame | Yes |
| Element control | Yes |
| Reference video | Yes, only `3s–10s` |
| Voice control | No |
| Best quality | `mode: pro` |
| Output quality | `std = 720p`, `pro = 1080p` |
| Duration | `3–15s` |
| Aspect ratio | `16:9`, `9:16`, `1:1` |
| Important limits | Image <= 10MB; video <= 200MB; 1 video max; some features are mutually exclusive when using video input |

### `kling-v3-omni` video pricing

**Per 1 second of output video**

| Scenario | Units | Price |
|---|---:|---:|
| Std, no video input, no native audio | 0.6 | $0.084 |
| Std, no video input, with native audio | 0.8 | $0.112 |
| Std, with video input, no native audio | 0.9 | $0.126 |
| Std, with video input, with native audio | 1.1 | $0.154 |
| Pro, no video input, no native audio | 0.8 | $0.112 |
| Pro, no video input, with native audio | 1.0 | $0.140 |
| Pro, with video input, no native audio | 1.2 | $0.168 |
| Pro, with video input, with native audio | 1.4 | $0.196 |

### Recommended default

```json
{
  "model_name": "kling-v3-omni",
  "mode": "pro"
}
```

---

## B. `kling-video-o1` video

**Endpoint:** `/v1/videos/omni-video`

| Category | Details |
|---|---|
| Best for | Older/simpler omni workflow |
| Main inputs | Same Omni endpoint structure: `prompt`, `image_list`, `element_list`, `video_list`, `mode`, `duration`, etc. |
| Text-to-video | Yes, single-shot only |
| Image-to-video | Yes, single-shot only |
| Start/end frame | Yes |
| Element control | Yes, but only multi-image elements |
| Video reference | Yes |
| Voice control | No |
| Best quality | `mode: pro` |
| Output quality | `std = 720p`, `pro = 1080p` |
| Duration | `3–10s`, but text-to-video single-shot only supports `5s` or `10s` |
| Pricing | Not provided in the pasted excerpt |

### Recommended usage

Use only if you specifically need compatibility with this model family. Otherwise, `kling-v3-omni` is stronger.

---

## C. `kling-v3` text-to-video

**Endpoint:** `/v1/videos/text2video`

| Category | Details |
|---|---|
| Best for | Strong standard text-to-video with optional voice/native audio |
| Main inputs | `prompt`, `negative_prompt`, `multi_prompt`, `voice_list`, `sound`, `mode`, `aspect_ratio`, `duration` |
| Text-to-video | Yes |
| Multi-shot | Yes |
| Intelligent shot split | Yes (`multi_shot: intelligence` is mentioned in the update record) |
| Voice control | Supported through `voice_list` + `<<<voice_1>>>` in prompt |
| Best quality | `mode: pro` |
| Output quality | `std = 720p`, `pro = 1080p` |
| Duration | `3–15s` |
| Aspect ratio | `16:9`, `9:16`, `1:1` |

### `kling-v3` video pricing

**Per 1 second of output video**

| Scenario | Units | Price |
|---|---:|---:|
| Std, no native audio | 0.6 | $0.084 |
| Std, with native audio, without voice control | 0.9 | $0.126 |
| Std, with native audio, with voice control | 1.1 | $0.154 |
| Pro, no native audio | 0.8 | $0.112 |
| Pro, with native audio, without voice control | 1.2 | $0.168 |
| Pro, with native audio, with voice control | 1.4 | $0.196 |
| Motion Control, std | 0.9 | $0.126 |
| Motion Control, pro | 1.2 | $0.168 |

### Recommended defaults

Without speech:

```json
{
  "model_name": "kling-v3",
  "mode": "pro",
  "sound": "off"
}
```

With speech / audio:

```json
{
  "model_name": "kling-v3",
  "mode": "pro",
  "sound": "on"
}
```

---

## D. `kling-v3` image-to-video

**Endpoint:** `/v1/videos/image2video`

| Category | Details |
|---|---|
| Best for | Turning one or two images into video with prompt guidance |
| Main inputs | `image`, `image_tail`, `prompt`, `negative_prompt`, `multi_prompt`, `element_list`, `voice_list`, `sound`, `mode`, `duration` |
| Image-to-video | Yes |
| Multi-shot | Yes |
| Start/end frame | Yes |
| Element control | Yes |
| Voice path | Yes, but `element_list` and `voice_list` are described as mutually exclusive in the parameter notes |
| Best quality | `mode: pro` |
| Output quality | `std = 720p`, `pro = 1080p` |
| Duration | `3–15s` |
| Important limits | At least one of `image` or `image_tail` is required; image/image_tail <= 10MB |

### Pricing

Pricing is grouped under **Kling V3.0** video pricing above.

---

## E. `kling-v3-omni` image

**Endpoint:** `/v1/images/omni-image`

| Category | Details |
|---|---|
| Best for | Best overall image generation |
| Main inputs | `prompt`, `image_list`, `element_list`, `resolution`, `result_type`, `n`, `series_amount`, `aspect_ratio` |
| Text-to-image | Yes |
| Image-to-image | Yes |
| Series image generation | Yes |
| Element control | Yes |
| Best quality | `resolution: 4k` |
| Resolutions | `1k`, `2k`, `4k` |
| Aspect ratio | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `auto` |
| Max outputs | `n: 1–9`; `series_amount: 2–9` |

### `kling-v3-omni` image pricing

Listed in the spec as **Kolors Image-3O**.

| Resolution | Units | Price |
|---|---:|---:|
| 1K / 2K | 8 | $0.028 |
| 4K | 16 | $0.056 |

### Recommended default

```json
{
  "model_name": "kling-v3-omni",
  "resolution": "4k"
}
```

---

## F. `kling-image-o1` image

**Endpoint:** `/v1/images/omni-image`

| Category | Details |
|---|---|
| Best for | Mid-tier omni image generation |
| Main inputs | `prompt`, `image_list`, `element_list`, `aspect_ratio`, `result_type`, `n` |
| Text-to-image | Yes, only on the custom aspect ratio side |
| Image-to-image | Yes |
| Element control | Yes, only multi-image elements |
| Best quality | intelligent aspect ratio |
| Pricing | Not provided in the pasted excerpt |

---

## G. `kling-v3` image

**Endpoint:** `/v1/images/generations`

| Category | Details |
|---|---|
| Best for | Simpler non-omni image generation |
| Main inputs | `prompt`, `negative_prompt`, `image`, `element_list`, `resolution`, `n`, `aspect_ratio` |
| Text-to-image | Yes |
| Image-to-image | Limited |
| Element control | Limited |
| Best quality | `resolution: 2k` |
| Resolutions | `1k`, `2k` |
| Max outputs | `n: 1–9` |

### `kling-v3` image pricing

Listed in the spec as **Kolors V3.0**.

| Resolution | Units | Price |
|---|---:|---:|
| 1K / 2K | 8 | $0.028 |

---

# 2) Exact input field summary by endpoint

## `/v1/videos/omni-video`

| Field | Type | Used for | Notes |
|---|---|---|---|
| `model_name` | string | choose model | `kling-video-o1`, `kling-v3-omni` |
| `multi_shot` | boolean | multi-shot video | when `true`, `shot_type` is required |
| `shot_type` | string | storyboard method | `customize`; update notes also mention `intelligence` support |
| `prompt` | string | main prompt | required when not using custom storyboard mode |
| `multi_prompt` | array | storyboard prompts | up to 6 storyboards |
| `image_list` | array | reference images / frames | supports start/end frame logic |
| `element_list` | array | reference elements | element IDs |
| `video_list` | array | reference video / base edit video | 1 video max, 3s–10s |
| `sound` | string | native audio generation | `on` / `off`; cannot be `on` with reference video |
| `mode` | string | quality mode | `std` or `pro` |
| `aspect_ratio` | string | frame ratio | `16:9`, `9:16`, `1:1` |
| `duration` | string | video length | `3–15s`, model-dependent |
| `watermark_info` | object | watermarked output | optional |
| `callback_url` | string | async callback | optional |
| `external_task_id` | string | your own task reference | must be unique per account |

## `/v1/videos/text2video`

| Field | Type | Used for | Notes |
|---|---|---|---|
| `model_name` | string | choose model | includes `kling-v3` and older families |
| `multi_shot` | boolean | multi-shot video | optional |
| `shot_type` | string | storyboard method | `customize`, `intelligence` |
| `prompt` | string | main prompt | can reference voices |
| `multi_prompt` | array | storyboard prompts | up to 6 shots |
| `negative_prompt` | string | negative guidance | optional |
| `voice_list` | array | voice references | up to 2 voices |
| `sound` | string | native audio | `on` / `off` |
| `cfg_scale` | float | prompt rigidity | only Kling v1.x |
| `mode` | string | quality mode | `std` / `pro` |
| `aspect_ratio` | string | frame ratio | `16:9`, `9:16`, `1:1` |
| `duration` | string | video length | `3–15s` |
| `watermark_info` | object | watermark output | optional |
| `callback_url` | string | async callback | optional |
| `external_task_id` | string | your own task reference | optional |

## `/v1/videos/image2video`

| Field | Type | Used for | Notes |
|---|---|---|---|
| `model_name` | string | choose model | includes `kling-v3` and older families |
| `image` | string | start/reference image | URL or Base64 |
| `image_tail` | string | end frame image | optional |
| `multi_shot` | boolean | multi-shot video | optional |
| `shot_type` | string | storyboard mode | `customize`, `intelligence` |
| `prompt` | string | main prompt | optional depending on mode |
| `multi_prompt` | array | storyboard prompts | up to 6 shots |
| `negative_prompt` | string | negative guidance | optional |
| `element_list` | array | elements | up to 3 |
| `voice_list` | array | voices | up to 2; mutually exclusive with `element_list` per notes |
| `sound` | string | native audio | `on` / `off` |
| `cfg_scale` | float | prompt rigidity | only Kling v1.x |
| `mode` | string | quality mode | `std` / `pro` |
| `duration` | string | video length | `3–15s` |
| `watermark_info` | object | watermark output | optional |
| `callback_url` | string | async callback | optional |
| `external_task_id` | string | your own task reference | optional |

## `/v1/images/omni-image`

| Field | Type | Used for | Notes |
|---|---|---|---|
| `model_name` | string | choose model | `kling-image-o1`, `kling-v3-omni` |
| `prompt` | string | main prompt | required |
| `image_list` | array | image references | URL or Base64 |
| `element_list` | array | elements | total images + elements <= 10 |
| `resolution` | string | image quality | `1k`, `2k`, `4k` |
| `result_type` | string | single or series | `single`, `series` |
| `n` | int | number of outputs | `1–9` |
| `series_amount` | int | number in a series | `2–9` |
| `aspect_ratio` | string | image ratio | includes `auto` |
| `callback_url` | string | async callback | optional |
| `external_task_id` | string | your own task reference | optional |

## `/v1/images/generations`

| Field | Type | Used for | Notes |
|---|---|---|---|
| `model_name` | string | choose model | includes `kling-v3` and older families |
| `prompt` | string | main prompt | required |
| `negative_prompt` | string | negative guidance | not supported in image-to-image mode |
| `image` | string | reference image | optional; URL or Base64 |
| `element_list` | array | elements | optional |
| `resolution` | string | image quality | `1k`, `2k` |
| `n` | int | number of outputs | `1–9` |
| `aspect_ratio` | string | image ratio | fixed ratio list |
| `callback_url` | string | async callback | optional |
| `external_task_id` | string | your own task reference | optional |

---

# 3) Quick price table

## Video price table (per second)

| Model | Quality | Condition | Price |
|---|---|---|---:|
| `kling-v3-omni` | std | no video input, no native audio | $0.084 |
| `kling-v3-omni` | std | no video input, with native audio | $0.112 |
| `kling-v3-omni` | std | with video input, no native audio | $0.126 |
| `kling-v3-omni` | std | with video input, with native audio | $0.154 |
| `kling-v3-omni` | pro | no video input, no native audio | $0.112 |
| `kling-v3-omni` | pro | no video input, with native audio | $0.140 |
| `kling-v3-omni` | pro | with video input, no native audio | $0.168 |
| `kling-v3-omni` | pro | with video input, with native audio | $0.196 |
| `kling-v3` | std | no native audio | $0.084 |
| `kling-v3` | std | native audio, no voice control | $0.126 |
| `kling-v3` | std | native audio, with voice control | $0.154 |
| `kling-v3` | pro | no native audio | $0.112 |
| `kling-v3` | pro | native audio, no voice control | $0.168 |
| `kling-v3` | pro | native audio, with voice control | $0.196 |
| `kling-v3` | motion control std | 1-second video | $0.126 |
| `kling-v3` | motion control pro | 1-second video | $0.168 |

## Image price table

| Model label in spec | Quality | Price |
|---|---|---:|
| `Kolors Image-3O` (`kling-v3-omni`) | 1K / 2K | $0.028 |
| `Kolors Image-3O` (`kling-v3-omni`) | 4K | $0.056 |
| `Kolors V3.0` (`kling-v3`) | 1K / 2K | $0.028 |

---

# 4) Final recommendation for your workflow

Because you said you **always choose the highest quality available**, your default stack should be:

| Task | Default choice |
|---|---|
| Text-to-video | `kling-v3-omni` + `mode: pro` |
| Image-to-video | `kling-v3-omni` + `mode: pro` |
| Video with specific voices/dialogue | `kling-v3` + `mode: pro` + `sound: on` |
| Text-to-image | `kling-v3-omni` + `resolution: 4k` |
| Image-to-image | `kling-v3-omni` + `resolution: 4k` |

---

# 5) Notes / caveats

- The source text says the **Kling 3.0 series has a newer API specification**, and that the current document will no longer be updated.
- The pasted price section **does not include pricing for**:
  - `kling-video-o1`
  - `kling-image-o1`
- Some feature notes in the pasted text contain small inconsistencies or typos (for example around `multi_shot`, `voice_list`, and endpoint naming), so double-check live docs before production implementation.

---

# 6) Minimal cheat sheet

## Highest quality defaults

```json
{
  "text_to_video": {
    "model_name": "kling-v3-omni",
    "mode": "pro"
  },
  "image_to_video": {
    "model_name": "kling-v3-omni",
    "mode": "pro"
  },
  "video_with_voice": {
    "model_name": "kling-v3",
    "mode": "pro",
    "sound": "on"
  },
  "text_to_image": {
    "model_name": "kling-v3-omni",
    "resolution": "4k"
  },
  "image_to_image": {
    "model_name": "kling-v3-omni",
    "resolution": "4k"
  }
}
```
