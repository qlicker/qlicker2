import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Color from '@tiptap/extension-color';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { FontSize, TextStyle } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, MenuItem, Paper,
  TextField, Tooltip, Typography,
} from '@mui/material';
import {
  FormatBold as BoldIcon,
  FormatItalic as ItalicIcon,
  FormatListBulleted as BulletListIcon,
  Code as CodeIcon,
  DataObject as SourceIcon,
  FormatColorText as ColorIcon,
  Image as ImageIcon,
  InsertLink as LinkIcon,
  FormatAlignLeft as AlignLeftIcon,
  FormatAlignCenter as AlignCenterIcon,
  FormatAlignRight as AlignRightIcon,
  FormatAlignJustify as AlignJustifyIcon,
  FormatSize as FontSizeIcon,
  FormatUnderlined as UnderlineIcon,
  ExpandLess as CollapseToolbarIcon,
  ExpandMore as ExpandToolbarIcon,
  OndemandVideo as VideoIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import { prepareImageFileForUpload, IMAGE_UPLOAD_TIMEOUT_MS } from '../../utils/imageUpload';
import { getPublicSettings } from '../../utils/publicSettings';
import {
  extractPlainTextFromHtml,
  normalizeStoredHtml,
  prepareRichTextInput,
} from './richTextUtils';
import ResizableImage from './ResizableImage';
import VideoEmbed, { toEmbedUrl } from './VideoEmbed';

function isImageFile(file) {
  return Boolean(file?.type?.startsWith('image/'));
}

function getMaxEditorImageWidth(view) {
  const editorWidth = view?.dom?.getBoundingClientRect?.().width || 0;
  if (!Number.isFinite(editorWidth) || editorWidth <= 0) return 0;
  return Math.floor(editorWidth * 0.9);
}

const FONT_SIZE_OPTIONS = ['', '12px', '14px', '16px', '18px', '24px', '32px'];
const TEXT_ALIGN_OPTIONS = [
  { value: 'left', labelKey: 'questions.richText.alignLeft', Icon: AlignLeftIcon },
  { value: 'center', labelKey: 'questions.richText.alignCenter', Icon: AlignCenterIcon },
  { value: 'right', labelKey: 'questions.richText.alignRight', Icon: AlignRightIcon },
  { value: 'justify', labelKey: 'questions.richText.alignJustify', Icon: AlignJustifyIcon },
];

function normalizeLinkValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (trimmed.includes('@') && !trimmed.includes(' ')) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = '',
  minHeight = 96,
  resizable = false,
  disabled = false,
  label,
  showTip = false,
  compact = false,
  ariaLabel,
  ariaDescribedBy,
  onBlur,
  onKeyDown,
  enableVideo = false,
  borderEmphasis = 'normal',
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState('');
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [videoDraft, setVideoDraft] = useState('');
  const [videoError, setVideoError] = useState('');
  const { t } = useTranslation();
  const lastEditorSourceHtmlRef = useRef('');
  const lastEditorHtmlRef = useRef('');
  const lastPropHtmlRef = useRef('');
  const emittedHtmlRef = useRef([]);
  const bubbleMenuKey = useRef(`bubble-menu-${Math.random().toString(36).slice(2)}`);
  const fileInputRef = useRef(null);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const allowVideoEmbeds = enableVideo;
  const preparedValue = useMemo(
    () => prepareRichTextInput(value || '', '', { allowVideoEmbeds }),
    [allowVideoEmbeds, value]
  );
  const editorAriaLabel = ariaLabel || (label ? t('questions.richText.editorLabel', { label }) : t('questions.richText.defaultLabel'));

  // Keep callback refs current so useEditor doesn't need to list them as
  // dependencies.  Without this, every new onChange/onBlur reference causes
  // useEditor to destroy & recreate the TipTap instance, which drops focus
  // and makes typing in the grading table impossible.
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onKeyDownRef = useRef(onKeyDown);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;
  onKeyDownRef.current = onKeyDown;

  const emitEditorChange = (nextEditor) => {
    if (!nextEditor) return;
    const sourceHtml = nextEditor.getHTML();
    // TipTap reports a document edit through both onTransaction and onUpdate.
    // Avoid running DOMPurify and plain-text extraction twice per keystroke.
    if (sourceHtml === lastEditorSourceHtmlRef.current) return;
    lastEditorSourceHtmlRef.current = sourceHtml;
    const html = normalizeStoredHtml(sourceHtml, { allowVideoEmbeds });
    if (html === lastEditorHtmlRef.current) return;
    lastEditorHtmlRef.current = html;
    if (typeof onChangeRef.current === 'function') {
      emittedHtmlRef.current.push(html);
      if (emittedHtmlRef.current.length > 50) emittedHtmlRef.current.shift();
      onChangeRef.current({ html, plainText: extractPlainTextFromHtml(html) });
    }
  };

  const uploadImage = async (file, maxEditorImageWidth) => {
    const publicSettings = await getPublicSettings();
    const configuredMaxWidth = Number(publicSettings?.maxImageWidth) || 0;
    const effectiveMaxWidth = configuredMaxWidth > 0 && maxEditorImageWidth > 0
      ? Math.min(configuredMaxWidth, maxEditorImageWidth)
      : configuredMaxWidth || maxEditorImageWidth || undefined;
    const preparedUpload = await prepareImageFileForUpload(file, { maxWidth: effectiveMaxWidth });
    const formData = new FormData();
    formData.append('file', preparedUpload.file);
    const { data } = await apiClient.post('/images', formData, { timeout: IMAGE_UPLOAD_TIMEOUT_MS });
    return {
      url: data?.image?.url || '',
      width: preparedUpload.width,
    };
  };

  const insertUploadedImages = async (view, files, insertPos) => {
    if (!view || !Array.isArray(files) || files.length === 0) return;
    setUploadError('');
    setUploading(true);
    try {
      const maxEditorImageWidth = getMaxEditorImageWidth(view);
      const uploads = await Promise.all(files.map((file) => uploadImage(file, maxEditorImageWidth)));
      const validUploads = uploads.filter((upload) => upload?.url);
      if (!validUploads.length) return;

      let tr = view.state.tr;
      let pos = insertPos;
      validUploads.forEach((upload) => {
        const imageNode = view.state.schema.nodes.image.create({
          src: upload.url,
          width: upload.width,
        });
        tr = tr.insert(pos, imageNode);
        pos += imageNode.nodeSize;
      });
      view.dispatch(tr);
    } catch (err) {
      console.error('Image upload failed', err);
      setUploadError(t('questions.richText.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const editor = useEditor(
    {
      editable: !disabled,
      content: preparedValue,
      extensions: [
        StarterKit.configure({
          heading: false,
          codeBlock: false,
          blockquote: false,
          horizontalRule: false,
          link: false,
          underline: false,
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
        }),
        TextStyle,
        Color,
        FontSize,
        TextAlign.configure({
          types: ['paragraph'],
        }),
        Underline,
        ResizableImage.configure({ allowBase64: false }),
        ...(enableVideo ? [VideoEmbed] : []),
        Placeholder.configure({
          placeholder: placeholder || '',
          showOnlyWhenEditable: true,
          emptyEditorClass: 'is-editor-empty',
          emptyNodeClass: 'is-empty',
        }),
      ],
      editorProps: {
        attributes: {
          class: 'question-rich-text-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': editorAriaLabel,
          'aria-disabled': disabled ? 'true' : 'false',
          ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
        },
        handleDOMEvents: {
          blur: () => {
            onBlurRef.current?.();
            return false;
          },
          keydown: (_view, event) => onKeyDownRef.current?.(event) === true,
        },
        handleDrop(view, event) {
          const droppedFiles = Array.from(event.dataTransfer?.files || []).filter(isImageFile);
          if (!droppedFiles.length) return false;

          event.preventDefault();
          const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            ?? view.state.selection.from;
          insertUploadedImages(view, droppedFiles, dropPos);
          return true;
        },
        handlePaste(view, event) {
          const pastedFiles = Array.from(event.clipboardData?.files || []).filter(isImageFile);
          if (!pastedFiles.length) return false;

          event.preventDefault();
          insertUploadedImages(view, pastedFiles, view.state.selection.from);
          return true;
        },
      },
      onCreate: ({ editor: createdEditor }) => {
        const sourceHtml = createdEditor.getHTML();
        const html = normalizeStoredHtml(sourceHtml, { allowVideoEmbeds });
        lastEditorSourceHtmlRef.current = sourceHtml;
        lastEditorHtmlRef.current = html;
        lastPropHtmlRef.current = preparedValue || '';
      },
      onUpdate: ({ editor: updatedEditor }) => {
        emitEditorChange(updatedEditor);
      },
      onTransaction: ({ editor: transactionEditor, transaction }) => {
        if (!transaction?.docChanged) return;
        emitEditorChange(transactionEditor);
      },
    },
    [ariaDescribedBy, editorAriaLabel, enableVideo, placeholder]
  );

  useEffect(() => {
    if (!editor) return;
    if (disabled !== !editor.isEditable) {
      editor.setEditable(!disabled);
    }
    // Keep aria-disabled in sync without recreating the editor.
    let dom = null;
    try {
      dom = editor.view?.dom || null;
    } catch {
      dom = null;
    }
    if (dom) {
      dom.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;

    const targetHtml = preparedValue || '';
    const propChanged = targetHtml !== lastPropHtmlRef.current;
    lastPropHtmlRef.current = targetHtml;
    if (!propChanged) return;

    const acknowledgementIndex = emittedHtmlRef.current.lastIndexOf(targetHtml);
    if (acknowledgementIndex >= 0) {
      // A parent-controlled value may be rendered after TipTap has already
      // accepted more typing. Treat values emitted by this editor as delayed
      // acknowledgements, never as commands to replace its current document.
      emittedHtmlRef.current.splice(0, acknowledgementIndex + 1);
      return;
    }

    const currentHtml = normalizeStoredHtml(editor.getHTML(), { allowVideoEmbeds });
    if (targetHtml === currentHtml || targetHtml === lastEditorHtmlRef.current) return;

    editor.commands.setContent(targetHtml, false, { preserveWhitespace: 'full' });
    const html = normalizeStoredHtml(editor.getHTML(), { allowVideoEmbeds });
    lastEditorHtmlRef.current = html;
  }, [allowVideoEmbeds, editor, preparedValue]);

  const currentColor = editor?.getAttributes('textStyle')?.color || '#000000';
  const currentFontSize = editor?.getAttributes('textStyle')?.fontSize || '';
  const currentTextAlign = editor?.getAttributes('paragraph')?.textAlign || 'left';

  const openLinkEditor = () => {
    if (!editor) return;
    setLinkDraft(editor.getAttributes('link')?.href || '');
    setLinkDialogOpen(true);
  };

  const applyLinkDraft = () => {
    if (!editor) return;
    const nextLink = normalizeLinkValue(linkDraft);
    if (!nextLink) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: nextLink }).run();
    }
    setLinkDialogOpen(false);
  };

  const openSourceEditor = () => {
    if (!editor) return;
    setSourceDraft(normalizeStoredHtml(editor.getHTML(), { allowVideoEmbeds }));
    setSourceDialogOpen(true);
  };

  const applySourceDraft = () => {
    if (!editor) return;
    editor.commands.setContent(normalizeStoredHtml(sourceDraft || '', { allowVideoEmbeds }), false, { preserveWhitespace: 'full' });
    const html = normalizeStoredHtml(editor.getHTML(), { allowVideoEmbeds });
    lastEditorHtmlRef.current = html;
    if (typeof onChangeRef.current === 'function') {
      emittedHtmlRef.current.push(html);
      if (emittedHtmlRef.current.length > 50) emittedHtmlRef.current.shift();
      onChangeRef.current({ html, plainText: extractPlainTextFromHtml(html) });
    }
    setSourceDialogOpen(false);
  };

  const openVideoDialog = () => {
    setVideoDraft('');
    setVideoError('');
    setVideoDialogOpen(true);
  };

  const applyVideoDraft = () => {
    if (!editor) return;
    const embedSrc = toEmbedUrl(videoDraft);
    if (!embedSrc) {
      setVideoError(t('questions.richText.videoInvalidUrl'));
      return;
    }
    editor.commands.setVideoEmbed({ src: embedSrc });
    setVideoDialogOpen(false);
    setVideoDraft('');
    setVideoError('');
  };

  const handleToolbarImageInput = async (event) => {
    const files = Array.from(event.target.files || []).filter(isImageFile);
    if (editor?.view && files.length > 0) {
      await insertUploadedImages(editor.view, files, editor.state.selection.from);
    }
    event.target.value = '';
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Paper
        variant="outlined"
        sx={{
          '--editor-border-color': borderEmphasis === 'strong' ? 'rgba(25, 118, 210, 0.38)' : 'divider',
          '--editor-border-width': borderEmphasis === 'strong' ? '2px' : '1px',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 1.5,
          px: 1.25,
          py: toolbarExpanded ? 1.25 : 0.85,
          minHeight: minHeight + (toolbarExpanded ? 84 : 0),
          borderColor: 'var(--editor-border-color)',
          borderWidth: 'var(--editor-border-width)',
          '&:focus-within': {
            borderColor: 'primary.main',
            boxShadow: theme => `0 0 0 2px ${theme.palette.primary.light}`,
          },
          '& .editor-toolbar-controls': {
            order: -1,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            flexWrap: 'wrap',
            pb: 1,
            mb: 1,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          },
          '& .question-rich-text-editor': {
            minHeight,
            width: '100%',
            boxSizing: 'border-box',
            outline: 'none',
            fontSize: 15,
            lineHeight: 1.55,
            resize: resizable ? 'vertical' : 'none',
            overflowX: 'hidden',
            overflowY: resizable ? 'auto' : 'visible',
            '& p': { my: compact ? 0 : 0.7 },
            '& ul, & ol': { my: 0.7, pl: 3 },
            '& .tiptap-resizable-image': {
              my: 0.8,
            },
            '& .tiptap-video-embed': {
              my: 1,
              maxWidth: '100%',
            },
            '& img': { maxWidth: '100%', height: 'auto', borderRadius: 0 },
            '& p.is-empty:first-of-type::before, & .is-editor-empty:first-of-type::before': {
              color: 'text.disabled',
              content: 'attr(data-placeholder)',
              float: 'left',
              pointerEvents: 'none',
              height: 0,
              whiteSpace: 'pre-line',
            },
          },
        }}
      >
        {editor && (
          <BubbleMenu
            editor={editor}
            pluginKey={bubbleMenuKey.current}
            shouldShow={({ editor: menuEditor, from, to }) => menuEditor.isEditable && from < to}
            options={{
              placement: 'top',
              offset: 16,
              strategy: 'fixed',
              appendTo: () => document.body,
            }}
          >
            <Paper
              elevation={3}
              sx={{
                display: 'flex',
                alignItems: 'center',
                px: 0.5,
                py: 0.25,
                borderRadius: 2,
                bgcolor: 'grey.900',
                color: 'common.white',
                zIndex: 1700,
              }}
            >
              <IconButton
                size="small"
                aria-label={t('questions.richText.bold')}
                title={t('questions.richText.bold')}
                onClick={() => editor.chain().focus().toggleBold().run()}
                sx={{ color: editor.isActive('bold') ? 'warning.light' : 'inherit' }}
              >
                <BoldIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                aria-label={t('questions.richText.italic')}
                title={t('questions.richText.italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                sx={{ color: editor.isActive('italic') ? 'warning.light' : 'inherit' }}
              >
                <ItalicIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                aria-label={t('questions.richText.underline')}
                title={t('questions.richText.underline')}
                onClick={() => editor.chain().focus().toggleUnderline().run()}
                sx={{ color: editor.isActive('underline') ? 'warning.light' : 'inherit' }}
              >
                <UnderlineIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                aria-label={t('questions.richText.link')}
                title={t('questions.richText.link')}
                onClick={openLinkEditor}
                sx={{ color: editor.isActive('link') ? 'warning.light' : 'inherit' }}
              >
                <LinkIcon fontSize="small" />
              </IconButton>
            </Paper>
          </BubbleMenu>
        )}

        <EditorContent editor={editor} />

        {editor && toolbarExpanded ? (
          <Box className="editor-toolbar-controls">
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.bold')}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  color={editor.isActive('bold') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <BoldIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.italic')}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                  color={editor.isActive('italic') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <ItalicIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.underline')}
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                  color={editor.isActive('underline') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <UnderlineIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.bulletList')}
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  color={editor.isActive('bulletList') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <BulletListIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.inlineCode')}
                  onClick={() => editor.chain().focus().toggleCode().run()}
                  color={editor.isActive('code') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <CodeIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t('questions.richText.link')}
                  onClick={openLinkEditor}
                  color={editor.isActive('link') ? 'primary' : 'default'}
                  disabled={disabled}
                >
                  <LinkIcon fontSize="small" />
                </IconButton>
                <Button
                  component="label"
                  size="small"
                  variant="outlined"
                  startIcon={<ImageIcon />}
                  disabled={disabled || uploading}
                >
                  {t('questions.richText.image')}
                  <input
                    ref={fileInputRef}
                    hidden
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleToolbarImageInput}
                  />
                </Button>
                {enableVideo ? (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<VideoIcon />}
                  onClick={openVideoDialog}
                  disabled={disabled}
                >
                  {t('questions.richText.video')}
                </Button>
                ) : null}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                  {TEXT_ALIGN_OPTIONS.map(({ value, labelKey, Icon }) => (
                    <IconButton
                      key={value}
                      size="small"
                      aria-label={t(labelKey)}
                      onClick={() => editor.chain().focus().setTextAlign(value).run()}
                      color={currentTextAlign === value ? 'primary' : 'default'}
                      disabled={disabled}
                    >
                      <Icon fontSize="small" />
                    </IconButton>
                  ))}
                </Box>
                <TextField
                  size="small"
                  select
                  label={t('questions.richText.fontSize')}
                  value={currentFontSize}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (!nextValue) {
                      editor.chain().focus().unsetFontSize().run();
                      return;
                    }
                    editor.chain().focus().setFontSize(nextValue).run();
                  }}
                  sx={{ width: 120 }}
                  disabled={disabled}
                  slotProps={{
                    input: { startAdornment: <FontSizeIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }
                  }}
                >
                  {FONT_SIZE_OPTIONS.map((option) => (
                    <MenuItem key={option || 'default'} value={option}>
                      {option || t('questions.richText.defaultSize')}
                    </MenuItem>
                  ))}
                </TextField>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ColorIcon />}
                  component="label"
                  disabled={disabled}
                >
                  {t('questions.richText.color')}
                  <input
                    type="color"
                    value={currentColor}
                    onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
                    style={{ width: 28, height: 28, border: 0, background: 'transparent', marginLeft: 8 }}
                  />
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<SourceIcon />}
                  onClick={openSourceEditor}
                  disabled={disabled}
                >
                  {t('questions.richText.source')}
                </Button>
          </Box>
        ) : null}
      </Paper>

      {(label || editor) ? (
        <Box
          sx={{
            order: -1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: label ? 'space-between' : 'flex-end',
            gap: 1,
            mb: 0.35,
            minHeight: 28,
          }}
        >
          {label ? (
            <Typography variant="subtitle2">
              {label}
            </Typography>
          ) : <Box />}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35 }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {toolbarExpanded ? t('questions.richText.hideToolbar') : t('questions.richText.showToolbar')}
            </Typography>
            <Tooltip title={toolbarExpanded ? t('questions.richText.hideToolbar') : t('questions.richText.showToolbar')}>
              <span>
                <IconButton
                  size="small"
                  aria-label={toolbarExpanded ? t('questions.richText.hideToolbar') : t('questions.richText.showToolbar')}
                  onClick={() => setToolbarExpanded((current) => !current)}
                  disabled={disabled}
                  sx={{ p: 0.5 }}
                >
                  {toolbarExpanded ? <CollapseToolbarIcon fontSize="small" /> : <ExpandToolbarIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
      ) : null}

      <Box sx={{ mt: showTip || uploading || uploadError ? 0.75 : 0, minHeight: showTip || uploading || uploadError ? 26 : 0 }}>
        {uploading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={14} />
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>{t('questions.richText.uploadingImage')}</Typography>
          </Box>
        ) : showTip ? (
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>
            {t('questions.richText.editorTip')}
          </Typography>
        ) : null}
        {uploadError ? (
          <Alert severity="error" sx={{ mt: 0.75, py: 0 }}>
            {uploadError}
          </Alert>
        ) : null}
      </Box>

      <Dialog open={linkDialogOpen} onClose={() => setLinkDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('questions.richText.link')}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            autoFocus
            label={t('questions.richText.linkUrl')}
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            placeholder={t('questions.richText.linkUrlPlaceholder')}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLinkDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button
            onClick={() => {
              if (editor) {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
              }
              setLinkDraft('');
              setLinkDialogOpen(false);
            }}
          >
            {t('questions.richText.removeLink')}
          </Button>
          <Button variant="contained" onClick={applyLinkDraft}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={sourceDialogOpen} onClose={() => setSourceDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t('questions.richText.source')}</DialogTitle>
        <DialogContent>
          <TextField
            multiline
            minRows={12}
            fullWidth
            autoFocus
            value={sourceDraft}
            onChange={(event) => setSourceDraft(event.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSourceDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={applySourceDraft}>{t('questions.richText.applySource')}</Button>
        </DialogActions>
      </Dialog>

      {enableVideo ? (
        <Dialog open={videoDialogOpen} onClose={() => setVideoDialogOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle>{t('questions.richText.videoEmbed')}</DialogTitle>
          <DialogContent>
            <TextField
              fullWidth
              autoFocus
              label={t('questions.richText.videoUrl')}
              value={videoDraft}
              onChange={(event) => { setVideoDraft(event.target.value); setVideoError(''); }}
              placeholder={t('questions.richText.videoUrlPlaceholder')}
              error={Boolean(videoError)}
              helperText={videoError || t('questions.richText.videoHelp')}
              sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setVideoDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="contained" onClick={applyVideoDraft}>{t('questions.richText.videoInsert')}</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </Box>
  );
}
