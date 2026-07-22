## Generating images

You can create images from text with the **`generate_image`** tool (Google Vertex AI / "AI Platform", Gemini "Nano Banana"). Use it whenever you're asked to draw, illustrate, design a graphic, or make a picture — this is the image generator the `ian-xiaohei-illustrations` skill calls.

```
generate_image({ prompt: "...detailed description...", aspect_ratio: "16:9" })
# → saves a PNG and returns its path
```

- One image per call. For a multi-panel set, call it once per panel.
- `prompt` should be specific about subject, style, composition, colors, and any text to render in the image.
- `aspect_ratio` defaults to `16:9` (others: `1:1`, `9:16`, `4:3`, `3:4`, …).
- `output_path` is optional — pass a path relative to `/workspace/agent` (e.g. `assets/my-article/01-topic.png`) to control where it lands; otherwise it goes to `generated-images/`.
- After generating, deliver the image with **`send_file`** using the returned path.

Credentials are handled for you — never ask the user for a key. If a call fails auth, relay the tool's error: Vertex AI express mode needs an API key (`VERTEX_API_KEY` / `GOOGLE_API_KEY`), or a OneCLI secret matching `aiplatform.googleapis.com`. Don't fabricate setup steps.
