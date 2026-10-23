import { useCallback, useEffect, useMemo, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, IconButton, List, ListItemButton, ListItemText, Paper, Typography } from '@mui/material';
import { Add as AddIcon, DeleteOutlined as DeleteIcon, ExpandMore as ExpandMoreIcon, Stop as StopIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import StudentRichTextEditor from '../questions/StudentRichTextEditor';
import { extractPlainTextFromHtml } from '../questions/richTextUtils';
import AiMarkdownContent from './AiMarkdownContent';
import AiModelSelect, { parseAiModelValue } from './AiModelSelect';

const AI_CHAT_EDITOR_CHANGE_DEBOUNCE_MS = 160;

function formatMessageTime(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function normalizeDraft(value) {
  if (typeof value === 'string') {
    return { html: value, plainText: extractPlainTextFromHtml(value) };
  }
  const html = String(value?.html || '');
  return { html, plainText: String(value?.plainText ?? extractPlainTextFromHtml(html)) };
}

function getQuizTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function AiMessageArtifacts({ conversationId, artifacts = [] }) {
  const { t } = useTranslation();
  const [unavailable, setUnavailable] = useState({});
  const [downloading, setDownloading] = useState({});
  if (!conversationId || !artifacts.length) return null;
  const markUnavailable = (artifactId) => setUnavailable((current) => ({ ...current, [artifactId]: true }));
  const downloadArtifact = async (artifact, url) => {
    setDownloading((current) => ({ ...current, [artifact._id]: true }));
    try {
      const { data } = await apiClient.get(url, { baseURL: '/', responseType: 'blob' });
      const objectUrl = window.URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = artifact.filename || 'artifact';
      link.style.display = 'none';
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
      }
    } catch {
      markUnavailable(artifact._id);
    } finally {
      setDownloading((current) => ({ ...current, [artifact._id]: false }));
    }
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}>
      {artifacts.map((artifact) => {
        const url = `/ai/media/${encodeURIComponent(conversationId)}/${encodeURIComponent(artifact._id)}`;
        const label = artifact.label || artifact.filename || t(
          artifact.kind === 'image' ? 'ai.chat.generatedImage' : artifact.kind === 'audio' ? 'ai.chat.generatedAudio' : 'ai.chat.generatedFile'
        );
        if (unavailable[artifact._id]) {
          return <Alert key={artifact._id} severity="warning">{t('ai.chat.artifactUnavailable')}</Alert>;
        }
        if (artifact.kind === 'image') {
          return (
            <Box key={artifact._id}>
              <Box component="img" src={url} alt={label} onError={() => markUnavailable(artifact._id)} sx={{ display: 'block', maxWidth: '100%', maxHeight: 520, borderRadius: 1 }} />
              {artifact.label ? <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>{artifact.label}</Typography> : null}
            </Box>
          );
        }
        if (artifact.kind === 'audio') {
          return <Box key={artifact._id}>
            {artifact.label ? <Typography variant="body2" sx={{ mb: 0.5 }}>{artifact.label}</Typography> : null}
            <Box component="audio" controls preload="metadata" src={url} aria-label={label} onError={() => markUnavailable(artifact._id)} sx={{ display: 'block', width: '100%', maxWidth: 520 }} />
          </Box>;
        }
        return <Button key={artifact._id} type="button" onClick={() => downloadArtifact(artifact, url)} disabled={!!downloading[artifact._id]} variant="outlined" size="small" sx={{ alignSelf: 'flex-start' }}>
          {t('ai.chat.downloadArtifact', { filename: artifact.filename || label })}
        </Button>;
      })}
    </Box>
  );
}

export default function AiCourseChat({ courseId, audience = 'instructor' }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({ html: '', plainText: '' });
  const [pendingMessage, setPendingMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const apiBase = audience === 'student'
    ? `/ai/student/courses/${courseId}`
    : `/ai/courses/${courseId}`;

  const updateConversation = useCallback((conversation, { select = true } = {}) => {
    if (!conversation) return;
    if (select) setSelected(conversation);
    setConversations((current) => [conversation, ...current.filter((item) => item._id !== conversation._id)]);
  }, []);

  const loadConversation = useCallback(async (id, { silent = false, clearPendingError = false } = {}) => {
    try {
      const endpoint = `${apiBase}/conversations/${id}`;
      const { data } = clearPendingError
        ? await apiClient.delete(`${endpoint}/pending-error`)
        : await apiClient.get(endpoint);
      updateConversation(data.conversation);
      if (!silent) setError('');
      return data.conversation;
    } catch (err) {
      if (!silent) setError(err.response?.data?.message || t('ai.chat.failedLoad'));
      return null;
    }
  }, [apiBase, t, updateConversation]);

  const loadConversations = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await apiClient.get(`${apiBase}/conversations`);
      const nextConversations = data.conversations || [];
      setConversations(nextConversations);
      if (nextConversations[0]) {
        await loadConversation(nextConversations[0]._id, {
          silent: true,
          clearPendingError: !!nextConversations[0].pendingError && !nextConversations[0].pending,
        });
      } else setSelected(null);
    } catch (err) {
      setError(err.response?.data?.message || t('ai.chat.failedLoad'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, loadConversation, t]);

  const loadConversationStatus = useCallback(async (id) => {
    try {
      const { data } = await apiClient.get(`${apiBase}/conversations/${id}/status`);
      const status = data.conversation;
      if (!status) return;
      setSelected((current) => (current?._id === id ? { ...current, ...status } : current));
      setConversations((current) => current.map((entry) => (
        entry._id === id ? { ...entry, ...status } : entry
      )));
      if (!status.pending) await loadConversation(id, { silent: true });
    } catch { /* The next foreground action will surface a persistent error. */ }
  }, [apiBase, loadConversation]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // A pending flag is persisted on the conversation, so returning to this tab
  // restores the waiting state and this lightweight poll picks up completion.
  useEffect(() => {
    if (!selected?.pending) return undefined;
    const timer = setInterval(() => { loadConversationStatus(selected._id); }, 750);
    return () => clearInterval(timer);
  }, [loadConversationStatus, selected?._id, selected?.pending]);

  const createConversation = async () => {
    try {
      const { data } = await apiClient.post(`${apiBase}/conversations`);
      updateConversation(data.conversation); setError('');
      return data.conversation;
    } catch (err) {
      setError(err.response?.data?.message || t('ai.chat.failedLoad'));
      return null;
    }
  };

  const deleteConversation = async (id) => {
    try {
      await apiClient.delete(`${apiBase}/conversations/${id}`);
      setConversations((current) => current.filter((item) => item._id !== id));
      if (selected?._id === id) setSelected(null);
    } catch (err) { setError(err.response?.data?.message || t('ai.chat.failedLoad')); }
  };

  const send = async (draftOverride) => {
    const resolvedDraft = normalizeDraft(draftOverride || draft);
    const content = resolvedDraft.plainText.trim();
    if (!content || pendingMessage || selected?.pending) return;

    const submittedDraft = { ...resolvedDraft, content };
    setPendingMessage({ conversationId: selected?._id || '', content, contentWysiwyg: resolvedDraft.html });
    setDraft({ html: '', plainText: '' });
    setError('');

    let conversation = selected;
    if (!conversation) {
      conversation = await createConversation();
      if (!conversation) {
        setPendingMessage(null);
        setDraft(submittedDraft);
        return;
      }
      setPendingMessage((current) => (current ? { ...current, conversationId: conversation._id } : current));
    }

    try {
      const { data } = await apiClient.post(
        `${apiBase}/conversations/${conversation._id}/messages`,
        {
          content,
          contentWysiwyg: submittedDraft.html,
          timeZone: getQuizTimeZone(),
          ...parseAiModelValue(selectedModel),
        }
      );
      updateConversation(data.conversation);
      setPendingMessage(null);
    } catch (err) {
      setPendingMessage(null);
      setDraft(submittedDraft);
      setError(err.response?.data?.message || t('ai.chat.failedSend'));
    }
  };

  const stop = async () => {
    if (!selected?.pending || stopping) return;
    setStopping(true);
    try {
      const { data } = await apiClient.post(`${apiBase}/conversations/${selected._id}/stop`);
      updateConversation(data.conversation);
    } catch (err) {
      setError(err.response?.data?.message || t('ai.chat.failedSend'));
    } finally {
      setStopping(false);
    }
  };

  const handleDraftKeyDown = useCallback((event, latestDraft) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing) return false;
    event.preventDefault();
    send(latestDraft);
    return true;
  }, [send]);

  const isThinking = !!pendingMessage || !!selected?.pending;
  const messages = useMemo(() => {
    const savedMessages = selected?.messages || [];
    const showOptimisticMessage = pendingMessage && (!selected || pendingMessage.conversationId === selected._id);
    return showOptimisticMessage
      ? [...savedMessages, { _id: 'pending-user-message', role: 'user', content: pendingMessage.content }]
      : savedMessages;
  }, [pendingMessage, selected]);

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '250px minmax(0, 1fr)' }, gap: 1.5 }}>
      <Paper variant="outlined" sx={{ p: 1 }}>
        <Button fullWidth startIcon={<AddIcon />} variant="outlined" onClick={createConversation} disabled={isThinking}>{t('ai.chat.newConversation')}</Button>
        {loading ? <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={22} /></Box> : <List dense>
          {conversations.length ? conversations.map((conversation) => <ListItemButton key={conversation._id} selected={selected?._id === conversation._id} onClick={() => loadConversation(conversation._id, { clearPendingError: !!conversation.pendingError && !conversation.pending })} disabled={isThinking}>
            <ListItemText primary={conversation.title || t('ai.chat.newConversation')} secondary={formatMessageTime(conversation.updatedAt)} />
            <IconButton size="small" aria-label={t('ai.chat.deleteConversation')} disabled={isThinking} onClick={(event) => { event.stopPropagation(); deleteConversation(conversation._id); }}><DeleteIcon fontSize="small" /></IconButton>
          </ListItemButton>) : <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              p: 1
            }}>{t('ai.chat.noConversations')}</Typography>}
        </List>}
      </Paper>
      <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', minHeight: 520 }}>
        {error ? <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>{error}</Alert> : null}
        {selected?.pendingError ? <Alert severity="warning" sx={{ mb: 1 }} onClose={() => loadConversation(selected._id, { silent: true, clearPendingError: true })}>{selected.pendingError}</Alert> : null}
        <Box sx={{ mb: 1.5 }}><AiModelSelect courseId={courseId} value={selectedModel} onChange={setSelectedModel} disabled={isThinking} audience={audience} task="chat" /></Box>
        <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.25, mb: 1.5 }} aria-live="polite">
          {!selected && !pendingMessage ? <Typography sx={{
            color: "text.secondary"
          }}>{t('ai.chat.selectConversation')}</Typography> : messages.length === 0 && !pendingMessage ? <Alert severity="info" sx={{ alignSelf: 'stretch' }}>{t(audience === 'student' ? 'ai.chat.studentNewConversationGuidance' : 'ai.chat.newConversationGuidance')}</Alert> : messages.map((message) => {
            const isErrorMessage = message.role === 'assistant' && (
              message.isError || String(message.content || '').startsWith('AI backend ran into an error:')
            );
            const errorDetail = String(message.content || '').replace(/^AI backend ran into an error:\s*/, '');
            return (
              <Paper key={message._id} variant="outlined" role={isErrorMessage ? 'alert' : undefined} sx={{ p: 1.25, alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%', bgcolor: isErrorMessage ? 'warning.light' : message.role === 'user' ? 'action.hover' : 'background.paper', borderColor: isErrorMessage ? 'warning.main' : undefined, color: isErrorMessage ? 'warning.contrastText' : undefined }}>
              <Typography variant="caption" color={isErrorMessage ? 'inherit' : 'text.secondary'} sx={isErrorMessage ? { fontWeight: 700 } : undefined}>{isErrorMessage ? t('ai.chat.errorLabel') : message.role === 'user' ? t('ai.chat.you') : t('ai.chat.assistant')}</Typography>
              {message.role === 'assistant' && message.thinking ? <Accordion disableGutters elevation={0} sx={{ mt: 0.75, mb: 0.75, bgcolor: 'action.hover', '&::before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-label={t('ai.chat.thoughtProcess')} sx={{ minHeight: 38, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>{t('ai.chat.thoughtProcess')}</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0, maxHeight: 280, overflowY: 'auto' }}><AiMarkdownContent content={message.thinking} /></AccordionDetails>
              </Accordion> : null}
              {message.role === 'assistant'
                ? <AiMarkdownContent content={isErrorMessage ? t('ai.chat.backendError', { detail: errorDetail }) : message.content} />
                : <Typography sx={{ whiteSpace: 'pre-wrap' }}>{message.content}</Typography>}
              {message.role === 'assistant' ? <AiMessageArtifacts conversationId={selected?._id} artifacts={message.artifacts} /> : null}
            </Paper>
            );
          })}
          {isThinking ? <Paper variant="outlined" role="status" sx={{ p: 1.25, alignSelf: 'flex-start', maxWidth: '90%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, animation: 'ai-thinking-pulse 1.4s ease-in-out infinite', '@keyframes ai-thinking-pulse': { '0%, 100%': { opacity: 0.55 }, '50%': { opacity: 1 } } }}>
              <CircularProgress size={18} aria-label={t('ai.chat.thinking')} />
              <Typography>{t('ai.chat.thinking')}</Typography>
            </Box>
            {selected?.pendingThinking ? <Box sx={{ mt: 1, pl: 3.25, maxHeight: 280, overflowY: 'auto' }}><AiMarkdownContent content={selected.pendingThinking} /></Box> : null}
          </Paper> : null}
        </Box>
        <StudentRichTextEditor value={draft.html} onChange={(value) => setDraft(normalizeDraft(value))} onChangeDebounceMs={AI_CHAT_EDITOR_CHANGE_DEBOUNCE_MS} onKeyDown={handleDraftKeyDown} placeholder={t('ai.chat.messagePlaceholder')} disabled={isThinking} ariaLabel={t('ai.chat.messagePlaceholder')} minHeight={110} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <Button variant="contained" color={isThinking ? 'error' : 'primary'} startIcon={isThinking ? <StopIcon /> : undefined} disabled={isThinking ? (!selected?.pending || stopping) : (!draft.plainText.trim() || !selectedModel)} onClick={isThinking ? stop : () => send()}>
            {isThinking ? t('ai.chat.stop') : t('ai.chat.send')}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
