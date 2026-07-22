---
name: illustrate
description: >-
  Create article/concept illustrations in the Ian "小黑/xiaohei" hand-drawn style.
  Use whenever the user asks to "create an illustration", "illustrate", "make an
  image/picture/diagram", "draw", produce "配图 / 文章插图 / shot list", or wants a
  concept/article turned into a visual. This skill wraps the
  ian-xiaohei-illustrations skill and handles this host's image-gen quirks.
---

# illustrate — Ian 小黑 illustrations, made reliable

This is a thin wrapper around the **`ian-xiaohei-illustrations`** skill. Its job:
load that skill's style, build a proper prompt **in the upstream format**,
generate through the image path that actually works on this host, and deliver the
PNG. Default to the 小黑 style for every illustration request unless the user
explicitly says "freestyle / don't use the bean / plain infographic".

## Step 1 — Load the real style

Read the canonical references from the wrapped skill before prompting (don't
reinvent the rules):

- `/app/skills/ian-xiaohei-illustrations/references/style-dna.md`
- `/app/skills/ian-xiaohei-illustrations/references/xiaohei-ip.md`
- `/app/skills/ian-xiaohei-illustrations/references/composition-patterns.md`
- `/app/skills/ian-xiaohei-illustrations/references/prompt-template.md`
- `/app/skills/ian-xiaohei-illustrations/references/qa-checklist.md`

Visual essence (calibrated against the repo's `examples/`): ONE large bean-shaped
小黑 as the lone protagonist doing the core action, on ONE thin orange path; ≥45%
white space; loose wobbly whiteboard-doodle lines (NO shading/gradient/vector
polish); ≤4–5 short labels; red = warning/negation, orange = path/token,
blue = secondary note. NOT a busy multi-figure diagram, NOT a PPT infographic.

## Step 2 — Match the invocation recipe (from `examples/prompts.md`)

Map the user's ask to the upstream recipe and behave accordingly:

| User asks | Recipe | Behavior |
|---|---|---|
| "plan the images / 配图策略 / where to add images / shot list" | 只做配图规划 / 长文配图策略 | Output a 4–8 image **shot list only**, do NOT generate |
| "illustrate this article / 配 N 张图" | 文章正文配图 | Plan briefly, then generate (one image per anchor) |
| "make an image for this idea: <X>" | 单个观点生成一张图 | Generate ONE image for that single viewpoint |
| "for the concept of <workflow>" | 工作流主题 | Reinvent a fresh metaphor, don't reuse known cases |
| "remove the title / 去掉标题" | 改图：去掉标题 | Use the edit prompt in prompt-template.md |
| "make 小黑 more central / 更怪一点" | 改图：增强小黑参与感 | Regenerate, 小黑 drives the action |
| "give me a set of style samples" | 生成一组风格样片 | Generate several, one per theme |

## Step 3 — Build the prompt in the upstream STRUCTURED format

ALWAYS construct the generation prompt by filling the labeled-field template from
`references/prompt-template.md` — do NOT write freeform prose. Fill every field:

```text
Generate one standalone 16:9 horizontal hand-drawn article illustration.

Visual DNA:
Pure white background. Minimalist black hand-drawn line art. Slightly wobbly pen
lines. Lots of empty white space. Sparse red/orange/blue handwritten <LANG>
annotations. Clean absurd product-sketch feeling. No gradients, no shadows, no
paper texture, no complex background, no commercial vector style, no PPT
infographic look, no cute mascot poster, no children's illustration, no UI.

Recurring IP character required:
小黑, a single large solid-black bean creature with white dot eyes, tiny thin
legs, blank deadpan serious expression, slightly uneven hand-drawn outline. 小黑
must perform the core conceptual action, not decorate the scene. Not cute.

Theme:
{the article/concept theme}

Structure type:
{Workflow / 系统局部 / 前后对比 / 角色状态 / 概念隐喻 / 方法分层 / 地图路线 / 小漫画分镜}

Core idea:
{the one thing this image must convey}

Composition:
{where 小黑 is, what it is doing, the main objects, how information flows}

Suggested elements:
{element1} / {element2} / {element3} / {element4}

Handwritten labels (render EXACTLY, max 5, short, spelled correctly):
{label1} / {label2} / {label3} / {label4}

Color use:
Black for main line art and 小黑. Orange for main flow/path/arrows. Red only for
key warnings/problems/results. Blue only for secondary notes or system state.

Constraints:
One image explains only one core structure. Main subject ~40%-60% of canvas,
preserve ≥45% blank white space. At most 5 short labels. No title in any corner.
Do not write the structure type on the image. Not a formal diagram/slide/dense
explainer. Invent a fresh metaphor; do not copy prior example compositions.
```

Keep the prompt CONCISE like the upstream examples — let the template's fields
(not extra prose) carry the spec.

## Step 4 — Generate (use the bundled script, NOT the built-in tool)

⚠️ This host's built-in `generate_image` tool 404s: its Vertex express URL routes
to region `asia-southeast1`, which doesn't carry the Gemini image model. Use the
bundled helper, which calls the project-scoped **global** endpoint that works:

```bash
node /app/skills/illustrate/generate.mjs "<the structured prompt>" "assets/<slug>-illustrations/01-topic.png" "16:9"
# prints the saved absolute path on success
```

Call it once per panel. The script injects credentials via the OneCLI proxy
(the `onecli-managed` placeholder) — never put a real key in the prompt.

## Step 5 — Labels: English by default

The Gemini image model **garbles CJK glyphs** — Chinese handwritten labels render
as gibberish. Default to **English labels** (set `<LANG>` = English). Only use
Chinese if the user insists, and then generate the art clean and overlay the
Chinese text afterward with a font.

## Step 6 — QA & deliver

Check against `qa-checklist.md` (小黑 is the actor, not decoration; not too busy;
not a PPT; clean white background; labels spelled right). Regenerate if it fails.
Deliver with `send_file`, saving to `assets/<article-slug>-illustrations/NN-topic.png`.

## Default demo theme

When the user just wants to see the skill work (no topic given), default to the
repo's canonical single-viewpoint example — the **"trust bridge"**:

> 信任不是喊出来的，而是一块证据一块证据铺过去。
> *(Trust isn't shouted — it's laid down one piece of evidence at a time.)*

小黑 stands on a gap between two cliffs ("stranger" → "willing to talk") calmly
laying small evidence-tiles to build the bridge across. Red "not shouting",
blue "small evidence", one orange path.
