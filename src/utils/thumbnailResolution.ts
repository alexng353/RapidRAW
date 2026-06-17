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
