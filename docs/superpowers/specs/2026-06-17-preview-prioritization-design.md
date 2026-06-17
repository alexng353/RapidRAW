# Preview Prioritization — Design Spec

- **Date:** 2026-06-17
- **Status:** Approved (direction); pending implementation plan
- **Topic:** Prioritize frame times over maximal thumbnail generation throughput

## Context & Problem

RapidRAW's library grid generates a thumbnail per image by **fully developing the
RAW** (`develop_raw_image` → demosaic + enhance, ~200ms+ per 24MP file), encoding
JPEG, base64-ing it, and emitting it to the WebKit frontend. All requests go into a
single global `VecDeque<String>` (`ThumbnailManager.queue`), drained LIFO by N worker
threads, capped at 500. The frontend (`useThumbnails.ts`) collects the react-window
viewport paths but then **randomly shuffles them** before sending, destroying any
visible-first ordering.

Consequences on a large library (~23k images): opening a folder floods the workers
with full-RAW develops in no useful order; the UI shows nothing until developed
thumbnails trickle in; navigating folders hard-cancels in-flight work; and there is no
notion of "show the visible stuff first, fill the rest later."

**Goal:** make the grid feel instant and stay responsive while scrolling/navigating,
trading total generation throughput for frame-time/perceived latency.

## Goals / Non-Goals

**Goals**
1. Show an embedded JPEG preview instantly, then upgrade to the developed thumbnail.
2. Generate at a resolution matched to the on-screen cell size (auto), with manual override.
3. Develop visible + next-page first; fill the rest only when those are satisfied.
4. Scope generation to the focused folder; demote (not discard) the previous folder's work on navigate.

**Non-Goals**
- Changing the RAW develop pipeline itself, the GPU backend, or the base64-over-IPC
  transport (tracked separately).
- Persisting/caching embedded previews to disk.
- AI tagging / indexing behavior.

## Decisions (locked with user)

- **D1 — Embedded preview:** 2-pass. Embedded JPEG shows instantly as a placeholder;
  the fully-developed thumbnail **always** replaces it. (Not "embedded as final.")
- **D2 — Navigate-away:** **Demote A, finish B first.** B's visible + next-page +
  background-fill all run before A's leftovers resume; A's progress is not discarded.
- **D3 — Resolution:** **Auto default + manual override.** Auto = cell px × DPR,
  bucketed; manual list keeps discrete values and gains 320/480 below 640.
- **D4 — Architecture:** Approach A — backend tiered priority queue + generation token;
  frontend tags each path's tier from the viewport it already tracks.
- **D5 — "Idle":** not a timer. Tier T2 only runs when T0/T1 are empty; the scrolling
  viewport keeps refilling T0/T1, so T2 naturally waits.

## Architecture

### Priority tiers

Workers pick the **highest-priority** item, where priority orders by
`(tier asc, generation desc, seq asc)`:

| Tier | Contents | Work |
|------|----------|------|
| **T0 embedded** | embedded JPEG for *visible + next page* | cheap extract (no demosaic) |
| **T1 develop-high** | full develop for *visible + next page* | heavy |
| **T2 develop-low** | full develop for *rest of focused folder*, then demoted folders | heavy |

`generation desc` means a newer folder's items outrank an older folder's items **within
the same tier**. Because tier is the primary key, the full order on navigate A(gen N)→
B(gen N+1) is:
`T0(B) → T1(B) → T2(B) → T2(A)` — i.e. B fully fills (including its background) before
A's leftovers resume. This is exactly D2.

### Queue data structure (`ThumbnailManager`)

Replace `queue: Mutex<VecDeque<String>>` with a priority queue:

```rust
struct PrioritizedThumb {
    tier: u8,          // 0,1,2
    generation: u64,   // higher = newer/focused folder
    seq: u64,          // monotonic insertion counter, FIFO tiebreak
    path: String,      // includes ?vc= virtual-copy suffix as today
    stage: Stage,      // Embedded | Final
    target_res: u32,   // resolved numeric target (auto or manual)
}
enum Stage { Embedded, Final }
```

- Stored in a `BinaryHeap<PrioritizedThumb>` with an `Ord` that makes "greater" = higher
  priority: tier reversed, then `generation`, then `seq` reversed. (Equivalently a
  3-VecDeque structure keyed by tier — heap chosen for clean generation ordering.)
- `processing_now` becomes a `HashSet<(String, Stage)>` so an in-flight embedded job does
  not block that path's develop job.
- `cvar` unchanged (workers wait when empty).
- **Caps:** T0/T1 are viewport-sized (small, uncapped). T2 capped (e.g. 2000) by dropping
  the **lowest-priority** (oldest generation, highest seq) items when over cap — so
  background backlog can't grow unbounded. Log when items are dropped (no silent cap).

### Generation token

- `AppState` gains `thumbnail_generation: Arc<AtomicU64>`.
- The frontend owns the logical generation and passes it on every priority update; the
  backend uses the max generation it has seen.
- **On generation increase:** demote every queued item with `tier < 2` to `tier = 2`
  (keeping its generation). This turns the previous folder's stale "visible develop"
  into background work behind the new folder. In-flight jobs (≤ `thread_count`) finish
  as-is; we do not preempt mid-decode.

### Worker loop changes (`start_thumbnail_workers`)

- Pop highest-priority `PrioritizedThumb` instead of `pop_back()`.
- `Stage::Embedded` → call the new embedded extractor (below); emit `thumbnail-generated`
  with `stage: "embedded"`. Do **not** mark progress complete for embedded (progress
  tracks Final only, so the progress bar reflects real develop work).
- `Stage::Final` → existing `generate_single_thumbnail_and_cache` path; emit with
  `stage: "final"`; increment progress.

### Embedded extractor (new)

`fn extract_embedded_preview(path, target_res) -> Option<DynamicImage>`:

1. `is_raw_file(path)`? If not RAW: skip embedded (non-RAW grid already loads fast;
   it goes straight to Final). 
2. `decoder = rawler::get_decoder(&source)`; try in order, first `Ok(Some(img))` wins:
   `decoder.preview_image(&source, &params)` → `thumbnail_image(..)` → `full_image(..)`.
   (All are `(&self,&RawSource,&RawDecodeParams)->Result<Option<DynamicImage>>`, default
   `Ok(None)`, so the fallback chain is mandatory.)
3. Apply EXIF orientation; downscale to `target_res` (longest edge) via existing
   `downscale_f32_image` path; return.
4. If all return `None`/`Err`: return `None` → frontend simply waits for Final (no
   placeholder for that image). Wrapped in `panic::catch_unwind` like `develop_raw_image`.

Embedded previews are **not** disk-cached (cheap, transient). They are **not** crop/
adjustment-aware; the Final develop (which is) overwrites them.

### Cache key change

`compute_thumbnail_cache_hash(path_str, adjustments_bytes)` →
`compute_thumbnail_cache_hash(path_str, adjustments_bytes, target_res)`, adding
`hasher.update(&target_res.to_le_bytes())`. Different resolution buckets get distinct
cache files; changing resolution invalidates old entries (acceptable, expected).

### Command surface

Replace the single `update_thumbnail_queue(paths)` with:

```
set_thumbnail_priorities({
  generation: u64,
  visible:    Vec<String>,   // → T0 embedded + T1 develop
  prefetch:   Vec<String>,   // next page(s) → T1 develop
  background: Vec<String>,   // rest of focused folder → T2 develop
  target_res: u32,
})
clear_thumbnail_queue()      // empties all tiers, bumps cancellation token (root change/close)
```

- Each call: bump generation if larger (triggering demotion), then enqueue the three
  sets at their tiers for that generation. Frontend pre-filters paths it already has a
  Final for; backend dedups via `processing_now` + "already queued at ≥ this priority."
- The three sets are treated **additively with dedup**; only the current generation's
  T0/T1 are cleared and rebuilt per call, so the visible window tracks the scroll
  position while T2 (background) persists. On a pure-scroll update the frontend may send
  an empty `background` (re-sending it is harmless — deduped — just wasteful); it sends a
  full `background` on folder load and when the focused folder's path set changes.

## Frontend changes

### `useThumbnails.ts`
- **Delete the random shuffle** (lines 16-19).
- Track `finalGenerated: Set` and `embeddedShown: Set` (replacing the single
  `generatedRef`); only a Final marks a path done. Pending tracked per tier.
- New API: `requestThumbnails({ visible, prefetch, background, generation, targetRes })`
  → debounced `set_thumbnail_priorities`. `clearThumbnailQueue` → `clear_thumbnail_queue`.

### `useAppNavigation.ts`
- Within-root subfolder navigation: **bump generation** and send the new folder's sets
  instead of calling `cancel_thumbnail_generation` (lines 274, 399). 
- Root change / library close: keep `clear_thumbnail_queue` (hard cancel).

### `LibraryGrid.tsx` / `Filmstrip.tsx`
- From the react-window callbacks (already present: `visibleRange`, start/stop indices,
  `overscanCount`), compute: `visible` = on-screen indices; `prefetch` = next page
  (≈ one viewport beyond, reuse overscan window); `background` = remaining folder paths.
- Recursive view mode: enqueue only the **selected** subfolder's paths (others excluded
  from all three sets).

### `useTauriListeners.ts`
- `thumbnail-generated` payload gains `stage`. On `"embedded"`: set the image only if no
  Final has arrived for that path; mark `embeddedShown`. On `"final"`: always set, mark
  `finalGenerated`, so a late embedded can never overwrite a Final.

### Resolution (`SettingsPanel.tsx` + util)
- `thumbnailResolution: "auto" | number`; default `"auto"`. Manual list gains 320, 480.
- New util `resolveThumbnailRes(cellCssPx, dpr)`: `cellCssPx * dpr`, snapped up to nearest
  bucket in `{256,384,512,640,768,1024}`, clamped `[256,1024]`. Computed per grid size
  (small/medium/large) and passed as `target_res` on each request.

## Data flow walkthroughs

**Open folder F (gen 1):** list images → frontend sends visible→T0/T1, prefetch→T1,
rest→T2 at gen 1, target_res from grid. Workers: embedded for visible appears in ~ms
(instant grid), then develop replaces visible, then prefetch, then T2 fills the folder
while idle.

**Scroll:** viewport changes → re-send visible/prefetch (gen 1). New on-screen items get
instant embedded then develop; T2 backlog waits because T0/T1 refilled.

**Navigate F→G:** frontend bumps to gen 2, sends G's sets. Backend demotes all F items
(tier<2) to T2 gen 1. Order becomes T0(G) → T1(G) → T2(G) → T2(F). G feels instant; F's
leftovers resume only after G is fully filled (D2). Returning to F bumps gen 3; F's
cached Finals are instant, only missing ones re-queue.

## Error handling & fallbacks

- Embedded extraction `None`/`Err` → no placeholder; Final still comes. Never fatal.
- Embedded must not be marked as "generated" (Final still owed) — enforced by per-stage
  tracking on both sides.
- In-flight develop on a demoted folder is allowed to finish (no mid-decode preempt);
  bounded by `thread_count`.
- T2 cap drop is logged (no silent truncation).
- Non-RAW images: skip embedded, go straight to Final (unchanged behavior).

## Testing strategy

- **Rust unit:** `PrioritizedThumb` ordering (tier/generation/seq); demotion-on-new-
  generation; T2 cap dropping lowest priority; cache hash varies with target_res;
  embedded fallback chain returns first `Some` and tolerates `None`/panic.
- **Rust integration:** enqueue mixed tiers/generations, drain, assert pop order matches
  the A→B walkthrough.
- **Frontend:** late-embedded-after-final does not overwrite; shuffle removed (order
  preserved); navigation bumps generation and does not hard-cancel within a root;
  resolution resolver bucketing/clamping.
- **Manual:** on the ~23k-image library — grid shows embedded ~instantly; scrolling stays
  responsive; navigate A→B then back; verify no crash regression vs. current Vulkan path.

## Risks / open items

- **rawler coverage:** `preview_image`/`thumbnail_image` default to `None`; Sony .ARW
  coverage in the pinned `RapidRAW-DngLab` 0.7.1 must be verified — if a format yields no
  embedded image, that format simply has no placeholder (graceful). Confirm at impl.
- **Embedded aspect/orientation** must match the developed crop closely enough to avoid a
  jarring "pop"; verify orientation handling.
- **Cache invalidation:** adding `target_res` orphans existing cache files; acceptable,
  but note disk growth across resolution buckets (existing cache has no GC — out of scope
  but flagged).
- **Scroll churn:** very fast scrolling could thrash T0/T1 re-sends; the 150ms/300ms
  debounce in `useThumbnails` should absorb it — validate.

## Touch points

- `src-tauri/src/app_state.rs` — `ThumbnailManager` (priority queue, per-stage
  `processing_now`), `thumbnail_generation` atomic.
- `src-tauri/src/file_management.rs` — worker loop, `set_thumbnail_priorities` /
  `clear_thumbnail_queue` commands, `extract_embedded_preview`, cache hash, progress.
- `src-tauri/src/image_loader.rs` / `raw_processing.rs` — embedded extractor helper.
- `src-tauri/src/lib.rs` — command registration.
- `src/hooks/useThumbnails.ts` — tiers, no shuffle, per-stage tracking.
- `src/hooks/useAppNavigation.ts` — demote vs cancel.
- `src/hooks/useTauriListeners.ts` — `stage` handling.
- `src/components/panel/library/LibraryGrid.tsx`, `src/components/panel/Filmstrip.tsx`
  — visible/prefetch/background sets, recursive-mode scoping.
- `src/components/panel/SettingsPanel.tsx` + new resolution util — auto + 320/480.
