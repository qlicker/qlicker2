import { useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

function InstructionPicker({ instructions, kind, label, value, onChoose }) {
  const selectedInstruction = instructions.find((entry) => entry._id === value) || null;
  const options = useMemo(
    () => instructions.filter((entry) => entry.kind === kind),
    [instructions, kind]
  );

  return (
    <Autocomplete
      options={options}
      value={selectedInstruction}
      getOptionLabel={(option) => option.name || ''}
      isOptionEqualToValue={(option, selected) => option._id === selected._id}
      onChange={(_, selected) => onChoose(selected?._id || '')}
      renderInput={(params) => (
        <TextField {...params} label={label} placeholder={label} fullWidth />
      )}
    />
  );
}

export default function AiGradingForm({
  questionNumber,
  value = {},
  instructions,
  onChange,
  onSaveInstruction,
  onDeleteInstruction,
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState({});
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const labelForKind = (kind) => t(
    kind === 'feedback'
      ? 'grades.aiGrading.feedbackToStudentInstructions'
      : 'grades.aiGrading.gradingInstructions'
  );

  const choose = (kind, id) => {
    const instruction = instructions.find((entry) => entry._id === id);
    onChange({
      ...value,
      [kind]: instruction?.content || '',
      [`${kind}InstructionId`]: id,
    });
    setEditing(null);
  };

  const begin = (kind) => {
    const selected = instructions.find((entry) => entry._id === value?.[`${kind}InstructionId`]);
    setDrafts((current) => ({
      ...current,
      [kind]: {
        id: selected?._id || '',
        name: selected?.name || '',
        content: selected?.content || value?.[kind] || '',
      },
    }));
    setEditing(kind);
    setMessage('');
  };

  const save = async (kind) => {
    const draft = drafts[kind];
    if (!draft?.name?.trim() || !draft?.content?.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const instruction = await onSaveInstruction({
        _id: draft.id,
        kind,
        name: draft.name,
        content: draft.content,
      });
      choose(kind, instruction._id);
      setMessage(t('grades.aiGrading.instructionSaved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6">
        {t('grades.aiGrading.formTitle', { question: questionNumber })}
      </Typography>
      {message ? <Alert severity="success">{message}</Alert> : null}
      {['grading', 'feedback'].map((kind) => {
        const selectedInstruction = instructions.find((entry) => entry._id === value?.[`${kind}InstructionId`]);
        const label = labelForKind(kind);
        return (
          <Box key={kind}>
            <InstructionPicker
              instructions={instructions}
              kind={kind}
              label={label}
              value={value?.[`${kind}InstructionId`] || ''}
              onChoose={(id) => choose(kind, id)}
            />
            {selectedInstruction && editing !== kind ? (
              <Box sx={{ mt: 1, p: 1, borderLeft: 3, borderColor: 'primary.main', bgcolor: 'action.hover' }}>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {selectedInstruction.content}
                </Typography>
                <Button
                  size="small"
                  color="error"
                  sx={{ mt: 0.5 }}
                  disabled={selectedInstruction._id === 'no-feedback'}
                  onClick={() => onDeleteInstruction(selectedInstruction)}
                >
                  {t('common.delete')}
                </Button>
              </Box>
            ) : null}
            {editing !== kind ? (
              <Button size="small" sx={{ mt: 0.5 }} onClick={() => begin(kind)}>
                {value?.[`${kind}InstructionId`] ? t('common.edit') : t('grades.aiGrading.createInstruction')}
              </Button>
            ) : (
              <Box sx={{ display: 'flex', gap: 1, mt: 1, flexDirection: 'column' }}>
                <Alert severity="info">{t('grades.aiGrading.unsavedInstructionWarning')}</Alert>
                <TextField
                  size="small"
                  label={t('common.name')}
                  value={drafts[kind]?.name || ''}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [kind]: { ...current[kind], name: event.target.value },
                  }))}
                />
                <TextField
                  multiline
                  minRows={3}
                  label={label}
                  value={drafts[kind]?.content || ''}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [kind]: { ...current[kind], content: event.target.value },
                  }))}
                />
                <Box>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={saving || !drafts[kind]?.name?.trim() || !drafts[kind]?.content?.trim()}
                    onClick={() => save(kind)}
                  >
                    {saving ? t('common.saving') : t('common.save')}
                  </Button>
                  <Button size="small" sx={{ ml: 1 }} onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        );
      })}
      <FormControlLabel
        control={(
          <Checkbox
            checked={!!value?.regrade}
            onChange={(event) => onChange({ ...value, regrade: event.target.checked })}
          />
        )}
        label={t('grades.aiGrading.regrade')}
      />
    </Box>
  );
}
