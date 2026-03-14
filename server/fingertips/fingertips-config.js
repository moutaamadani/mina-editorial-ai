// ./server/fingertips/fingertips-config.js
// Model definitions, costs, and input schemas for the Fingertips feature.

// ============================================================================
// COST TABLE
// Each model costs a fraction of 1 matcha per generation. except upscaler
// The billing system deducts 1 whole matcha at a time into a "fingertips pool",
// then draws down from that pool until exhausted.
// ============================================================================

export const FINGERTIPS_MODELS = {
  eraser: {
    replicateModel: "bria/eraser",
    costPerGeneration: 0.5, // 2 generations = 1 matcha
    label: "Object Eraser",
    description: "Remove unwanted objects from images while preserving quality",
    // Required inputs: image, mask_image
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (JPEG, PNG, WEBP)" },
      mask_image: { type: "uri", required: true, description: "Binary mask image URL. White (255) = area to erase, Black (0) = keep. Must match image aspect ratio." },
    },
  },

  flux_fill: {
    replicateModel: "black-forest-labs/flux-fill-pro",
    costPerGeneration: 0.5,
    label: "AI Fill (Inpaint/Outpaint)",
    description: "Professional inpainting and outpainting with text-guided generation",
    // Required: image, mask, prompt. Optional: guidance, steps, output_format, safety_tolerance, seed, prompt_upsampling
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (can contain alpha mask)" },
      mask: { type: "uri", required: true, description: "Black-and-white mask. White = inpaint area, Black = preserve." },
      prompt: { type: "string", required: true, description: "Text description of what to generate in masked region" },
      guidance: { type: "number", required: false, default: 30, description: "Prompt adherence vs quality (higher = more prompt-following)" },
      steps: { type: "integer", required: false, default: 50, description: "Diffusion steps (more = more detail, slower)" },
      output_format: { type: "string", required: false, default: "jpg", description: "Output format: jpg, png" },
      safety_tolerance: { type: "integer", required: false, default: 2, description: "Safety filter level (0 = strictest, 6 = most permissive)" },
      seed: { type: "integer", required: false, description: "Random seed for reproducibility" },
      prompt_upsampling: { type: "boolean", required: false, default: false, description: "Auto-modify prompt for more creative results" },
    },
  },

  expand: {
    replicateModel: "bria/expand-image",
    costPerGeneration: 0.5,
    label: "Image Expand",
    description: "Expand images beyond their borders to a new aspect ratio",
    // Required: image + (aspect_ratio OR canvas_size combo). Optional: prompt, negative_prompt, seed, preserve_alpha, sync, content_moderation
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (JPEG, PNG, WEBP)" },
      image_url: { type: "uri", required: false, description: "Alias for image. If provided, it will be copied to image." },
      aspect_ratio: { type: "string", required: false, description: "Target aspect ratio (e.g. 16:9, 9:16, 1:1, 4:5). If set, canvas_size/original_image_size/original_image_location are ignored." },
      canvas_size: { type: "array", required: false, description: "[width, height] of output canvas. For 4K use [3840, 2160] (16:9) or [2160, 3840] (9:16). Max 5000x5000." },
      original_image_size: { type: "array", required: false, description: "[width, height] of source image within canvas. Required when aspect_ratio is not set." },
      original_image_location: { type: "array", required: false, description: "[x, y] position for source image on canvas. Required when aspect_ratio is not set." },
      prompt: { type: "string", required: false, description: "Text prompt to guide expansion. Auto-generated if empty." },
      negative_prompt: { type: "string", required: false, description: "Elements to exclude from expansion (only when fast=false)" },
      seed: { type: "integer", required: false, description: "Random seed for reproducibility" },
      preserve_alpha: { type: "boolean", required: false, default: true, description: "Preserve alpha transparency in output." },
      sync: { type: "boolean", required: false, default: true, description: "Use synchronous mode for the response." },
      content_moderation: { type: "boolean", required: false, description: "Enable content filtering" },
    },
  },

  remove_bg: {
    replicateModel: "men1scus/birefnet:f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7",
    costPerGeneration: 0.2, // 5 generations = 1 matcha
    label: "Remove Background",
    description: "Bilateral Reference high-resolution background removal",
    // Required: image
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (JPEG, PNG, WEBP)" },
    },
  },

  upscale: process.env.UPSCALE_CRYSTAL === "1"
    ? {
        replicateModel: "philz1337x/crystal-upscaler:5d917b1444c89ed91055f3052d27e1ad433a1218599a36544510e1dfa9ac26c8",
        costPerGeneration: 0.1, // 10 generations = 1 matcha
        label: "Crystal Upscaler",
        description: "Upscale images with AI-enhanced detail",
        variant: "crystal",
        inputSchema: {
          image: { type: "uri", required: true, description: "Input image (JPG, PNG, WEBP)" },
          scale_factor: { type: "number", required: false, default: 2, description: "Scale factor (1-100x). Higher = more detail." },
        },
      }
    : {
        replicateModel: "fermatresearch/magic-image-refiner:507ddf6f977a7e30e46c0daefd30de7d563c72322f9e4cf7cbac52ef0f667b13",
        costPerGeneration: 0.1, // 10 generations = 1 matcha
        label: "Magic Image Refiner",
        description: "AI-powered image enhancement — uses GPT vision to describe the image for maximum detail",
        variant: "magic",
        defaultNegative: "teeth, tooth, open mouth, longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, mutant",
        inputSchema: {
          image: { type: "uri", required: true, description: "Image to refine (JPG, PNG, WEBP)" },
          prompt: { type: "string", required: false, description: "Detailed description of the image (auto-generated by GPT vision if omitted)" },
          negative_prompt: { type: "string", required: false, description: "Negative prompt" },
          hdr: { type: "number", required: false, default: 0, description: "HDR improvement over the original image (0-1)" },
          creativity: { type: "number", required: false, default: 0.25, description: "Denoising strength. 1 means total destruction of the original image (0-1)" },
          resemblance: { type: "number", required: false, default: 0.75, description: "Conditioning scale for controlnet (0-1)" },
          guidance_scale: { type: "number", required: false, default: 7, description: "Scale for classifier-free guidance (0.1-30)" },
          steps: { type: "integer", required: false, default: 20, description: "Number of denoising steps" },
          seed: { type: "integer", required: false, description: "Random seed for reproducibility" },
          resolution: { type: "string", required: false, default: "original", description: "Image resolution: original, 1024, 2048" },
          scheduler: { type: "string", required: false, default: "DDIM", description: "Scheduler: DDIM, DPMSolverMultistep, K_EULER_ANCESTRAL, K_EULER" },
        },
      },

  vectorize: {
    replicateModel: "recraft-ai/recraft-vectorize",
    costPerGeneration: 0.5,
    label: "Vectorize",
    description: "Convert raster images to high-quality scalable SVG vector graphics",
    // Required: image
    inputSchema: {
      image: { type: "uri", required: true, description: "Input raster image (PNG, JPG, WEBP) to convert to SVG" },
    },
  },
};

// Quick lookups
export const FINGERTIPS_MODEL_KEYS = Object.keys(FINGERTIPS_MODELS);

export function getFingertipsModel(key) {
  return FINGERTIPS_MODELS[key] || null;
}

export function getFingertipsCost(key) {
  const m = FINGERTIPS_MODELS[key];
  return m ? m.costPerGeneration : null;
}
