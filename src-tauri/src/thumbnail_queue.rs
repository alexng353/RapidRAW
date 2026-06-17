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
