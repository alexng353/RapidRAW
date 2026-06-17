import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { List, useListCallbackRef } from 'react-window';
import { ChevronUp, ChevronDown } from 'lucide-react';
import debounce from 'lodash.debounce';
import { useTranslation } from 'react-i18next';
import { Row } from './LibraryItems';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { LibraryViewMode, SortDirection, ThumbnailSize } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights, TEXT_COLOR_KEYS } from '../../../types/typography';
import { ExifOverlay } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { resolveThumbnailRes } from '../../../utils/thumbnailResolution';

function ListHeader({ widths, setWidths, containerRef, sortCriteria, onSortChange }: any) {
  const { t } = useTranslation();
  const exifOverlay = useSettingsStore((s) => s.appSettings?.exifOverlay || ExifOverlay.Off);
  const showExifCols = exifOverlay !== ExifOverlay.Off;
  const totalRawWidth =
    widths.thumbnail +
    widths.name +
    widths.date +
    widths.rating +
    widths.color +
    (showExifCols ? widths.shutter + widths.aperture + widths.iso + widths.focal : 0);

  const handleResize = (e: React.MouseEvent, leftCol: string, rightCol: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startLeftWidth = widths[leftCol];
    const startRightWidth = widths[rightCol];
    const containerWidth = containerRef.current?.clientWidth || 1000;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;

      let newLeft = startLeftWidth + deltaPercent;
      let newRight = startRightWidth - deltaPercent;

      if (newLeft < 1) {
        newRight -= 1 - newLeft;
        newLeft = 1;
      }
      if (newRight < 1) {
        newLeft -= 1 - newRight;
        newRight = 1;
      }

      setWidths((prev: any) => ({
        ...prev,
        [leftCol]: newLeft,
        [rightCol]: newRight,
      }));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const Column = ({ title, widthKey, nextKey, sortKey }: any) => {
    const isSorted = sortCriteria.key === sortKey;
    const isAsc = sortCriteria.order === SortDirection.Ascending;
    const actualWidth = `${(widths[widthKey] / totalRawWidth) * 100}%`;

    return (
      <div
        style={{ width: actualWidth }}
        className={`relative flex items-center px-3 h-full select-none ${
          sortKey ? 'cursor-pointer hover:bg-bg-primary/50 transition-colors' : ''
        }`}
        onClick={() => sortKey && onSortChange(sortKey)}
      >
        <Text
          variant={TextVariants.small}
          weight={TextWeights.semibold}
          color={isSorted ? TextColors.primary : TextColors.secondary}
          className="uppercase tracking-wider text-[11px]"
        >
          {title}
        </Text>
        {isSorted && (
          <span className={`ml-1 flex items-center ${TEXT_COLOR_KEYS[TextColors.primary]}`}>
            {isAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        )}
        {nextKey && (
          <div
            className="absolute right-[-3px] top-1.5 bottom-1.5 w-[6px] cursor-col-resize z-10 group flex items-center justify-center"
            onMouseDown={(e) => handleResize(e, widthKey, nextKey)}
          >
            <div className="w-px h-full bg-border-color/40 group-hover:bg-accent transition-colors" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex items-center w-full h-9 bg-bg-secondary/80 backdrop-blur-sm border-b border-border-color/50 shrink-0">
      <Column title="" widthKey="thumbnail" nextKey="name" />
      <Column title={t('library.grid.columns.name')} widthKey="name" nextKey="date" sortKey="name" />
      <Column title={t('library.grid.columns.modified')} widthKey="date" nextKey="rating" sortKey="date" />
      <Column title={t('library.grid.columns.rating')} widthKey="rating" nextKey="color" sortKey="rating" />
      {showExifCols ? (
        <>
          <Column title={t('library.grid.columns.label')} widthKey="color" nextKey="shutter" />
          <Column
            title={t('library.grid.columns.shutter')}
            widthKey="shutter"
            nextKey="aperture"
            sortKey="shutter_speed"
          />
          <Column title={t('library.grid.columns.aperture')} widthKey="aperture" nextKey="iso" sortKey="aperture" />
          <Column title={t('library.grid.columns.iso')} widthKey="iso" nextKey="focal" sortKey="iso" />
          <Column title={t('library.grid.columns.focal')} widthKey="focal" sortKey="focal_length" />
        </>
      ) : (
        <Column title={t('library.grid.columns.label')} widthKey="color" />
      )}
    </div>
  );
}

const groupImagesByFolder = (images: any[], baseFolderPath: string | null) => {
  const groups: Record<string, any[]> = {};

  images.forEach((img) => {
    const physicalPath = img.path.split('?vc=')[0];
    const separator = physicalPath.includes('/') ? '/' : '\\';
    const lastSep = physicalPath.lastIndexOf(separator);
    const dir = lastSep > -1 ? physicalPath.substring(0, lastSep) : physicalPath;

    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(img);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === baseFolderPath) return -1;
    if (b === baseFolderPath) return 1;
    return a.localeCompare(b);
  });

  return sortedKeys.map((dir) => ({
    path: dir,
    images: groups[dir],
  }));
};

interface GridRow {
  type: string;
  images?: { path: string }[];
  path?: string;
  count?: number;
  isExpanded?: boolean;
  startIndex?: number;
}

interface GridDataShape {
  rows: GridRow[];
  itemWidth: number;
  rowHeight: number;
  listRowHeight: number;
  OUTER_PADDING: number;
  ITEM_GAP: number;
  columnCount: number;
  isListView: boolean;
  headerHeight: number;
}

export default function LibraryGrid(props: any) {
  const {
    imageList,
    libraryViewMode,
    thumbnailSize,
    currentFolderPath,
    activePath,
    multiSelectedPaths,
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
    thumbnailAspectRatio,
    imageRatings,
    onRequestThumbnails,
    thumbnailSizeOptions,
    onThumbnailSizeChange,
  } = props;
  const appSettings = useSettingsStore((s) => s.appSettings);
  const { listColumnWidths, setLibrary, sortCriteria, setSortCriteria } = useLibraryStore();
  const [gridSize, setGridSize] = useState({ height: 0, width: 0 });
  const [listHandle, setListHandle] = useListCallbackRef();
  const [collapsedRecursiveFolders, setCollapsedRecursiveFolders] = useState<Set<string>>(new Set());
  const libraryContainerRef = useRef<HTMLDivElement>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);
  const loadedThumbnailsRef = useRef(new Set<string>());
  const scrollTopRef = useRef(0);
  // Stable refs so debounced scroll callback doesn't need to capture changing values
  const gridDataRef = useRef<GridDataShape | null>(null);
  const gridSizeRef = useRef({ height: 0, width: 0 });
  const requestViewportThumbnailsRef = useRef<
    (gd: GridDataShape | null, top: number, gs: { height: number; width: number }) => void
  >(() => {});

  useEffect(() => {
    const el = libraryContainerRef.current;
    if (gridObserverRef.current) {
      gridObserverRef.current.disconnect();
      gridObserverRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const { height, width } = entry.contentRect;
          setGridSize((prev) => (prev.height === height && prev.width === width ? prev : { height, width }));
        }
      });
      ro.observe(el);
      gridObserverRef.current = ro;
    }
    return () => gridObserverRef.current?.disconnect();
  }, [libraryContainerRef]);

  useEffect(() => {
    const handleWheel = (event: any) => {
      const container = libraryContainerRef.current;
      if (!container || !container.contains(event.target)) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const currentIndex = thumbnailSizeOptions.findIndex((o: any) => o.id === thumbnailSize);
        if (currentIndex === -1) {
          return;
        }

        const nextIndex =
          event.deltaY < 0
            ? Math.min(currentIndex + 1, thumbnailSizeOptions.length - 1)
            : Math.max(currentIndex - 1, 0);
        if (nextIndex !== currentIndex) {
          onThumbnailSizeChange(thumbnailSizeOptions[nextIndex].id);
        }
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [thumbnailSize, onThumbnailSizeChange, thumbnailSizeOptions]);

  const handleScroll = useMemo(
    () =>
      debounce((top: number) => {
        setLibrary({ libraryScrollTop: top });
        scrollTopRef.current = top;
        requestViewportThumbnailsRef.current(gridDataRef.current, top, gridSizeRef.current);
      }, 100),
    [setLibrary],
  );

  useEffect(() => () => handleScroll.cancel(), [handleScroll]);

  const requestViewportThumbnails = useCallback(
    (
      currentGridData: GridDataShape | null,
      currentScrollTop: number,
      currentGridSize: { height: number; width: number },
    ) => {
      if (!onRequestThumbnails || !currentGridData || imageList.length === 0) return;

      const { rows, rowHeight, headerHeight, columnCount } = currentGridData;

      // Collect all image paths in render order from rows, tracking which flat index each falls at
      const allPaths: string[] = [];
      rows.forEach((row) => {
        if (row.type === 'images') {
          row.images?.forEach((img) => {
            if (img?.path) allPaths.push(img.path);
          });
        }
      });

      if (allPaths.length === 0) return;

      // Compute which row indices are visible
      const viewportHeight = currentGridSize.height;

      // Find visible row range by walking the rows array
      let pixelOffset = 0;
      let visibleStartFlat = 0;
      let visibleEndFlat = allPaths.length - 1;
      let flatIdx = 0;
      let foundStart = false;

      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        let rowH = rowHeight;
        if (row.type === 'header') rowH = headerHeight;
        else if (row.type === 'footer') rowH = currentGridData.OUTER_PADDING;

        const rowBottom = pixelOffset + rowH;

        if (row.type === 'images') {
          const imagesInRow = row.images?.length || 0;
          if (!foundStart && rowBottom > currentScrollTop) {
            visibleStartFlat = flatIdx;
            foundStart = true;
          }
          if (pixelOffset < currentScrollTop + viewportHeight) {
            visibleEndFlat = flatIdx + imagesInRow - 1;
          }
          flatIdx += imagesInRow;
        }

        pixelOffset += rowH;
      }

      const pageSize = Math.max(columnCount, visibleEndFlat - visibleStartFlat + 1);
      const prefetchEnd = Math.min(allPaths.length - 1, visibleEndFlat + pageSize);

      const visible = allPaths.slice(visibleStartFlat, visibleEndFlat + 1);
      const prefetch = allPaths.slice(visibleEndFlat + 1, prefetchEnd + 1);
      const background = allPaths.filter((_p, i) => i < visibleStartFlat || i > prefetchEnd);

      // Compute target resolution from the real rendered cell width
      const cellCssPx = currentGridData.itemWidth;

      const targetRes =
        appSettings?.thumbnailResolution === 'auto' || appSettings?.thumbnailResolution == null
          ? resolveThumbnailRes(cellCssPx, window.devicePixelRatio || 1)
          : Number(appSettings.thumbnailResolution);

      onRequestThumbnails({ visible, prefetch, background, targetRes });
    },
    [onRequestThumbnails, imageList, appSettings],
  );

  // Keep stable ref pointing to latest callback so debounced handleScroll can call it
  requestViewportThumbnailsRef.current = requestViewportThumbnails;

  const handleToggleRecursiveFolder = useCallback((path: string) => {
    setCollapsedRecursiveFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handleImageLoad = useCallback((path: string) => {
    loadedThumbnailsRef.current.add(path);
  }, []);

  const gridData = useMemo(() => {
    if (gridSize.width === 0 || imageList.length === 0) return null;

    const isListView = thumbnailSize === ThumbnailSize.List;
    const OUTER_PADDING = isListView ? 0 : 12;
    const ITEM_GAP = isListView ? 0 : 12;
    const minThumbWidth = thumbnailSizeOptions.find((o: any) => o.id === thumbnailSize)?.size || 240;

    const availableWidth = gridSize.width - OUTER_PADDING * 2;
    const columnCount = isListView
      ? 1
      : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
    const itemWidth = isListView ? availableWidth : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;

    const listRowHeight = Math.max(36, Math.min(300, (availableWidth * listColumnWidths.thumbnail) / 100));
    const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
    const headerHeight = 40;

    const rows: any[] = [];

    if (libraryViewMode === LibraryViewMode.Recursive) {
      const groups = groupImagesByFolder(imageList, currentFolderPath);
      groups.forEach((group) => {
        if (group.images.length === 0) return;

        const isExpanded = !collapsedRecursiveFolders.has(group.path);
        rows.push({ type: 'header', path: group.path, count: group.images.length, isExpanded });

        if (isExpanded) {
          for (let i = 0; i < group.images.length; i += columnCount) {
            rows.push({
              type: 'images',
              images: group.images.slice(i, i + columnCount),
              startIndex: i,
            });
          }
        }
      });
    } else {
      for (let i = 0; i < imageList.length; i += columnCount) {
        rows.push({
          type: 'images',
          images: imageList.slice(i, i + columnCount),
          startIndex: i,
        });
      }
    }

    rows.push({ type: 'footer' });

    return {
      rows,
      itemWidth,
      rowHeight,
      listRowHeight,
      OUTER_PADDING,
      ITEM_GAP,
      columnCount,
      isListView,
      headerHeight,
    };
  }, [
    gridSize.width,
    imageList,
    libraryViewMode,
    collapsedRecursiveFolders,
    thumbnailSize,
    listColumnWidths.thumbnail,
    currentFolderPath,
    thumbnailSizeOptions,
  ]);

  // Keep stable refs up-to-date for debounced scroll handler
  gridDataRef.current = gridData;
  gridSizeRef.current = gridSize;

  useEffect(() => {
    if (!listHandle?.element || !gridData) return;

    const savedTop = useLibraryStore.getState().libraryScrollTop;
    const element = listHandle.element as HTMLElement;

    if (savedTop > 0) {
      element.scrollTop = savedTop;
    }
  }, [listHandle, currentFolderPath]);

  // Fire tiered thumbnail request when folder loads or grid layout changes
  useEffect(() => {
    if (!gridData || imageList.length === 0) return;
    requestViewportThumbnails(gridData, scrollTopRef.current, gridSize);
  }, [gridData, imageList, gridSize, requestViewportThumbnails]);

  const prevActivePath = useRef<string | null>(null);

  useEffect(() => {
    if (!listHandle?.element || !gridData || multiSelectedPaths.length > 1) {
      prevActivePath.current = activePath;
      return;
    }

    if (activePath === prevActivePath.current) return;
    prevActivePath.current = activePath;

    const element = listHandle.element as HTMLElement;
    const { rows, rowHeight, headerHeight, columnCount } = gridData;

    let targetTop = 0;
    let found = false;

    if (libraryViewMode === LibraryViewMode.Recursive) {
      const groups = groupImagesByFolder(imageList, currentFolderPath);
      for (const group of groups) {
        if (group.images.length === 0) continue;

        targetTop += headerHeight;

        const imageIndex = group.images.findIndex((img) => img.path === activePath);
        if (imageIndex !== -1) {
          const rowIndex = Math.floor(imageIndex / columnCount);
          targetTop += rowIndex * rowHeight;
          found = true;
          break;
        }

        const rowsInGroup = Math.ceil(group.images.length / columnCount);
        targetTop += rowsInGroup * rowHeight;
      }
    } else {
      const index = imageList.findIndex((img) => img.path === activePath);
      if (index !== -1) {
        const rowIndex = Math.floor(index / columnCount);
        targetTop = rowIndex * rowHeight;
        found = true;
      }
    }

    if (found) {
      const clientHeight = element.clientHeight;
      const scrollTop = element.scrollTop;
      const itemBottom = targetTop + rowHeight;
      const SCROLL_OFFSET = 120;

      if (itemBottom > scrollTop + clientHeight) {
        element.scrollTo({
          top: itemBottom - clientHeight + SCROLL_OFFSET,
          behavior: 'smooth',
        });
      } else if (targetTop < scrollTop) {
        element.scrollTo({
          top: Math.max(0, targetTop - SCROLL_OFFSET),
          behavior: 'smooth',
        });
      }
    }
  }, [activePath, gridData, multiSelectedPaths.length, listHandle, currentFolderPath, imageList, libraryViewMode]);

  // No-op: per-item queuing is replaced by viewport-tiered requestViewportThumbnails
  const noopQueueThumbnailRequest = useCallback(() => {}, []);

  const memoizedRowProps = useMemo(() => {
    if (!gridData) return {};

    return {
      rows: gridData.rows,
      activePath,
      multiSelectedSet: new Set(multiSelectedPaths),
      onContextMenu,
      onImageClick,
      onImageDoubleClick,
      thumbnailAspectRatio,
      onImageLoad: handleImageLoad,
      imageRatings,
      baseFolderPath: currentFolderPath,
      itemWidth: gridData.itemWidth,
      itemHeight: gridData.isListView ? gridData.listRowHeight : gridData.itemWidth,
      outerPadding: gridData.OUTER_PADDING,
      gap: gridData.ITEM_GAP,
      isListView: gridData.isListView,
      columnWidths: listColumnWidths,
      queueThumbnailRequest: noopQueueThumbnailRequest,
      onToggleRecursiveFolder: handleToggleRecursiveFolder,
    };
  }, [
    gridData,
    activePath,
    multiSelectedPaths,
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
    thumbnailAspectRatio,
    handleImageLoad,
    imageRatings,
    currentFolderPath,
    listColumnWidths,
    noopQueueThumbnailRequest,
    handleToggleRecursiveFolder,
  ]);

  if (!gridData) {
    return (
      <div
        ref={libraryContainerRef}
        className="flex-1 w-full h-full"
        onClick={props.onClearSelection}
        onContextMenu={props.onEmptyAreaContextMenu}
      />
    );
  }

  const getItemSize = (index: number) => {
    if (gridData.rows[index].type === 'footer') return gridData.isListView ? 24 : gridData.OUTER_PADDING;
    return gridData.rows[index].type === 'header' ? gridData.headerHeight : gridData.rowHeight;
  };

  const handleHeaderSort = (key: string) => {
    props.onClearSelection();
    setSortCriteria((prev: any) => {
      if (prev.key === key) {
        if (prev.order === SortDirection.Ascending) {
          return { ...prev, order: SortDirection.Descending };
        } else {
          return { key: 'name', order: SortDirection.Ascending };
        }
      }
      return { key, order: SortDirection.Ascending };
    });
  };

  return (
    <div
      ref={libraryContainerRef}
      className="flex-1 w-full h-full"
      onClick={props.onClearSelection}
      onContextMenu={props.onEmptyAreaContextMenu}
    >
      <div className="flex flex-col w-full h-full">
        {gridData.isListView && (
          <ListHeader
            widths={listColumnWidths}
            setWidths={(w: any) => setLibrary({ listColumnWidths: typeof w === 'function' ? w(listColumnWidths) : w })}
            containerRef={libraryContainerRef}
            sortCriteria={sortCriteria}
            onSortChange={handleHeaderSort}
          />
        )}
        <div
          key={`${gridSize.width}-${thumbnailSize}-${libraryViewMode}-${sortCriteria.key}-${sortCriteria.order}-${thumbnailAspectRatio}`}
          style={{ height: gridData.isListView ? gridSize.height - 36 : gridSize.height, width: gridSize.width }}
        >
          <List
            listRef={setListHandle}
            rowCount={gridData.rows.length}
            rowHeight={getItemSize}
            onScroll={(e: React.UIEvent<HTMLElement>) => handleScroll(e.currentTarget.scrollTop)}
            className="custom-scrollbar"
            rowComponent={Row}
            rowProps={memoizedRowProps}
          />
        </div>
      </div>
    </div>
  );
}
