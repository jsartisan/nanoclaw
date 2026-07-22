#!/usr/bin/env node
/**
 * generate.mjs — image generation that actually works on this host.
 *
 * The built-in `generate_image` MCP tool uses Vertex "express mode"
 * (https://aiplatform.googleapis.com/v1/publishers/google/models/MODEL:generateContent),
 * which on this project's express key routes to region asia-southeast1 — where
 * the Gemini image model doesn't exist (HTTP 404). The project-scoped *global*
 * location endpoint DOES work, so we call that directly. Credentials are
 * injected by the OneCLI proxy when we send the `onecli-managed` placeholder.
 *
 * Usage:
 *   node generate.mjs "<prompt>" "<output_path>" ["<aspect_ratio>"]
 *
 * Prints the saved absolute path on success; exits non-zero with an error on
 * failure.
 */
import fs from 'fs';
import path from 'path';

const [prompt, outArg, aspect = '16:9'] = process.argv.slice(2);
if (!prompt) {
  console.error('Usage: node generate.mjs "<prompt>" "<output_path>" ["<aspect_ratio>"]');
  process.exit(2);
}

// Project + global location is the combination verified to serve the Gemini
// image model for this express key. If the key/project changes, update PROJECT.
const PROJECT = process.env.VERTEX_PROJECT || '786316903824';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`;

const WORKSPACE = '/workspace/agent';
function resolveOut(p) {
  if (!p || !p.trim()) {
    return path.join(WORKSPACE, 'generated-images', `image-${process.pid}.png`);
  }
  let c = p.trim();
  if (!path.isAbsolute(c)) c = path.join(WORKSPACE, c);
  return c;
}

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'onecli-managed' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } },
  }),
});

if (!res.ok) {
  console.error(`Vertex returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);
  process.exit(1);
}

const j = await res.json();
const parts = j.candidates?.[0]?.content?.parts ?? [];
const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
const data = img?.inlineData?.data || img?.inline_data?.data;
if (!data) {
  const note = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 300);
  console.error(`No image returned${note ? ` — model said: "${note}"` : ' (possible safety refusal).'}`);
  process.exit(1);
}

const out = resolveOut(outArg);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log(out);
