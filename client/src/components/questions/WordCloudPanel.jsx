import { useState, useCallback } from 'react';
import { Box, Button, Typography, CircularProgress } from '@mui/material';
import {
  Refresh as RefreshIcon,
  VisibilityOff as HideIcon,
  Visibility as ShowIcon,
  Cloud as CloudIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import WordCloudDisplay from './WordCloudDisplay';

/**
 * WordCloudPanel wraps the word cloud display with action buttons.
 *
 * Props:
 *   wordCloudData    - { wordFrequencies, visible, generatedAt } or null
 *   onGenerate       - async () => void — called when prof clicks Generate/Refresh
 *   onToggleVisible  - async (visible: boolean) => void — toggle visibility (prof only)
 *   showControls     - show generate/refresh/hide buttons (prof view)
 *   width            - SVG width (default 600)
 *   height           - SVG height (default 300)
 */
export default function WordCloudPanel({
  wordCloudData,
  onGenerate,
  onToggleVisible,
  showControls = false,
  width = 600,
  height = 300,
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const hasCloud = wordCloudData?.wordFrequencies?.length > 0;
  const isVisible = wordCloudData?.visible !== false;

  const handleGenerate = useCallback(async () => {
    if (!onGenerate) return;
    setLoading(true);
    try {
      await onGenerate();
    } finally {
      setLoading(false);
    }
  }, [onGenerate]);

  const handleToggleVisible = useCallback(async () => {
    if (!onToggleVisible) return;
    setLoading(true);
    try {
      await onToggleVisible(!isVisible);
    } finally {
      setLoading(false);
    }
  }, [onToggleVisible, isVisible]);

  // Prof controls: Generate / Refresh / Hide / Show
  if (showControls) {
    return (
      <Box sx={{ mb: 2 }}>
        {!hasCloud ? (
          /* No word cloud generated yet — show generate button */
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Button
              variant="outlined"
              startIcon={loading ? <CircularProgress size={18} /> : <CloudIcon />}
              onClick={handleGenerate}
              disabled={loading}
            >
              {t('wordCloud.generate')}
            </Button>
          </Box>
        ) : (
          /* Word cloud exists */
          <>
            {isVisible && (
              <WordCloudDisplay
                wordFrequencies={wordCloudData.wordFrequencies}
                width={width}
                height={height}
              />
            )}
            {!isVisible && (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  textAlign: 'center',
                  py: 1
                }}>
                {t('wordCloud.hidden')}
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', mt: 1 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
                onClick={handleGenerate}
                disabled={loading}
              >
                {t('wordCloud.refresh')}
              </Button>
              {onToggleVisible && (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={isVisible ? <HideIcon /> : <ShowIcon />}
                  onClick={handleToggleVisible}
                  disabled={loading}
                >
                  {isVisible ? t('wordCloud.hide') : t('wordCloud.show')}
                </Button>
              )}
            </Box>
          </>
        )}
      </Box>
    );
  }

  // Student / presentation view: only show if cloud data exists and is visible
  if (!hasCloud || !isVisible) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <WordCloudDisplay
        wordFrequencies={wordCloudData.wordFrequencies}
        width={width}
        height={height}
      />
    </Box>
  );
}
