---
name: pexels-image-search
description: Search and embed real, high-quality stock photos from Pexels into any UI being generated — landing pages, hero sections, portrait/testimonial cards, feature grids, backgrounds. Use this any time a UI needs a photo and you'd otherwise reach for a gray placeholder box, a broken image URL, or lorem-picsum filler. Requires a Pexels API key already configured in the project (see Setup below) — if PEXELS_API_KEY is missing, tell the user before proceeding rather than silently falling back to placeholders.
---

# Pexels Image Search

A skill for finding the *right* stock photo for each image slot in a UI — not just any photo, but one matching the slot's shape, subject, and mood — and wiring it into the code correctly.

## When to use this

Trigger this skill whenever you're generating or editing UI that contains:
- Hero/banner images
- Portrait or headshot cards (team members, testimonials, instructors, "meet the students" grids)
- Feature/lifestyle photography (product shots, "how it works" imagery)
- Background imagery behind text or CTAs

Do **not** use this for icons, logos, illustrations, or anything that should be a placeholder marked `[LOGO PLACEHOLDER]` — those are not photos and Pexels won't have them.

## Setup (one-time, done by the human)

This skill depends on `scripts/pexels.ts` and one environment variable:

```
PEXELS_API_KEY=their_actual_key
```

This must live in `.env.local` (Next.js) or the project's equivalent server-only env file — **never** prefixed `NEXT_PUBLIC_` and never hardcoded into `scripts/pexels.ts`. If you're the AI generating code and this variable isn't present in the project, stop and ask the human to add it rather than inventing a key or silently using unsplash/picsum instead.

## Workflow

Follow these steps for every image slot in the UI you're building:

### 1. Identify the slot's shape and role before searching
Look at the layout first. Every image slot implies an orientation and a subject:
- A tall portrait card (e.g. w-64 h-80, aspect ratio < 1) → search with `orientation: "portrait"`
- A wide hero banner → `orientation: "landscape"`
- An avatar/circle → `orientation: "square"`

Mismatching orientation to slot is the #1 way this goes wrong — a landscape photo jammed into a portrait card gets awkwardly cropped by `object-cover`. Always pass the right `orientation` param to `searchPhotos()`.

### 2. Write specific, descriptive queries — not generic ones
Vague queries return generic, overused corporate stock photos. Be specific about subject, mood, and framing:

| Bad query | Better query |
|---|---|
| `"business"` | `"confident young professional smiling office"` |
| `"person"` | `"web developer working laptop portrait"` |
| `"team"` | `"diverse creative team collaborating studio"` |

If the UI has copy or badges near the image (e.g. a "Digital Marketing" badge on a portrait card), fold that into the query: `"digital marketing professional portrait smiling"`.

### 3. Fetch candidates, don't just grab result #1
Call `searchPhotos(query, { perPage: 5, orientation })` and look at 3–5 results. Prefer ones with:
- Clean, uncluttered backgrounds if the design is minimal
- Consistent lighting/tone across all images used on the same page (don't mix warm-toned and cold-toned photos in one grid)
- No visible text, watermarks, or logos in the shot

### 4. Avoid duplicate photos across one page
Track photo `id`s you've already used in this build and skip repeats — a grid of 5 portrait cards showing the same face twice looks broken.

### 5. Pick the right size variant, not always `original`
Match `photo.src.<size>` to how large the image actually renders:
- Small thumbnail/avatar → `small` or `tiny`
- Standard card (few hundred px) → `medium`
- Full-width hero → `large` or `large2x`

Never ship `original` for a small card — it's wasted bandwidth and slows the page.

### 6. Wire it into the code correctly
- Next.js: use `next/image` with the chosen `src.<size>` URL, and make sure `images.pexels.com` is in `next.config.js` → `images.remotePatterns` (see snippet in `scripts/pexels.ts` header comment).
- Always set `alt` from `photo.alt` (fall back to your own description if Pexels' alt is empty).
- Fetch photos server-side (Server Component, route handler, or build-time script) — never call `searchPhotos()` from client-side code, since it needs the private API key.

### 7. Handle failures gracefully
If the API call errors (bad key, rate limit, network issue), don't let the whole page break. Catch the error and fall back to a solid-color div with the same dimensions, and surface the error in a code comment or console log so the human notices — don't fail silently and don't fabricate a fake image URL.

## Reference code

`scripts/pexels.ts` contains the typed fetch wrapper: `searchPhotos()`, `getCuratedPhotos()`, `getPhotoById()`. Read it before writing new fetch logic — don't reimplement the API call inline elsewhere in the codebase; import from this one module so the key-handling and caching stay centralized.

## Example: building a portrait card grid

```tsx
// app/(marketing)/page.tsx — Server Component
import { searchPhotos } from "@/lib/pexels";
import Image from "next/image";

const slots = [
  { badge: "Web Design", query: "web designer portrait smiling confident" },
  { badge: "Digital Marketing", query: "digital marketing professional portrait beard glasses" },
  { badge: "Motion Design", query: "creative professional black outfit studio portrait" },
];

export default async function TeamGrid() {
  const usedIds = new Set<number>();
  const cards = [];

  for (const slot of slots) {
    const results = await searchPhotos(slot.query, { perPage: 5, orientation: "portrait" });
    const pick = results.find((p) => !usedIds.has(p.id)) ?? results[0];
    usedIds.add(pick.id);
    cards.push({ ...slot, photo: pick });
  }

  return (
    <div className="grid grid-cols-5 gap-4">
      {cards.map((c) => (
        <div key={c.photo.id} className="relative rounded-3xl overflow-hidden aspect-[4/5]">
          <Image src={c.photo.src.medium} alt={c.photo.alt || c.badge} fill className="object-cover" />
          <span className="absolute top-3 left-3 bg-white rounded-full px-3 py-1 text-xs font-medium">
            {c.badge}
          </span>
        </div>
      ))}
    </div>
  );
}
```

## Attribution

Pexels' license does **not** require attribution, but it's appreciated. If the project has a footer or credits page, consider crediting `photographer` + `photographer_url` from the response — don't add visible attribution badges on top of the images themselves unless the human asks for that.
