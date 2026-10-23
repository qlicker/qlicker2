import { useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Divider, FormControlLabel, IconButton, MenuItem, Paper, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon, DeleteOutlined as DeleteIcon, Refresh as DiscoverIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import { getAiModelDisplayName } from '../../utils/aiBackends';

function newBackend() {
  return { id: `backend-${crypto.randomUUID()}`, name: '', type: 'ollama', url: '', apiToken: '', models: [] };
}

const MASKED_TOKEN = '********';

export default function AiBackendManager({
  backends = [],
  onChange,
  defaultBackendId = '',
  defaultModelId = '',
  onDefaultChange,
  courseId = '',
  canAddBackends = true,
  modelPolicies = [],
  onModelPoliciesChange,
  readOnly = false,
}) {
  const { t } = useTranslation();
  const [discovering, setDiscovering] = useState({});
  const [editingTokens, setEditingTokens] = useState({});
  const [error, setError] = useState('');

  const updateBackend = (backendId, update, options) => {
    const nextBackends = backends.map((backend) => (
      backend.id === backendId ? { ...backend, ...update } : backend
    ));
    if (options) onChange(nextBackends, options);
    else onChange(nextBackends);
  };
  const policyFor = (backendId, modelId) => modelPolicies.find((entry) => (
    entry.backendId === backendId && entry.modelId === modelId
  ));
  const updateModelPolicy = (backendId, modelId, update) => {
    const existing = policyFor(backendId, modelId);
    if (update.approved === false) {
      onModelPoliciesChange(modelPolicies.filter((entry) => !(entry.backendId === backendId && entry.modelId === modelId)));
      return;
    }
    const next = { ...existing, backendId, modelId, studentAvailable: existing?.studentAvailable || false, ...update };
    delete next.approved;
    onModelPoliciesChange([
      ...modelPolicies.filter((entry) => !(entry.backendId === backendId && entry.modelId === modelId)),
      next,
    ]);
  };
  const discover = async (backend) => {
    setDiscovering((current) => ({ ...current, [backend.id]: true })); setError('');
    try {
      const { data } = await apiClient.post('/ai/discover-models', {
        backendId: backend.id,
        url: backend.url,
        type: backend.type,
        apiToken: backend.apiToken || '',
        ...(courseId ? { courseId } : {}),
      });
      const existing = new Map((backend.models || []).map((model) => [model.id, model]));
      updateBackend(backend.id, { models: (data.models || []).map((model) => ({
        ...model,
        displayName: existing.get(model.id)?.displayName || '',
        available: existing.get(model.id)?.available !== false,
      })) });
    } catch (err) { setError(err.response?.data?.message || t('ai.backends.discoveryFailed')); }
    finally { setDiscovering((current) => ({ ...current, [backend.id]: false })); }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}
      {backends.map((backend, index) => {
        const models = backend.models || [];
        // Course settings must show every eligible model, including models the
        // professor has not approved yet. Hiding unchecked models made it look
        // as though administrator-configured models were unavailable.
        const visibleModels = courseId
          ? models.filter((model) => model.available !== false)
          : models;
        const editingToken = !!editingTokens[backend.id];
        return (
          <Paper key={backend.id} variant="outlined" sx={{ p: 1.5 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography variant="subtitle2">{readOnly ? (backend.name || backend.url) : t('ai.backends.backendNumber', { number: index + 1 })}</Typography>
              {!readOnly ? <IconButton aria-label={t('ai.backends.removeBackend')} onClick={() => onChange(backends.filter((entry) => entry.id !== backend.id))}><DeleteIcon /></IconButton> : null}
            </Box>
            {!readOnly ? <>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 150px' } }}>
                <TextField size="small" label={t('ai.backends.name')} value={backend.name || ''} onChange={(event) => updateBackend(backend.id, { name: event.target.value })} />
                <TextField select size="small" label={t('ai.backends.type')} value={backend.type || 'ollama'} onChange={(event) => updateBackend(backend.id, { type: event.target.value })}>
                  <MenuItem value="ollama">Ollama</MenuItem><MenuItem value="openai">OpenAI-compatible</MenuItem>
                </TextField>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                <TextField size="small" label={t('ai.backends.url')} value={backend.url || ''} onChange={(event) => updateBackend(backend.id, { url: event.target.value })} placeholder="http://localhost:11434" sx={{ flex: 1, minWidth: 260 }} />
                <TextField
                  size="small"
                  type="password"
                  label={t('ai.backends.apiToken')}
                  value={editingToken ? (backend.apiToken || '') : (backend.apiToken || (backend.apiTokenSet ? MASKED_TOKEN : ''))}
                  onFocus={() => {
                    if (!backend.apiToken && backend.apiTokenSet) {
                      setEditingTokens((current) => ({ ...current, [backend.id]: true }));
                    }
                  }}
                  onChange={(event) => updateBackend(backend.id, { apiToken: event.target.value }, { deferSave: true })}
                  onBlur={() => {
                    setEditingTokens((current) => ({ ...current, [backend.id]: false }));
                    if (backend.apiToken) onChange(backends, { saveImmediately: true });
                  }}
                  sx={{ flex: 1, minWidth: 220 }}
                />
                <Button variant="outlined" startIcon={<DiscoverIcon />} disabled={!backend.url || discovering[backend.id]} onClick={() => discover(backend)}>{t('ai.backends.showAvailableModels')}</Button>
              </Box>
            </> : null}
            {visibleModels.length > 0 ? <>
              <Divider sx={{ my: 1.25 }} />
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: 'block',
                  mb: 0.75
                }}>{t('ai.backends.modelsHelp')}</Typography>
              {visibleModels.map((model, modelIndex) => {
                const modelPolicy = policyFor(backend.id, model.id);
                const isDefault = defaultBackendId === backend.id && defaultModelId === model.id;
                const defaultDisplayName = getAiModelDisplayName(backend, model);
                const resolvedDisplayName = getAiModelDisplayName(backend, model, modelPolicy?.displayName);
                const modelRowSx = {
                  display: 'grid',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(180px, 0.75fr) minmax(260px, 1.25fr) auto' },
                  alignItems: 'center',
                  columnGap: 1.5,
                  rowGap: 0.75,
                  py: 1,
                  borderTop: modelIndex ? 1 : 0,
                  borderColor: 'divider',
                };
                const availabilitySx = { m: 0, minWidth: 0 };
                const nameFieldSx = { width: '100%', gridColumn: courseId ? { xs: '1', md: '2 / -1' } : undefined };
                return (
                  <Box key={model.id} sx={modelRowSx}>
                    {courseId ? <>
                      <FormControlLabel
                        sx={availabilitySx}
                        control={<Checkbox
                          checked={!!modelPolicy}
                          disabled={isDefault}
                          onChange={(event) => updateModelPolicy(backend.id, model.id, { approved: event.target.checked })}
                          slotProps={{ input: { 'aria-label': `${resolvedDisplayName}: ${t('ai.backends.availableToProfessors')}` } }}
                        />}
                        label={<Box>
                          <Typography variant="body2">{resolvedDisplayName}</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.backends.availableToProfessors')}</Typography>
                        </Box>}
                      />
                      <TextField
                        size="small"
                        label={t('ai.backends.displayName')}
                        value={resolvedDisplayName}
                        disabled={!modelPolicy}
                        onChange={(event) => updateModelPolicy(backend.id, model.id, { displayName: event.target.value })}
                        sx={nameFieldSx}
                        slotProps={{
                          htmlInput: { maxLength: 200, 'aria-label': `${model.name}: ${t('ai.backends.displayName')}` }
                        }}
                      />
                      {modelPolicy ? <FormControlLabel
                        sx={{ m: 0, gridColumn: { xs: '1', md: '2 / -1' }, justifySelf: 'start' }}
                        control={<Checkbox size="small" checked={!!modelPolicy.studentAvailable} onChange={(event) => updateModelPolicy(backend.id, model.id, { studentAvailable: event.target.checked })} slotProps={{
                          input: { 'aria-label': `${resolvedDisplayName}: ${t('ai.backends.availableToStudents')}` }
                        }} />}
                        label={t('ai.backends.availableToStudents')}
                      /> : null}
                    </> : <>
                      <FormControlLabel sx={availabilitySx} control={<Checkbox checked={model.available !== false} onChange={(event) => updateBackend(backend.id, { models: backend.models.map((entry) => entry.id === model.id ? { ...entry, available: event.target.checked } : entry) })} />} label={model.name} />
                      <TextField
                        size="small"
                        label={t('ai.backends.displayName')}
                        value={model.displayName || defaultDisplayName}
                        disabled={model.available === false}
                        onChange={(event) => updateBackend(backend.id, { models: backend.models.map((entry) => entry.id === model.id ? { ...entry, displayName: event.target.value } : entry) })}
                        sx={nameFieldSx}
                        slotProps={{
                          htmlInput: { maxLength: 200, 'aria-label': `${model.name}: ${t('ai.backends.displayName')}` }
                        }}
                      />
                      <Button size="small" sx={{ justifySelf: { xs: 'start', md: 'stretch' } }} variant={isDefault ? 'contained' : 'outlined'} onClick={() => onDefaultChange(backend.id, model.id)}>{t('ai.backends.makeDefault')}</Button>
                    </>}
                  </Box>
                );
              })}
            </> : null}
          </Paper>
        );
      })}
      {canAddBackends && !readOnly ? <Button startIcon={<AddIcon />} variant="outlined" onClick={() => onChange([...backends, newBackend()])}>{t('ai.backends.addBackend')}</Button> : null}
    </Box>
  );
}
