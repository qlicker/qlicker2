import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import {
  prepareRichTextInput,
  renderKatexInElement,
} from './richTextUtils';
import RichTextEditor from './RichTextEditor';

function controlledHtml(value) {
  return typeof value === 'string' ? value : String(value?.html || '');
}

export default function StudentRichTextEditor({
  value,
  onChange,
  onChangeDebounceMs = 0,
  placeholder,
  disabled = false,
  ariaLabel,
  onKeyDown,
  minHeight = 80,
  showMathHint = true,
  enableVideo = false,
}) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder || t('questions.studentRichText.placeholder');
  const resolvedAriaLabel = ariaLabel || t('questions.studentRichText.editorLabel');
  const onChangeRef = useRef(onChange);
  const onKeyDownRef = useRef(onKeyDown);
  const onChangeDebounceMsRef = useRef(onChangeDebounceMs);
  const debounceTimerRef = useRef(null);
  const pendingChangeRef = useRef(null);
  const deliveredHtmlRef = useRef([]);
  const lastObservedValueRef = useRef(controlledHtml(value));
  const [editorControl, setEditorControl] = useState(() => ({
    html: controlledHtml(value),
    revision: 0,
  }));
  const mathHintId = useId();

  const deliverChange = useCallback((payload) => {
    if (!payload || typeof onChangeRef.current !== 'function') return;
    const html = controlledHtml(payload);
    deliveredHtmlRef.current.push(html);
    if (deliveredHtmlRef.current.length > 50) deliveredHtmlRef.current.shift();
    onChangeRef.current(payload);
  }, []);

  const flushPendingChange = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (!pendingChangeRef.current) return;
    const nextPayload = pendingChangeRef.current;
    pendingChangeRef.current = null;
    deliverChange(nextPayload);
  }, [deliverChange]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onKeyDownRef.current = onKeyDown;
  }, [onKeyDown]);

  useEffect(() => {
    onChangeDebounceMsRef.current = onChangeDebounceMs;
  }, [onChangeDebounceMs]);

  useEffect(() => {
    const incomingHtml = controlledHtml(value);
    if (incomingHtml === lastObservedValueRef.current) return;
    lastObservedValueRef.current = incomingHtml;

    const acknowledgementIndex = deliveredHtmlRef.current.lastIndexOf(incomingHtml);
    if (acknowledgementIndex >= 0) {
      // React may batch several immediate updates. Acknowledging the newest
      // observed value also retires any earlier values that the parent skipped.
      deliveredHtmlRef.current.splice(0, acknowledgementIndex + 1);
      return;
    }

    // A value not emitted by this editor is a genuine external change (for
    // example switching questions, clearing after send, or restoring a failed
    // draft). Cancel any old delayed write and recreate TipTap with that value.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingChangeRef.current = null;
    deliveredHtmlRef.current = [];
    setEditorControl((current) => ({ html: incomingHtml, revision: current.revision + 1 }));
  }, [value]);

  const handleEditorChange = useCallback((nextPayload) => {
    const debounceMs = Number(onChangeDebounceMsRef.current);
    if (!Number.isFinite(debounceMs) || debounceMs <= 0) {
      pendingChangeRef.current = null;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (typeof onChangeRef.current === 'function') {
        deliverChange(nextPayload);
      }
      return;
    }

    pendingChangeRef.current = nextPayload;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      if (!pendingChangeRef.current) return;
      const pendingPayload = pendingChangeRef.current;
      pendingChangeRef.current = null;
      deliverChange(pendingPayload);
    }, debounceMs);
  }, [deliverChange]);

  const handleEditorKeyDown = useCallback((event) => {
    const pendingPayload = pendingChangeRef.current;
    // Enter-to-submit handlers need the newest editor value immediately. Flush
    // before invoking them so a debounced parent cannot send a stale draft.
    if (
      event.key === 'Enter'
      && !event.shiftKey
      && !event.isComposing
      && !event.nativeEvent?.isComposing
    ) {
      flushPendingChange();
    }
    const handled = onKeyDownRef.current?.(event, pendingPayload);
    if (handled === true && event.key === 'Enter' && !event.shiftKey) {
      // React may batch the flushed draft and the submit-time clear so the
      // controlled prop never visibly changes. Clear the local TipTap owner
      // explicitly once the Enter handler confirms that it submitted.
      deliveredHtmlRef.current = [];
      pendingChangeRef.current = null;
      setEditorControl((current) => ({ html: '', revision: current.revision + 1 }));
    }
    return handled;
  }, [flushPendingChange]);

  useEffect(() => () => {
    flushPendingChange();
  }, [flushPendingChange]);

  return (
    <Box>
      <RichTextEditor
        key={editorControl.revision}
        value={editorControl.html}
        onChange={handleEditorChange}
        placeholder={resolvedPlaceholder}
        disabled={disabled}
        minHeight={minHeight}
        ariaLabel={resolvedAriaLabel}
        ariaDescribedBy={showMathHint ? mathHintId : undefined}
        onBlur={flushPendingChange}
        onKeyDown={handleEditorKeyDown}
        enableVideo={enableVideo}
      />
      {showMathHint && (
        <Typography
          id={mathHintId}
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 0.5,
            display: 'block'
          }}>
          {t('questions.studentRichText.mathTip')}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Live preview component that renders KaTeX from HTML content.
 * Shows all typed content and renders math when delimiters are present.
 */
export function MathPreview({ html, debounceMs = 140, showLabel = true }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  const prepared = useMemo(() => prepareRichTextInput(html || ''), [html]);
  const [committedPreview, setCommittedPreview] = useState(prepared);

  useEffect(() => {
    if (!prepared) {
      setCommittedPreview('');
      return undefined;
    }
    if (!Number.isFinite(debounceMs) || debounceMs <= 0) {
      setCommittedPreview(prepared);
      return undefined;
    }
    // Debounce preview updates to avoid flicker while typing.
    const timer = setTimeout(() => {
      setCommittedPreview(prepared);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, prepared]);

  useEffect(() => {
    if (!ref.current || !committedPreview) return;
    renderKatexInElement(ref.current);
  }, [committedPreview]);

  if (!committedPreview) return null;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        mt: 1,
        bgcolor: 'grey.50',
        '& p': { my: 0.5 },
        '& img': { maxWidth: '100%' },
      }}
    >
      {showLabel && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mb: 0.5,
            display: 'block'
          }}>
          {t('questions.studentRichText.preview')}
        </Typography>
      )}
      <Box
        ref={ref}
        dangerouslySetInnerHTML={{ __html: committedPreview }}
      />
    </Paper>
  );
}
