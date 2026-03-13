// ./server/fingertips/fingertips-config.js
// Model definitions, costs, and input schemas for the Fingertips feature.

// ============================================================================
// COST TABLE
// Each model costs a fraction of 1 matcha per generation.
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
      output_format: { type: "string", required: false, default: "jpeg", description: "Output format: jpeg, png, webp" },
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
    // Required: image + (aspect_ratio OR canvas_size combo). Optional: prompt, negative_prompt, seed, content_moderation
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (JPEG, PNG, WEBP)" },
      aspect_ratio: { type: "string", required: false, description: "Target aspect ratio (e.g. 16:9, 9:16, 1:1, 4:5). If set, canvas_size/original_image_size/original_image_location are ignored." },
      canvas_size: { type: "array", required: false, default: [1000, 1000], description: "[width, height] of output canvas. Used when aspect_ratio is not set." },
      original_image_size: { type: "array", required: false, description: "[width, height] of source image within canvas. Required when aspect_ratio is not set." },
      original_image_location: { type: "array", required: false, description: "[x, y] position for source image on canvas. Required when aspect_ratio is not set." },
      prompt: { type: "string", required: false, description: "Text prompt to guide expansion. Auto-generated if empty." },
      negative_prompt: { type: "string", required: false, description: "Elements to exclude from expansion (only when fast=false)" },
      seed: { type: "integer", required: false, description: "Random seed for reproducibility" },
      content_moderation: { type: "boolean", required: false, description: "Enable content filtering" },
    },
  },

  remove_bg: {
    replicateModel: "smoretalk/rembg-enhance:4067ee2a58f6c161d434a9c077cfa012820b8e076efa2772aa171e26557da919",
    costPerGeneration: 0.2, // 5 generations = 1 matcha
    label: "Remove Background",
    description: "Remove backgrounds with enhanced quality and detail",
    // Required: image
    inputSchema: {
      image: { type: "uri", required: true, description: "Source image URL (JPEG, PNG, WEBP)" },
    },
  },

  upscale: process.env.UPSCALE_CRYSTAL === "1"
    ? {
        replicateModel: "philz1337x/crystal-upscaler",
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
        replicateModel: "philz1337x/clarity-upscaler:dfad41707589d68ecdccd1dfa600d55a208f9310748e44bfe35b4a6291453d5e",
        costPerGeneration: 0.1, // 10 generations = 1 matcha
        label: "Clarity Upscaler",
        description: "Hyper-realistic AI upscale — uses GPT vision to describe the image for maximum detail",
        variant: "clarity",
        defaultSuffix: "masterpiece, best quality, highres, <lora:more_details:0.5> <lora:SDXLrender_v2.0:1>",
        defaultNegative: "(worst quality, low quality, normal quality:2) JuggernautNegative-neg",
        inputSchema: {
          image: { type: "uri", required: true, description: "Input image (JPG, PNG, WEBP)" },
          prompt: { type: "string", required: false, description: "Detailed description of the image (auto-generated by GPT vision if omitted)" },
          negative_prompt: { type: "string", required: false, description: "Negative prompt for clarity-upscaler" },
          scale_factor: { type: "number", required: false, default: 2, description: "Scale factor (1-4x)." },
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
