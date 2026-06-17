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
