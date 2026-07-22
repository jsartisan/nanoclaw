/**
 * Image-generation MCP tool: `generate_image`, backed by Google Vertex AI
 * (the "AI Platform" `aiplatform.googleapis.com` API) in **express mode** —
 * `gemini-2.5-flash-image` ("Nano Banana") by default.
 *
 * Deliberately raw HTTP (no SDK): Google iterates the Gen AI SDK fast, and a
 * single `fetch` against the documented REST surface is the most stable thing
 * to depend on. Express mode is the simplest auth path — just an API key, no
 * project / location / OAuth bearer. The latest shape (verified 2026):
 *
 *   POST https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent
 *   x-goog-api-key: <API_KEY>
 *
 * (The standard project-scoped Vertex endpoint —
 * `{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/...`
 * — needs an OAuth access token instead; express mode swaps all of that for
 * one key.)
 *
 * Credentials — in priority order:
 *   1. `VERTEX_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` in env →
 *      sent as the `x-goog-api-key` header.
 *   2. Otherwise no key is sent and the OneCLI gateway injects one at the
 *      proxy (for a secret whose host pattern matches `aiplatform.googleapis.com`).
 *
 * Either way the request goes out through `HTTPS_PROXY` (Bun's fetch honors it
 * automatically), so the clawie MCP server must be spawned with the proxy +
 * CA-cert env vars passed through — see `container/agent-runner/src/index.ts`.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const VERTEX_HOST = 'aiplatform.googleapis.com';
const API_VERSION = process.env.VERTEX_API_VERSION || 'v1';
const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const DEFAULT_OUTPUT_DIR = '/workspace/agent/generated-images';
const WORKSPACE_ROOT = '/workspace/agent';
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_IMAGE_TIMEOUT_MS) || 180_000;

// Vertex image models accept a fixed set of aspect ratios. We don't hard-fail
// on an unlisted value (the API may add more) but we use this to default and
// to give the agent a useful hint in the schema.
const KNOWN_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

interface GeminiInlineData {
  mimeType?: string;
  mime_type?: string;
  data?: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
}

function buildUrl(model: string): string {
  return `https://${VERTEX_HOST}/${API_VERSION}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

/**
 * Resolve the requested output path to an absolute file path.
 *
 * - Absent → a timestamped file under DEFAULT_OUTPUT_DIR.
 * - A directory (existing dir, or a value ending in `/`) → a timestamped file
 *   inside it.
 * - Relative → resolved against the agent workspace root, so the agent can
 *   pass `assets/foo-illustrations/01-topic.png` and have it land predictably.
 */
function resolveOutputPath(rawPath: string | undefined, ext: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const defaultName = `image-${stamp}.${ext}`;

  if (!rawPath || rawPath.trim() === '') {
    return path.join(DEFAULT_OUTPUT_DIR, defaultName);
  }

  let candidate = rawPath.trim();
  const endsWithSep = candidate.endsWith('/');
  if (!path.isAbsolute(candidate)) {
    candidate = path.join(WORKSPACE_ROOT, candidate);
  }

  let isDir = endsWithSep;
  try {
    isDir = isDir || fs.statSync(candidate).isDirectory();
  } catch {
    /* path doesn't exist yet — treat as a file unless it ended with a sep */
  }

  return isDir ? path.join(candidate, defaultName) : candidate;
}

function findImagePart(parts: GeminiPart[]): { data: string; mimeType: string } | null {
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) {
      return { data: inline.data, mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png' };
    }
  }
  return null;
}

function collectText(parts: GeminiPart[]): string {
  return parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join('\n')
    .trim();
}

export const generateImage: McpToolDefinition = {
  tool: {
    name: 'generate_image',
    description:
      "Generate an image from a text prompt using Google Vertex AI (AI Platform) image models (Gemini \"Nano Banana\") and save it as a PNG in your workspace. " +
      'Use this whenever you are asked to draw, illustrate, or create a picture — including the ian-xiaohei-illustrations skill (this is the "image_gen" tool that skill refers to). ' +
      'Generate one image per call; for a multi-panel shot list, call this once per panel. ' +
      'Returns the absolute saved path — pass it to send_file to deliver the image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. Be specific about style, composition, colors, and any text to render.',
        },
        output_path: {
          type: 'string',
          description:
            'Where to save the PNG. Absolute path, or relative to /workspace/agent (e.g. "assets/my-article-illustrations/01-topic.png"). ' +
            'A directory (or a value ending in "/") saves a timestamped file inside it. Defaults to /workspace/agent/generated-images/.',
        },
        aspect_ratio: {
          type: 'string',
          description: `Aspect ratio of the image. One of: ${KNOWN_ASPECT_RATIOS.join(', ')}. Defaults to 16:9.`,
        },
        image_size: {
          type: 'string',
          enum: ['1K', '2K', '4K'],
          description:
            'Output resolution tier (1K/2K/4K). Only supported by newer models like gemini-3-pro-image; leave unset for the default gemini-2.5-flash-image, which ignores it.',
        },
        model: {
          type: 'string',
          description: `Vertex image model to use. Defaults to ${DEFAULT_MODEL}. Only override if you know the model id.`,
        },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return err('A non-empty "prompt" is required.');

    const aspectRatio = (typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim()) || '16:9';
    // imageSize (1K/2K/4K) is only supported by newer models (Gemini 3 Pro
    // Image); the default gemini-2.5-flash-image rejects it as an unknown
    // field. Only forward it when the caller explicitly asks.
    const imageSize = typeof args.image_size === 'string' && args.image_size.trim() ? args.image_size.trim() : undefined;
    const model = (typeof args.model === 'string' && args.model.trim()) || DEFAULT_MODEL;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // With an explicit key we send the header; without one we rely on the
    // OneCLI gateway to inject it at the proxy.
    const apiKey = process.env.VERTEX_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) headers['x-goog-api-key'] = apiKey;

    const imageConfig: Record<string, string> = { aspectRatio };
    if (imageSize) imageConfig.imageSize = imageSize;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // "TEXT" must be present alongside "IMAGE" — omitting it can make the API
      // return an empty response with no error.
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig,
      },
    };

    const url = buildUrl(model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) {
        return err(`Vertex AI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      return err(`Failed to reach Vertex AI (${VERTEX_HOST}): ${msg}. If you rely on OneCLI, check the gateway/proxy is up.`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      if (res.status === 401 || res.status === 403) {
        return err(
          `Vertex AI auth failed (${res.status}). Set a Vertex express-mode API key (VERTEX_API_KEY or GOOGLE_API_KEY), ` +
            `or configure a OneCLI secret with host pattern "aiplatform.googleapis.com". ${detail}`,
        );
      }
      if (res.status === 404) {
        return err(
          `Vertex AI returned 404 for model "${model}". Check the model id and that it's available in express mode. ${detail}`,
        );
      }
      return err(`Vertex AI returned ${res.status}: ${detail}`);
    }

    let payload: {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
    };
    try {
      payload = await res.json();
    } catch (e) {
      return err(`Could not parse Vertex AI response: ${e instanceof Error ? e.message : String(e)}`);
    }

    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const image = findImagePart(parts);
    if (!image) {
      // Surface the API's own explanation when it gives one: a safety block
      // lands in promptFeedback, a mid-generation stop in finishReason.
      const feedback = payload.promptFeedback;
      if (feedback?.blockReason) {
        const detail = feedback.blockReasonMessage ? `: ${feedback.blockReasonMessage}` : '';
        return err(`Vertex AI blocked the prompt (${feedback.blockReason}${detail}). Rephrase and try again.`);
      }
      const text = collectText(parts);
      if (text) return err(`Vertex AI returned no image — model said: "${text.slice(0, 300)}"`);
      const finish = candidate?.finishReason && candidate.finishReason !== 'STOP' ? ` (finishReason: ${candidate.finishReason})` : '';
      return err(`Vertex AI returned no image${finish} — the prompt may have been refused by a safety filter.`);
    }

    const ext = MIME_EXT[image.mimeType] ?? 'png';
    const outPath = resolveOutputPath(typeof args.output_path === 'string' ? args.output_path : undefined, ext);

    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(image.data, 'base64'));
    } catch (e) {
      return err(`Generated the image but failed to save it to "${outPath}": ${e instanceof Error ? e.message : String(e)}`);
    }

    const bytes = Buffer.byteLength(image.data, 'base64');
    log(`generate_image: vertex ${model} ${aspectRatio}${imageSize ? `/${imageSize}` : ''} → ${outPath} (${(bytes / 1024).toFixed(0)} KB)`);

    const note = collectText(parts);
    return ok(
      `Image saved to ${outPath} (${aspectRatio}, ${(bytes / 1024).toFixed(0)} KB).` +
        `${note ? `\nModel note: ${note.slice(0, 300)}` : ''}` +
        `\nUse send_file with this path to deliver it.`,
    );
  },
};

registerTools([generateImage]);
