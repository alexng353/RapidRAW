# Preview Prioritization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the library grid feel instant and stay responsive by showing embedded RAW previews immediately, generating developed thumbnails at the on-screen size, and ordering work by a priority queue (visible → next-page → background) that demotes (not discards) the previous folder on navigation.

**Architecture:** Backend gains a tiered priority queue (`thumbnail_queue.rs`) ordered `(tier asc, generation desc, seq asc)`. A two-pass flow emits an embedded-JPEG placeholder then a developed final. The frontend tags each path's tier from the react-window viewport it already tracks, owns a monotonic generation counter, and resolves a per-grid target resolution.

**Tech Stack:** Rust (Tauri 2, rayon, blake3, rawler 0.7.1 git pin), React 19 + TypeScript, Zustand, react-window.

**Reference spec:** `docs/superpowers/specs/2026-06-17-preview-prioritization-design.md`

## Global Constraints

- Rust edition 2024, `rust-version = 1.95`. Match surrounding style (the crate uses `if let ... && ...` let-chains).
- No new JS test framework (none exists). Rust crate currently has zero tests; add `#[cfg(test)]` modules via `cargo test`.
- Thumbnails are delivered as `data:image/jpeg;base64,...` strings via the `thumbnail-generated` event — keep that transport.
- Paths may carry a virtual-copy suffix `?vc=<id>`; always route through `parse_virtual_path` (do not split on `?` manually).
- Commits are **local on branch `feat/preview-prioritization`**. Do NOT push or open a PR — the user reviews first.
- After each task: `cargo build` (Rust) or `npm run typecheck && npm run lint` (frontend) must pass.

---

## File Structure

**Backend (`src-tauri/src/`)**
- `thumbnail_queue.rs` *(new)* — priority-queue types + ordering + mutation ops. Pure, unit-tested.
- `app_state.rs` *(modify)* — `ThumbnailManager` holds the new queue; remove the per-stage dedup foot-gun.
- `file_management.rs` *(modify)* — worker loop, new commands, embedded extractor call, cache hash, progress.
- `image_loader.rs` *(modify)* — `extract_embedded_preview` helper.
- `lib.rs` *(modify)* — `mod thumbnail_queue;`, command registration.

**Frontend (`src/`)**
- `utils/thumbnailResolution.ts` *(new)* — pure resolver `cellPx×dpr → bucket`.
- `components/ui/AppProperties.tsx` *(modify)* — invoke names + types.
- `hooks/useThumbnails.ts` *(modify)* — tiers, generation, no shuffle, per-stage tracking.
- `hooks/useTauriListeners.ts` *(modify)* — `stage` handling.
- `hooks/useAppNavigation.ts` *(modify)* — demote on within-root nav.
- `components/panel/library/LibraryGrid.tsx`, `components/panel/Filmstrip.tsx` *(modify)* — visible/prefetch/background + targetRes.
- `components/panel/SettingsPanel.tsx` *(modify)* — auto option + 320/480.
- `App.tsx` *(modify)* — thread `beginFolder` through.

---

## Task 1: Priority-queue module (`thumbnail_queue.rs`)

**Files:**
- Create: `src-tauri/src/thumbnail_queue.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod thumbnail_queue;` near the other `mod` declarations)

**Interfaces:**
- Produces:
  - `pub enum Stage { Embedded, Final }`
  - `pub const TIER_EMBEDDED: u8 = 0; TIER_DEVELOP_HIGH: u8 = 1; TIER_DEVELOP_LOW: u8 = 2;`
  - `pub struct ThumbItem { pub tier: u8, pub generation: u64, pub seq: u64, pub path: String, pub stage: Stage, pub target_res: u32 }`
  - `pub struct ThumbnailQueue` with: `new(max_background: usize)`, `current_generation() -> u64`, `is_empty() -> bool`, `len() -> usize`, `push(tier,generation,path,stage,target_res)`, `pop() -> Option<ThumbItem>`, `clear()`, `advance_generation(generation: u64)`, `clear_high_tiers_for_generation(generation: u64)`, `enforce_background_cap() -> usize`, `final_count() -> usize`.

- [ ] **Step 1: Write the module with implementation and failing tests**

Create `src-tauri/src/thumbnail_queue.rs`:

```rust
use std::cmp::Ordering;
use std::collections::BinaryHeap;

pub const TIER_EMBEDDED: u8 = 0;
pub const TIER_DEVELOP_HIGH: u8 = 1;
pub const TIER_DEVELOP_LOW: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Stage {
    Embedded,
    Final,
}

#[derive(Debug, Clone)]
pub struct ThumbItem {
    pub tier: u8,
    pub generation: u64,
    pub seq: u64,
    pub path: String,
    pub stage: Stage,
    pub target_res: u32,
}

// Identity for the heap is (tier, generation, seq); seq is unique & monotonic so
// no two live items collide. Ord below is kept consistent with this Eq.
impl PartialEq for ThumbItem {
    fn eq(&self, other: &Self) -> bool {
        self.tier == other.tier && self.generation == other.generation && self.seq == other.seq
    }
}
impl Eq for ThumbItem {}

impl Ord for ThumbItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap is a max-heap: the highest-priority item must compare Greater.
        // Priority order: lower tier, then higher generation, then lower seq.
        other
            .tier
            .cmp(&self.tier)
            .then_with(|| self.generation.cmp(&other.generation))
            .then_with(|| other.seq.cmp(&self.seq))
    }
}
impl PartialOrd for ThumbItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct ThumbnailQueue {
    heap: BinaryHeap<ThumbItem>,
    next_seq: u64,
    current_generation: u64,
    max_background: usize,
}

impl ThumbnailQueue {
    pub fn new(max_background: usize) -> Self {
        Self {
            heap: BinaryHeap::new(),
            next_seq: 0,
            current_generation: 0,
            max_background,
        }
    }

    pub fn current_generation(&self) -> u64 {
        self.current_generation
    }
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
    pub fn len(&self) -> usize {
        self.heap.len()
    }

    pub fn push(&mut self, tier: u8, generation: u64, path: String, stage: Stage, target_res: u32) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.heap.push(ThumbItem { tier, generation, seq, path, stage, target_res });
    }

    pub fn pop(&mut self) -> Option<ThumbItem> {
        self.heap.pop()
    }

    pub fn clear(&mut self) {
        self.heap.clear();
    }

    /// Advance to a newer generation: demote every queued item with tier < TIER_DEVELOP_LOW
    /// down to TIER_DEVELOP_LOW (keeping its generation), then record the new generation.
    /// No-op if `generation` is not greater than the current one.
    pub fn advance_generation(&mut self, generation: u64) {
        if generation <= self.current_generation {
            return;
        }
        let items: Vec<ThumbItem> = self
            .heap
            .drain()
            .map(|mut it| {
                if it.tier < TIER_DEVELOP_LOW {
                    it.tier = TIER_DEVELOP_LOW;
                }
                it
            })
            .collect();
        self.heap = items.into_iter().collect();
        self.current_generation = generation;
    }

    /// Remove items of `generation` whose tier < TIER_DEVELOP_LOW (used to retrack the
    /// viewport on scroll before re-adding the visible/prefetch window).
    pub fn clear_high_tiers_for_generation(&mut self, generation: u64) {
        let items: Vec<ThumbItem> = self
            .heap
            .drain()
            .filter(|it| !(it.generation == generation && it.tier < TIER_DEVELOP_LOW))
            .collect();
        self.heap = items.into_iter().collect();
    }

    /// Drop the lowest-priority background items when the background backlog exceeds the cap.
    /// Returns the number dropped.
    pub fn enforce_background_cap(&mut self) -> usize {
        let bg_count = self.heap.iter().filter(|it| it.tier == TIER_DEVELOP_LOW).count();
        if bg_count <= self.max_background {
            return 0;
        }
        let to_drop = bg_count - self.max_background;
        let mut items: Vec<ThumbItem> = self.heap.drain().collect();
        // Descending priority (highest first).
        items.sort_by(|a, b| b.cmp(a));
        let mut dropped = 0;
        let mut kept: Vec<ThumbItem> = Vec::with_capacity(items.len());
        // Walk lowest-priority first; drop background items until the cap is satisfied.
        for it in items.into_iter().rev() {
            if dropped < to_drop && it.tier == TIER_DEVELOP_LOW {
                dropped += 1;
                continue;
            }
            kept.push(it);
        }
        self.heap = kept.into_iter().collect();
        dropped
    }

    /// Count of Final-stage items queued (progress tracks develop work, not embedded).
    pub fn final_count(&self) -> usize {
        self.heap.iter().filter(|it| it.stage == Stage::Final).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain_paths(q: &mut ThumbnailQueue) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(it) = q.pop() {
            out.push(it.path);
        }
        out
    }

    #[test]
    fn pops_lower_tier_first() {
        let mut q = ThumbnailQueue::new(1000);
        q.push(TIER_DEVELOP_LOW, 1, "low".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_HIGH, 1, "high".into(), Stage::Final, 512);
        q.push(TIER_EMBEDDED, 1, "emb".into(), Stage::Embedded, 512);
        assert_eq!(drain_paths(&mut q), vec!["emb", "high", "low"]);
    }

    #[test]
    fn within_tier_higher_generation_first() {
        let mut q = ThumbnailQueue::new(1000);
        q.push(TIER_DEVELOP_LOW, 1, "old".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 2, "new".into(), Stage::Final, 512);
        assert_eq!(drain_paths(&mut q), vec!["new", "old"]);
    }

    #[test]
    fn within_tier_and_generation_is_fifo() {
        let mut q = ThumbnailQueue::new(1000);
        q.push(TIER_DEVELOP_HIGH, 1, "a".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_HIGH, 1, "b".into(), Stage::Final, 512);
        assert_eq!(drain_paths(&mut q), vec!["a", "b"]);
    }

    #[test]
    fn advance_generation_demotes_and_orders_b_before_a() {
        // Folder A (gen 1) has visible + prefetch queued; navigate to B (gen 2).
        let mut q = ThumbnailQueue::new(1000);
        q.advance_generation(1);
        q.push(TIER_EMBEDDED, 1, "a_emb".into(), Stage::Embedded, 512);
        q.push(TIER_DEVELOP_HIGH, 1, "a_dev".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 1, "a_bg".into(), Stage::Final, 512);

        q.advance_generation(2); // demotes a_emb/a_dev to TIER_DEVELOP_LOW gen 1
        q.push(TIER_EMBEDDED, 2, "b_emb".into(), Stage::Embedded, 512);
        q.push(TIER_DEVELOP_HIGH, 2, "b_dev".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 2, "b_bg".into(), Stage::Final, 512);

        // B fully (incl. background) before any of A.
        let order = drain_paths(&mut q);
        let b_last = order.iter().position(|p| p == "b_bg").unwrap();
        let a_first = order.iter().position(|p| p.starts_with("a_")).unwrap();
        assert!(b_last < a_first, "all B items must precede all A items: {:?}", order);
        assert_eq!(order[0], "b_emb");
        assert_eq!(order[1], "b_dev");
    }

    #[test]
    fn clear_high_tiers_keeps_background() {
        let mut q = ThumbnailQueue::new(1000);
        q.push(TIER_EMBEDDED, 1, "emb".into(), Stage::Embedded, 512);
        q.push(TIER_DEVELOP_HIGH, 1, "hi".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 1, "bg".into(), Stage::Final, 512);
        q.clear_high_tiers_for_generation(1);
        assert_eq!(drain_paths(&mut q), vec!["bg"]);
    }

    #[test]
    fn enforce_background_cap_drops_lowest_priority() {
        let mut q = ThumbnailQueue::new(2);
        q.push(TIER_DEVELOP_LOW, 2, "keep_new".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 1, "keep_mid".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 1, "drop_old".into(), Stage::Final, 512);
        let dropped = q.enforce_background_cap();
        assert_eq!(dropped, 1);
        let remaining = drain_paths(&mut q);
        assert!(!remaining.contains(&"drop_old".to_string()), "{:?}", remaining);
        assert_eq!(remaining.len(), 2);
    }

    #[test]
    fn final_count_excludes_embedded() {
        let mut q = ThumbnailQueue::new(1000);
        q.push(TIER_EMBEDDED, 1, "emb".into(), Stage::Embedded, 512);
        q.push(TIER_DEVELOP_HIGH, 1, "f1".into(), Stage::Final, 512);
        q.push(TIER_DEVELOP_LOW, 1, "f2".into(), Stage::Final, 512);
        assert_eq!(q.final_count(), 2);
    }
}
```

- [ ] **Step 2: Register the module.** In `src-tauri/src/lib.rs`, add alongside the existing `mod` lines: `pub mod thumbnail_queue;`

- [ ] **Step 3: Run tests, expect PASS**

Run: `cd src-tauri && cargo test thumbnail_queue`
Expected: 7 tests pass. (If `advance_generation_demotes_and_orders_b_before_a` fails, the `Ord` priority direction is wrong — re-check the `other.tier.cmp(&self.tier)` / `self.generation.cmp(&other.generation)` directions.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/thumbnail_queue.rs src-tauri/src/lib.rs
git commit -m "feat(thumbnails): add tiered priority queue with ordering + tests"
```

---

## Task 2: Wire the priority queue into the manager, worker, and commands

**Files:**
- Modify: `src-tauri/src/app_state.rs` (`ThumbnailManager`)
- Modify: `src-tauri/src/file_management.rs:1400-1527` (`start_thumbnail_workers`, replace `update_thumbnail_queue`, add `set_thumbnail_priorities` + `clear_thumbnail_queue`)
- Modify: `src-tauri/src/lib.rs` (command registration ~2240/2275; `cancel_thumbnail_generation` ~240)

**Interfaces:**
- Consumes: everything from Task 1 (`ThumbnailQueue`, `ThumbItem`, `Stage`, `TIER_*`).
- Produces (Tauri commands callable from the frontend):
  - `set_thumbnail_priorities(generation: u64, visible: Vec<String>, prefetch: Vec<String>, background: Vec<String>, target_res: u32, app_handle)`
  - `clear_thumbnail_queue(app_handle)`

- [ ] **Step 1: Update `ThumbnailManager`** in `src-tauri/src/app_state.rs`.

Replace the struct (currently `queue: Mutex<VecDeque<String>>`, `cvar`, `processing_now: Mutex<HashSet<String>>`) and its `new()`:

```rust
pub struct ThumbnailManager {
    pub queue: Mutex<crate::thumbnail_queue::ThumbnailQueue>,
    pub cvar: Condvar,
    // dedup keyed by (path, is_embedded) so an in-flight embedded job does not
    // block that path's develop job.
    pub processing_now: Mutex<HashSet<(String, bool)>>,
}

impl ThumbnailManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(crate::thumbnail_queue::ThumbnailQueue::new(2000)),
            cvar: Condvar::new(),
            processing_now: Mutex::new(HashSet::new()),
        })
    }
}
```

Remove the now-unused `use std::collections::VecDeque;` import if it becomes unused (let `cargo build` warnings guide you).

- [ ] **Step 2: Rewrite the worker loop** in `start_thumbnail_workers` (`file_management.rs:1411-1464`). Replace the body of the spawned thread loop:

```rust
std::thread::spawn(move || {
    loop {
        let item = {
            let mut queue = manager_clone.queue.lock().unwrap();
            let item = loop {
                if let Some(it) = queue.pop() {
                    break it;
                }
                queue = manager_clone.cvar.wait(queue).unwrap();
            };

            let is_embedded = matches!(item.stage, crate::thumbnail_queue::Stage::Embedded);
            let mut processing = manager_clone.processing_now.lock().unwrap();
            if processing.contains(&(item.path.clone(), is_embedded)) {
                if !is_embedded {
                    let state = app_clone.state::<crate::AppState>();
                    increment_thumbnail_progress(&state, &app_clone);
                }
                continue;
            }
            processing.insert((item.path.clone(), is_embedded));
            item
        };

        let is_embedded = matches!(item.stage, crate::thumbnail_queue::Stage::Embedded);
        let state = app_clone.state::<crate::AppState>();
        let gpu_context = crate::gpu_processing::get_or_init_gpu_context(&state, &app_clone).ok();

        if is_embedded {
            // Embedded placeholder: cheap, not counted in progress, not cached.
            if let Some(data_url) =
                generate_embedded_preview_data(&item.path, item.target_res, &app_clone)
            {
                let _ = app_clone.emit(
                    "thumbnail-generated",
                    serde_json::json!({
                        "path": item.path,
                        "data": data_url,
                        "stage": "embedded",
                    }),
                );
            }
        } else if let Ok(cache_dir) = get_thumb_cache_dir(&app_clone) {
            let result = generate_single_thumbnail_and_cache(
                &item.path,
                &cache_dir,
                gpu_context.as_ref(),
                None,
                false,
                &app_clone,
                &worker_settings,
                item.target_res,
            );
            if let Some((thumbnail_data, rating, is_edited)) = result {
                let _ = app_clone.emit(
                    "thumbnail-generated",
                    serde_json::json!({
                        "path": item.path,
                        "data": thumbnail_data,
                        "rating": rating,
                        "is_edited": is_edited,
                        "stage": "final",
                    }),
                );
            }
            increment_thumbnail_progress(&state, &app_clone);
        }

        manager_clone
            .processing_now
            .lock()
            .unwrap()
            .remove(&(item.path.clone(), is_embedded));
    }
});
```

> Note: `generate_embedded_preview_data` and the new `target_res` parameter on
> `generate_single_thumbnail_and_cache` are added in Tasks 3 and 4. To keep this task
> compiling on its own, add a temporary shim now and replace it in those tasks: add
> `item.target_res` to the call only after Task 3. **Implementer:** do Tasks 2→3→4 in
> order; between Task 2 and Task 3 the build will be red on the `target_res` arg and the
> missing `generate_embedded_preview_data` — that is expected and resolved by Task 3/4.
> If you require each task green, fold Tasks 2-4 into one commit. (Recommended: one
> commit at the end of Task 4; run `cargo build` then.)

- [ ] **Step 3: Replace `update_thumbnail_queue`** (`file_management.rs:1468-1527`) with two commands:

```rust
#[tauri::command]
pub fn set_thumbnail_priorities(
    generation: u64,
    visible: Vec<String>,
    prefetch: Vec<String>,
    background: Vec<String>,
    target_res: u32,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use crate::thumbnail_queue::{Stage, TIER_DEVELOP_HIGH, TIER_DEVELOP_LOW, TIER_EMBEDDED};
    let state = app_handle.state::<crate::AppState>();
    let mut queue = state.thumbnail_manager.queue.lock().unwrap();

    // New generation => demote prior folder's high-tier work to background.
    queue.advance_generation(generation);
    // Retrack the viewport for this generation.
    queue.clear_high_tiers_for_generation(generation);

    for path in &visible {
        queue.push(TIER_EMBEDDED, generation, path.clone(), Stage::Embedded, target_res);
        queue.push(TIER_DEVELOP_HIGH, generation, path.clone(), Stage::Final, target_res);
    }
    for path in prefetch {
        queue.push(TIER_DEVELOP_HIGH, generation, path, Stage::Final, target_res);
    }
    for path in background {
        queue.push(TIER_DEVELOP_LOW, generation, path, Stage::Final, target_res);
    }

    let dropped = queue.enforce_background_cap();
    if dropped > 0 {
        log::info!("[thumbnails] background cap exceeded; dropped {} oldest items", dropped);
    }

    let final_remaining = queue.final_count();
    drop(queue);

    // Progress reflects Final develop work only.
    let mut tracker = state.thumbnail_progress.lock().unwrap();
    tracker.total = tracker.completed + final_remaining;
    let (current, total) = (tracker.completed, tracker.total);
    drop(tracker);
    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": current, "total": total }),
    );

    state.thumbnail_manager.cvar.notify_all();
    Ok(())
}

#[tauri::command]
pub fn clear_thumbnail_queue(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<crate::AppState>();
    {
        let mut queue = state.thumbnail_manager.queue.lock().unwrap();
        queue.clear();
    }
    {
        let mut tracker = state.thumbnail_progress.lock().unwrap();
        tracker.total = 0;
        tracker.completed = 0;
    }
    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": 0, "total": 0 }),
    );
    state.thumbnail_manager.cvar.notify_all();
    Ok(())
}
```

Keep `add_to_thumbnail_queue` and `increment_thumbnail_progress` as-is.

- [ ] **Step 4: Update command registration** in `src-tauri/src/lib.rs`. In the `tauri::generate_handler![...]` list, replace `file_management::update_thumbnail_queue,` with:
```rust
            file_management::set_thumbnail_priorities,
            file_management::clear_thumbnail_queue,
```
Leave `cancel_thumbnail_generation` registered (still used for root-change hard cancel via the existing token).

- [ ] **Step 5: Build** (after Tasks 3 & 4 land the missing symbols)

Run: `cd src-tauri && cargo build`
Expected: compiles. Until Task 3/4, expect errors for `generate_embedded_preview_data` and the `target_res` argument — proceed to Task 3.

- [ ] **Step 6: Commit (or defer to end of Task 4)**

```bash
git add src-tauri/src/app_state.rs src-tauri/src/file_management.rs src-tauri/src/lib.rs
git commit -m "feat(thumbnails): drive workers from priority queue; add set/clear commands"
```

---

## Task 3: Thread target resolution through develop + cache key

**Files:**
- Modify: `src-tauri/src/file_management.rs` — `compute_thumbnail_cache_hash` (65-81), `encode_thumbnail` (1329-1335), `generate_thumbnail_data` (1030+, uses `settings.thumbnail_resolution`), `generate_single_thumbnail_and_cache` (1337+).

**Interfaces:**
- Produces: `generate_single_thumbnail_and_cache(..., settings, target_res: u32)`; `compute_thumbnail_cache_hash(path_str, adjustments_bytes, target_res)`.

- [ ] **Step 1: Add `target_res` to the cache hash test + impl**

In `compute_thumbnail_cache_hash`, change the signature and add the field to the hash:

```rust
fn compute_thumbnail_cache_hash(
    path_str: &str,
    adjustments_bytes: &[u8],
    target_res: u32,
) -> Option<String> {
    let (source_path, _) = parse_virtual_path(path_str);
    let img_mod_time = fs::metadata(&source_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let mut hasher = blake3::Hasher::new();
    hasher.update(path_str.as_bytes());
    hasher.update(&img_mod_time.to_le_bytes());
    hasher.update(adjustments_bytes);
    hasher.update(&target_res.to_le_bytes());
    Some(hasher.finalize().to_hex().to_string())
}
```

Add a test module at the end of `file_management.rs` (or extend an existing one):

```rust
#[cfg(test)]
mod cache_hash_tests {
    use super::*;
    #[test]
    fn cache_hash_varies_with_target_res() {
        // Uses a real file path so metadata() succeeds: the crate's own Cargo.toml.
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let a = compute_thumbnail_cache_hash(p, b"{}", 512);
        let b = compute_thumbnail_cache_hash(p, b"{}", 640);
        assert!(a.is_some() && b.is_some());
        assert_ne!(a, b, "different target_res must produce different cache keys");
    }
}
```

- [ ] **Step 2: Thread `target_res` into the develop path.**
  - `encode_thumbnail(image, target_width)` already takes a width — keep it; callers pass `target_res`.
  - In `generate_thumbnail_data` replace `let target_res = settings.thumbnail_resolution.unwrap_or(720);` with a `target_res: u32` parameter on the function and use it.
  - In `generate_single_thumbnail_and_cache` add a trailing `target_res: u32` parameter; pass it to `compute_thumbnail_cache_hash(path_str, &adjustments_bytes, target_res)`, to `generate_thumbnail_data(..., target_res)`, and to `encode_thumbnail(&thumb_image, target_res)`.
  - Update any other caller of these functions (grep `generate_single_thumbnail_and_cache` / `generate_thumbnail_data` across `src-tauri/src`); pass `settings.thumbnail_resolution.unwrap_or(720)` at non-worker call sites to preserve behavior.

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test cache_hash`
Expected: PASS.

- [ ] **Step 4: (commit deferred to Task 4)**

---

## Task 4: Embedded-preview extractor + two-pass emit

**Files:**
- Modify: `src-tauri/src/image_loader.rs` — add `extract_embedded_preview`.
- Modify: `src-tauri/src/file_management.rs` — add `generate_embedded_preview_data` (wraps extractor → base64 data URL), used by the worker (Task 2 Step 2).

**Interfaces:**
- Consumes: rawler `get_decoder`, `RawSource`, `RawDecodeParams` (see `raw_processing.rs:67-70` for the existing pattern).
- Produces:
  - `pub fn extract_embedded_preview(path_str: &str, target_res: u32) -> Option<image::DynamicImage>` (in `image_loader.rs`)
  - `fn generate_embedded_preview_data(path_str: &str, target_res: u32, app_handle: &AppHandle) -> Option<String>` (in `file_management.rs`)

- [ ] **Step 1: Implement the extractor** in `src-tauri/src/image_loader.rs`:

```rust
/// Extract an embedded JPEG preview from a RAW file, oriented and downscaled to
/// `target_res` (longest edge). Returns None for non-RAW files or RAWs without an
/// embedded preview, or on any decode error/panic (caller falls back to develop).
pub fn extract_embedded_preview(path_str: &str, target_res: u32) -> Option<image::DynamicImage> {
    use crate::formats::is_raw_file;
    if !is_raw_file(path_str) {
        return None;
    }
    let (source_path, _) = crate::file_management::parse_virtual_path(path_str);

    std::panic::catch_unwind(|| {
        let source = rawler::RawSource::new(&source_path).ok()?;
        let decoder = rawler::get_decoder(&source).ok()?;
        let params = rawler::decoders::RawDecodeParams::default();

        // Prefer the medium preview, then thumbnail, then full embedded image.
        let img = decoder
            .preview_image(&source, &params)
            .ok()
            .flatten()
            .or_else(|| decoder.thumbnail_image(&source, &params).ok().flatten())
            .or_else(|| decoder.full_image(&source, &params).ok().flatten())?;

        // Match the developed thumbnail's downscale (longest edge == target_res).
        Some(crate::image_processing::downscale_f32_image(&img, target_res, target_res))
    })
    .ok()
    .flatten()
}
```

> **Verify at implementation:** the exact constructor for `RawSource` and the module path
> of `RawDecodeParams` in rawler 0.7.1 (git pin `f2325223`). The existing code at
> `raw_processing.rs:67-70` constructs a `source` and calls `decoder.raw_image(&source,
> &RawDecodeParams::default(), false)` — mirror however `source`/params are obtained
> there. If `preview_image`/`thumbnail_image` are not public in this pin, fall back to
> `full_image` only; if none compile, this feature degrades to "no placeholder" — keep
> the function returning `None` and the rest of the system still works.

Confirm `parse_virtual_path` is `pub` (it is used cross-module already); if not, make it `pub`.

- [ ] **Step 2: Implement the data-URL wrapper** in `src-tauri/src/file_management.rs` (near `encode_thumbnail`):

```rust
fn generate_embedded_preview_data(
    path_str: &str,
    target_res: u32,
    _app_handle: &AppHandle,
) -> Option<String> {
    let img = crate::image_loader::extract_embedded_preview(path_str, target_res)?;
    let mut buf = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80)
        .encode_image(&img.to_rgb8())
        .ok()?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Some(format!("data:image/jpeg;base64,{}", base64_str))
}
```

(Confirm `general_purpose`/`STANDARD` is the same base64 import already used at `file_management.rs:1375`.)

- [ ] **Step 3: Build the whole crate**

Run: `cd src-tauri && cargo build`
Expected: compiles clean. Fix any rawler API mismatches per the Step-1 note.

- [ ] **Step 4: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: Task 1 + Task 3 tests pass.

- [ ] **Step 5: Commit Tasks 2-4 together**

```bash
git add src-tauri/src/
git commit -m "feat(thumbnails): embedded-preview placeholder + target-res develop & cache key"
```

---

## Task 5: Frontend resolution resolver util

**Files:**
- Create: `src/utils/thumbnailResolution.ts`
- Modify: `src/components/ui/AppProperties.tsx` (add invoke names + `thumbnailResolution` type)

**Interfaces:**
- Produces: `resolveThumbnailRes(cellCssPx: number, dpr: number): number`; `THUMBNAIL_RES_BUCKETS`; invoke enum entries `SetThumbnailPriorities = 'set_thumbnail_priorities'`, `ClearThumbnailQueue = 'clear_thumbnail_queue'`.

- [ ] **Step 1: Create the util**

```typescript
// src/utils/thumbnailResolution.ts
export const THUMBNAIL_RES_BUCKETS = [256, 384, 512, 640, 768, 1024] as const;

/** Map an on-screen cell size to a cached develop resolution.
 *  target = ceil(cellCssPx * dpr), snapped up to the nearest bucket, clamped [256,1024]. */
export function resolveThumbnailRes(cellCssPx: number, dpr: number): number {
  const want = Math.ceil(Math.max(1, cellCssPx) * Math.max(1, dpr));
  for (const b of THUMBNAIL_RES_BUCKETS) {
    if (want <= b) return b;
  }
  return THUMBNAIL_RES_BUCKETS[THUMBNAIL_RES_BUCKETS.length - 1];
}
```

- [ ] **Step 2: Add invoke names.** In `src/components/ui/AppProperties.tsx`, in the `Invokes` enum (near `ListImagesInDir` ~line 75), add:
```typescript
  SetThumbnailPriorities = 'set_thumbnail_priorities',
  ClearThumbnailQueue = 'clear_thumbnail_queue',
```
Remove `UpdateThumbnailQueue` if present. Update the `thumbnailResolution` type wherever the settings type lives to `number | 'auto'`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: passes. (No JS test runner; `resolveThumbnailRes` is pure — sanity-check by hand: `resolveThumbnailRes(150, 2) === 384`, `resolveThumbnailRes(64, 1) === 256`, `resolveThumbnailRes(900, 2) === 1024`.)

- [ ] **Step 4: Commit**

```bash
git add src/utils/thumbnailResolution.ts src/components/ui/AppProperties.tsx
git commit -m "feat(thumbnails): add resolution resolver util + invoke names"
```

---

## Task 6: Settings — auto resolution + smaller options

**Files:**
- Modify: `src/components/panel/SettingsPanel.tsx` (`thumbnailResolutions` list ~124, defaults ~534/642, change handler ~1831)

- [ ] **Step 1:** Change the `thumbnailResolutions` options list to include an Auto entry and smaller sizes:
```typescript
const thumbnailResolutions: OptionItem<number | 'auto'>[] = [
  { value: 'auto', label: 'Auto (match grid)' },
  { value: 320, label: '320px' },
  { value: 480, label: '480px' },
  { value: 640, label: '640px' },
  { value: 720, label: '720px' },
  { value: 1024, label: '1024px' },
  { value: 1920, label: '1920px' },
];
```
(Keep existing larger entries if present.)

- [ ] **Step 2:** Make `'auto'` the default fallback: change `appSettings?.thumbnailResolution || 720` occurrences (~534, ~642) to `appSettings?.thumbnailResolution ?? 'auto'`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: passes.
Manual: Settings → Processing shows "Auto (match grid)" selected by default plus 320/480.

- [ ] **Step 4: Commit**

```bash
git add src/components/panel/SettingsPanel.tsx
git commit -m "feat(settings): auto thumbnail resolution default + 320/480 options"
```

---

## Task 7: `useThumbnails` — tiers, generation, no shuffle

**Files:**
- Modify: `src/hooks/useThumbnails.ts` (full rewrite of the hook body)

**Interfaces:**
- Produces hook API:
  - `requestThumbnails({ visible: string[], prefetch: string[], background: string[], targetRes: number }): void`
  - `beginFolder(): void` — bump generation + reset per-view tracking (call on within-root navigation)
  - `clearThumbnailQueue(): void` — hard clear (root change/close)
  - `markGenerated(path: string): void` — a Final arrived
- Consumes: `Invokes.SetThumbnailPriorities`, `Invokes.ClearThumbnailQueue`.

- [ ] **Step 1: Rewrite** `src/hooks/useThumbnails.ts`:

```typescript
import { useRef, useCallback, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { Invokes } from '../components/ui/AppProperties';

interface ThumbnailRequest {
  visible: string[];
  prefetch: string[];
  background: string[];
  targetRes: number;
}

export function useThumbnails() {
  const finalGeneratedRef = useRef<Set<string>>(new Set());
  const generationRef = useRef<number>(1);
  const latestRequestRef = useRef<ThumbnailRequest | null>(null);

  const flush = useMemo(
    () =>
      debounce(
        () => {
          const req = latestRequestRef.current;
          if (!req) return;
          // Drop paths whose Final already arrived (background may legitimately repeat).
          const notDone = (p: string) => !finalGeneratedRef.current.has(p);
          invoke(Invokes.SetThumbnailPriorities, {
            generation: generationRef.current,
            visible: req.visible.filter(notDone),
            prefetch: req.prefetch.filter(notDone),
            background: req.background.filter(notDone),
            targetRes: req.targetRes,
          }).catch((err) => console.error('Failed to set thumbnail priorities:', err));
        },
        150,
        { maxWait: 300 },
      ),
    [],
  );

  const requestThumbnails = useCallback(
    (req: ThumbnailRequest) => {
      latestRequestRef.current = req;
      flush();
    },
    [flush],
  );

  const beginFolder = useCallback(() => {
    // Demote previous folder (backend) by advancing the generation; reset per-view
    // "already generated" tracking so the new folder's items are requested again.
    generationRef.current += 1;
    finalGeneratedRef.current.clear();
    latestRequestRef.current = null;
  }, []);

  const markGenerated = useCallback((path: string) => {
    finalGeneratedRef.current.add(path);
  }, []);

  const clearThumbnailQueue = useCallback(() => {
    finalGeneratedRef.current.clear();
    latestRequestRef.current = null;
    flush.cancel();
    invoke(Invokes.ClearThumbnailQueue).catch(console.error);
  }, [flush]);

  useEffect(() => () => flush.cancel(), [flush]);

  return { requestThumbnails, beginFolder, clearThumbnailQueue, markGenerated };
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: `useThumbnails.ts` itself compiles. Call-site mismatches (LibraryGrid/Filmstrip pass `string[]`) are fixed in Task 9; `requestThumbnails` is consumed as `any` in the view components so typecheck stays green at the boundary. `beginFolder` is newly returned; it is wired in Task 10.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useThumbnails.ts
git commit -m "feat(thumbnails): tiered requests, generation, remove random shuffle"
```

---

## Task 8: `useTauriListeners` — two-pass stage handling

**Files:**
- Modify: `src/hooks/useTauriListeners.ts` (`thumbnail-generated` handler ~98-115; buffers ~28)

- [ ] **Step 1:** Add an embedded tracker and respect stage. Near the other buffers (~28) add:
```typescript
  const finalArrived = useRef<Set<string>>(new Set());
```
Replace the `thumbnail-generated` handler (~98-115):
```typescript
      listen('thumbnail-generated', (event: any) => {
        if (!isEffectActive) return;
        const { path, data, rating, is_edited, stage } = event.payload;

        if (data) {
          if (stage === 'final') {
            finalArrived.current.add(path);
            thumbnailBuffer.current[path] = data;
            refs.current.markGenerated(path);
          } else {
            // embedded placeholder: only show if a final hasn't already landed
            if (!finalArrived.current.has(path)) {
              thumbnailBuffer.current[path] = data;
            }
          }
        }
        if (rating !== undefined) ratingBuffer.current[path] = rating;
        if (is_edited !== undefined) editStatusBuffer.current[path] = is_edited;
        if (data || rating !== undefined || is_edited !== undefined) scheduleFlush();
      }),
```
Where the buffers are reset on folder change (search for `thumbnailBuffer.current = {}` ~340), also reset `finalArrived.current = new Set();`.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTauriListeners.ts
git commit -m "feat(thumbnails): two-pass stage handling (embedded then final)"
```

---

## Task 9: Grid & Filmstrip — visible / prefetch / background + targetRes

**Files:**
- Modify: `src/components/panel/library/LibraryGrid.tsx` (viewport calc ~296-340, ~376; onScroll ~517)
- Modify: `src/components/panel/Filmstrip.tsx` (`visibleRange` ~349, callback ~436-465)

**Interfaces:**
- Consumes: `requestThumbnails({visible, prefetch, background, targetRes})` (Task 7); `resolveThumbnailRes` (Task 5).

- [ ] **Step 1: LibraryGrid.** Where it currently computes visible paths and calls `requestThumbnails(paths)`, compute three sets from the react-window rendered range and the full `imageList`:
```typescript
import { resolveThumbnailRes } from '../../../utils/thumbnailResolution';
// ...inside the onItemsRendered / scroll handler, given visibleStart/visibleStop indices
// (the existing range vars) and the ordered `imageList` (or gridData) paths:
const allPaths = imageList.map((img: any) => img.path);
const pageSize = Math.max(1, visibleStop - visibleStart + 1);
const visible = allPaths.slice(visibleStart, visibleStop + 1);
const prefetch = allPaths.slice(visibleStop + 1, visibleStop + 1 + pageSize);
const background = allPaths.filter((_p, i) => i < visibleStart || i > visibleStop + pageSize);

const cellCssPx =
  thumbnailSize === 'small' ? 120 : thumbnailSize === 'large' ? 320 : 200; // match grid CSS
const targetRes =
  appSettings?.thumbnailResolution === 'auto' || appSettings?.thumbnailResolution == null
    ? resolveThumbnailRes(cellCssPx, window.devicePixelRatio || 1)
    : Number(appSettings.thumbnailResolution);

requestThumbnails({ visible, prefetch, background, targetRes });
```
> Use the component's actual rendered-range variables and its real cell sizing
> (`gridSize`/`thumbnailSize`); the `cellCssPx` mapping above must reflect the CSS the
> grid renders at. On a pure-scroll update you may pass `background: []` (Task-2 backend
> treats sets additively); send the full `background` once per folder load.

- [ ] **Step 2: Filmstrip.** Same idea using `visibleRange.current.start/stop` and the filmstrip's strip height as `cellCssPx`. Filmstrip prefetch = next `overscanCount` items; background = the rest (or `[]` for the filmstrip if you prefer to let the grid own background fill — pick one and be consistent; recommended: filmstrip sends only visible+prefetch, grid sends background).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: passes.
Manual: open a folder; confirm `set_thumbnail_priorities` fires with non-empty `visible` and a sane `targetRes` (add a temporary `console.log` if needed, then remove).

- [ ] **Step 4: Commit**

```bash
git add src/components/panel/library/LibraryGrid.tsx src/components/panel/Filmstrip.tsx
git commit -m "feat(thumbnails): viewport-tiered requests from grid & filmstrip"
```

---

## Task 10: Navigation — demote within root, hard-clear on root change

**Files:**
- Modify: `src/hooks/useAppNavigation.ts` (~274-275 within `handleSelectSubfolder`; ~399-400 other call site)
- Modify: `src/App.tsx` (~185 destructure `beginFolder`; pass to `useAppNavigation` props ~269)
- Modify: `src/hooks/useAppNavigation.ts` props interface (~17, ~31) to accept `beginFolder`.

**Interfaces:**
- Consumes: `beginFolder()` (Task 7).

- [ ] **Step 1:** In `App.tsx`, add `beginFolder` to the `useThumbnails()` destructure (~185) and pass it into `useAppNavigation({ clearThumbnailQueue, beginFolder, refs })` (~269). Add `beginFolder: () => void;` to `AppNavigationProps` (~17) and the destructure (~31).

- [ ] **Step 2:** In `handleSelectSubfolder` (within-root navigation), replace:
```typescript
        await invoke('cancel_thumbnail_generation');
        clearThumbnailQueue();
```
with:
```typescript
        beginFolder();
```
(Keep the existing `setProcess({ thumbnails: {} })` / `globalImageCache.clear()` so the displayed grid still resets.)

- [ ] **Step 3:** Inspect the **second** call site (~399). If it represents a root change / library close (e.g. setting a new root folder or going home), keep the hard clear but switch it to the new command path by leaving `clearThumbnailQueue()` (which now calls `clear_thumbnail_queue`) and removing the obsolete `await invoke('cancel_thumbnail_generation')` only if redundant. If it is in-root navigation, use `beginFolder()` instead. Decide per the function's purpose (read its surrounding code).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/hooks/useAppNavigation.ts
git commit -m "feat(thumbnails): demote previous folder on navigation instead of hard cancel"
```

---

## Task 11: Full build, format, and manual verification

- [ ] **Step 1: Backend**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds, all tests pass.

- [ ] **Step 2: Frontend gates**

Run: `npm run typecheck && npm run lint && npm run format`
Expected: clean.

- [ ] **Step 3: Manual verification** (against `~/Pictures` library; backend must be on Vulkan — `processingBackend: "auto"`, not the broken `gl`):
  - Open a subfolder: embedded placeholders appear near-instantly; developed thumbnails replace them visible-first.
  - Scroll fast: newly visible cells get instant placeholders; the grid stays responsive.
  - Navigate A → B before A finishes: B fills first (incl. background); A resumes only after B. Return to A: cached finals load fast.
  - Set Settings → Processing → Thumbnail Resolution = Auto; confirm smaller cells request a smaller `target_res` (smaller cache files, faster develop).
  - Confirm no crash regression versus the pre-change Vulkan behavior.

- [ ] **Step 4: Final commit (if any format/lint fixups)**

```bash
git add -A
git commit -m "chore(thumbnails): format + lint pass for preview prioritization"
```

> **Do not push or open a PR.** Hand back to the user for review.

---

## Self-Review (spec coverage)

- D1 embedded 2-pass → Tasks 4 (extractor/emit), 8 (stage handling). ✓
- D2 demote-A-finish-B → Tasks 1 (`advance_generation` + ordering test), 2 (command applies it), 10 (nav triggers it). ✓
- D3 auto+manual resolution → Tasks 3 (cache key), 5 (resolver), 6 (settings), 9 (per-grid target). ✓
- D4 backend priority queue + frontend tiering → Tasks 1, 2, 7, 9. ✓
- D5 idle = T2 drains when T0/T1 empty → falls out of Task 1 ordering + Task 2 worker pop. ✓
- Remove random shuffle → Task 7. ✓
- Background cap with logged drop → Task 1 (`enforce_background_cap`) + Task 2 (log). ✓
- Non-RAW skip embedded → Task 4 (`is_raw_file` guard). ✓
