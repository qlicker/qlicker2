import { useEffect, useRef, useState } from 'react';
import { Alert, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';

export function aiModelValue(backendId, modelId) {
  return backendId && modelId ? `${backendId}::${modelId}` : '';
}

export function parseAiModelValue(value) {
  const [backendId = '', modelId = ''] = String(value || '').split('::');
  return { backendId, modelId };
}

export default function AiModelSelect({ courseId, value, onChange, disabled = false, fullWidth = true, audience = 'instructor', task = '' }) {
  const { t } = useTranslation();
  const [models, setModels] = useState([]);
  const [error, setError] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const persistenceKey = task ? `qlicker.ai.model.${audience}.${courseId}.${task}` : '';

  useEffect(() => {
    let active = true;
    const configPath = audience === 'student'
      ? `/ai/student/courses/${courseId}/config`
      : `/ai/courses/${courseId}/config`;
    apiClient.get(configPath)
      .then(({ data }) => {
        if (!active) return;
        const nextModels = data.approvedModels || [];
        const defaultValue = aiModelValue(data.defaultBackendId, data.defaultModelId);
        const persistedValue = persistenceKey ? localStorage.getItem(persistenceKey) || '' : '';
        setModels(nextModels);
        const availableValues = new Set(nextModels.map((model) => aiModelValue(model.backendId, model.modelId)));
        if (persistedValue && availableValues.has(persistedValue) && persistedValue !== value) {
          onChangeRef.current(persistedValue);
        } else if (!value || !availableValues.has(value)) {
          const nextValue = nextModels.some((model) => aiModelValue(model.backendId, model.modelId) === defaultValue)
            ? defaultValue
            : aiModelValue(nextModels[0]?.backendId, nextModels[0]?.modelId);
          if (persistenceKey && nextValue) localStorage.setItem(persistenceKey, nextValue);
          onChangeRef.current(nextValue);
        }
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || t('ai.models.failedLoad'));
      });
    return () => { active = false; };
  // Selection remains under the parent while configuration is course-scoped.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, courseId, persistenceKey, t]);

  if (error) return <Alert severity="error">{error}</Alert>;
  const selectedValue = models.some(
    (model) => aiModelValue(model.backendId, model.modelId) === value
  ) ? value : '';
  return <TextField
    select
    size="small"
    label={t('ai.models.modelForTask')}
    value={selectedValue}
    onChange={(event) => {
      if (persistenceKey) localStorage.setItem(persistenceKey, event.target.value);
      onChange(event.target.value);
    }}
    disabled={disabled || models.length === 0}
    fullWidth={fullWidth}
  >
    {models.map((model) => <MenuItem key={aiModelValue(model.backendId, model.modelId)} value={aiModelValue(model.backendId, model.modelId)}>
      {model.displayName || `${model.backendName} — ${model.modelName}`}
    </MenuItem>)}
  </TextField>;
}
