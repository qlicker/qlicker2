import { useCallback, useRef, useState } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';

export default function HistogramBars({
  data = [],
  height = 180,
  barColor = 'primary.main',
  showCounts = true,
}) {
  if (!Array.isArray(data) || data.length === 0) return null;

  const counts = data.map((item) => Number(item?.count) || 0);
  const maxCount = Math.max(...counts, 1);
  const scrollerRef = useRef(null);
  const dragStateRef = useRef({
    active: false,
    startX: 0,
    startScrollLeft: 0,
    pointerId: null,
  });
  const [dragging, setDragging] = useState(false);

  const endDrag = useCallback((event) => {
    const scroller = scrollerRef.current;
    if (scroller && dragStateRef.current.pointerId != null && scroller.releasePointerCapture) {
      try {
        scroller.releasePointerCapture(dragStateRef.current.pointerId);
      } catch {
        // Best-effort release only.
      }
    }

    dragStateRef.current.active = false;
    dragStateRef.current.pointerId = null;
    setDragging(false);
    if (event?.cancelable) event.preventDefault();
  }, []);

  const handlePointerDown = useCallback((event) => {
    // Ignore non-primary mouse buttons.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    dragStateRef.current = {
      active: true,
      startX: event.clientX,
      startScrollLeft: scroller.scrollLeft,
      pointerId: event.pointerId ?? null,
    };

    if (event.pointerId != null && scroller.setPointerCapture) {
      try {
        scroller.setPointerCapture(event.pointerId);
      } catch {
        // Fallback to non-captured drag if capture is unsupported.
      }
    }

    setDragging(true);
    if (event.cancelable) event.preventDefault();
  }, []);

  const handlePointerMove = useCallback((event) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragStateRef.current.active) return;

    const deltaX = event.clientX - dragStateRef.current.startX;
    scroller.scrollLeft = dragStateRef.current.startScrollLeft - deltaX;
    if (event.cancelable) event.preventDefault();
  }, []);

  const slotWidth = showCounts ? 34 : 30;
  const minBarWidth = showCounts ? 22 : 20;
  const labelFontSize = showCounts ? '0.68rem' : '0.72rem';

  return (
    <Box
      ref={scrollerRef}
      sx={{
        mb: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pan-x',
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={(event) => {
        if (dragStateRef.current.active && event.pointerType !== 'touch') {
          endDrag(event);
        }
      }}
    >
      <Box
        sx={{
          minWidth: Math.max(data.length * slotWidth, 260),
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0.5,
          height: height + (showCounts ? 40 : 26),
        }}
      >
        {data.map((item, index) => {
          const label = item?.bin ?? '';
          const count = Number(item?.count) || 0;
          const barHeight = count > 0 ? Math.max(8, Math.round((count / maxCount) * height)) : 2;

          return (
            <Box
              key={`${label}-${index}`}
              sx={{
                flex: 1,
                minWidth: minBarWidth,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
            >
              <Tooltip title={`${label}: ${count}`} arrow>
                <Box sx={{ width: '100%', height, display: 'flex', alignItems: 'flex-end' }}>
                  <Box
                    sx={{
                      width: '100%',
                      height: barHeight,
                      bgcolor: barColor,
                      borderRadius: '4px 4px 0 0',
                      transition: 'height 0.25s ease-out',
                    }}
                  />
                </Box>
              </Tooltip>
              <Typography
                variant="caption"
                sx={{ mt: 0.5, fontSize: labelFontSize, lineHeight: 1.05 }}
                noWrap
              >
                {label}
              </Typography>
              {showCounts && (
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  {count}
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
