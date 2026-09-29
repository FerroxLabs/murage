---
name: image-generation
description: "Write and send image prompts that fit whichever image model is selected. Use for any generate or edit request, for a recurring character, product or brand look (a lock plus a scene), for social and phone formats, and whenever an image must hit a specific ratio or pixel size."
---

# Image generation

Every image model wants something different. Find out which model is
selected, fit the request to what that model can take, then say plainly what
was sent and what came back.

## 1. Read the model's limits first

Call `list_image_models`. For the model you will use, note from its
`capabilities`:

- `maxPromptChars`: the prompt budget in characters. Everything you send
  counts: saved blocks, the scene and any Avoid: line.
- `sizeRule` and `sizeRuleText`: free pixels on a grid, a named ratio plus a
  size tier, or a fixed list of sizes.
- `qualities`, `formats`, `maxReferences` and `supports` (edits, transparent
  background, seed, native negative prompt, images per request as `n`).

The numbers there are the truth for this connection. The profiles below are
only guidance; when they disagree, `list_image_models` wins. If a model is
not in the table, write for the smallest budget and say so.

## 2. Model profiles (researched 29 Sep 2026)

| Model family | Budget | Size rule | References | Write for it like this |
|---|---|---|---|---|
| GPT Image 2 and 2.5 (Sunburst, Flare) | large (32,000 characters) | any WxH in multiples of 16, 1:3 to 3:1, up to 3840x2160 where the connection allows it | up to 16 | Long, structured, sectioned prompts work. Identity first. |
| Gemini image (Nano Banana 2, Pro, Lite) | large | named ratio plus a tier (512, 1K, 2K, 4K) | up to 14 | Natural description beats keyword lists. Say which reference is the subject and which is style. |
| FLUX.2 | small (about 30 to 80 words is best) | multiples of 32, about 4 MP | few or none | Short and concrete, most important words first. Drop the negatives. |
| Grok Imagine | not published | the model's default | up to 4 | Mid-length plain sentences. |

## 3. Lock plus scene

For anything recurring (a character, a product, a brand look), keep two parts:

- **Lock**, never edited per image: identity, permanent markers, the
  photographic approach, what must never appear.
- **Scene**, new every image: place, moment, action, expression, clothing,
  camera relationship, framing, light, one or two candid details.

Send the lock first, then the scene. If your tools include
`save_prompt_block`, save the lock once with it and pass its name in
`generate_image` `prompt_blocks` (for example `["character-lock"]`) with the
scene as `prompt`; read a saved block back with `get_prompt_block`. Otherwise
keep the lock in a file and paste it unchanged. Never rewrite a lock from
memory.

For a feed, vary on purpose: camera relationship, head position, awareness of
the camera, distance, activity. Lock the identity; loosen everything else.

## 4. When the prompt is too long for the model

`generate_image` refuses an over-budget prompt before the approval card and
names both numbers. It never cuts a prompt. Condense it yourself, in this
order, and stop at about 90% of the budget:

1. Permanent identity markers.
2. Subject, action and expression for this scene.
3. Camera and framing.
4. Light and place.
5. Clothing and candid details.
6. Negatives, as one short Avoid: line, or none for a small-budget model.

Send the condensed prompt with `condensed_from_chars` set to the original
length, so the card and the result say "Condensed from 12,900 to 1,900
characters". Tell the owner what you dropped. Keep the full lock unchanged.

## 5. Shape and size

Ask what the image is for, or infer it, and ask for intent:
`aspect_ratio` (such as `9:16`) with `resolution` (`small`, `standard`,
`large` or `max`), or exact `width` and `height`.

| Use | Ratio | Good pixels |
|---|---|---|
| Stories, reels, phone video covers | 9:16 | 1080x1920 |
| Feed portrait | 4:5 | 1080x1350 |
| Square post, avatar | 1:1 | 1024x1024 or 2048x2048 |
| Video thumbnail, web hero | 16:9 | 1920x1080 |
| Banner, cinematic | 21:9 | 2560x1088 |
| Link preview image | about 1.91:1 | 1200x630 (ask 16:9, then crop) |
| Pin | 2:3 | 1000x1500 |

`fit` is `nearest` by default: the model renders the closest size it
supports, and a request for a different shape is refused with the nearest
legal option named. Use `fit: "exact"` when the pixels matter: the model
renders the nearest size and Murage crops and resizes it here to exactly what
you asked, and says so. Never hand back a different shape without saying so.

## 6. References

- Use the model's cap (`maxReferences`), not a habit. For a character: one
  clean character sheet, then the best few renders showing the face at
  different angles.
- Prepare images from this conversation or workspace with
  `resolve_image_reference` and pass the ids in `reference_ids`. If your tools
  include `save_reference_pack`, save a set you reuse once and pass its name
  as `reference_pack`; pack images come first and count against the cap.
- Say which reference is which in the prompt ("image 1 is the character;
  image 2 is lighting reference only").
- Drop weak references. A bad reference teaches drift.

## 7. The other settings

- `n` makes several images from one approval, up to the model's `supports.n`.
- `negative_prompt` is sent natively where the model supports it; otherwise
  Murage adds it as an Avoid: line, counts it in the budget and says so.
- `seed`, `background: "transparent"`, `output_format` and
  `output_compression` only where `supports` says so. Anything else is
  refused plainly; leave it out rather than guess.

## 8. Before and after the call

Before: model, quality, size, references and the assembled prompt length are
decided and fit. The approval card is the owner's decision; do not describe
the image as made until it comes back.

After: look at the image. Check every lock marker, the ratio and the pixels
in the result (they are read from the image itself). Report it in one line
("9:16, 1152x2048, markers held, watch missing") and one sentence on what you
would change next time. Never call a render on-model without checking it.

## 9. Never

- Never truncate a lock or rewrite it from memory.
- Never switch to a different model than the one selected without saying so.
- Never retry a render after a timeout or an uncertain result without first
  checking whether the first one landed; repeat the same `request_id` to
  resume it.
- Never paste keys, provider URLs or local file paths into a prompt or a tool
  call.
