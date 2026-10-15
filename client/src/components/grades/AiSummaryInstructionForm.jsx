import { useEffect, useState } from 'react';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

const BASIC_SUMMARY_ID = 'basic-summary';

export default function AiSummaryInstructionForm({ instructionId, instruction, instructions, onChange, onSaveInstruction, onDeleteInstruction, onEditingChange }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);

  const selectedInstruction = instructions.find((entry) => entry._id === instructionId);

  useEffect(() => {
    setDraft(null);
    setEditing(false);
    setMessage('');
  }, [instructionId]);

  const choose = (selected) => {
    onChange({ instructionId: selected?._id || '', instruction: selected?.content || '' });
  };

  const begin = () => {
    setDraft({
      _id: selectedInstruction?._id === BASIC_SUMMARY_ID ? '' : selectedInstruction?._id || '',
      name: selectedInstruction?.name || '',
      content: selectedInstruction?.content || instruction || '',
    });
    setEditing(true);
    setMessage('');
  };

  const save = async () => {
    if (!draft?.name.trim() || !draft?.content.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const savedInstruction = await onSaveInstruction({ ...draft, kind: 'summary' });
      choose(savedInstruction);
      setEditing(false);
      setMessage(t('grades.aiGrading.instructionSaved'));
    } finally {
      setSaving(false);
    }
  };

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    {message ? <Alert severity="success">{message}</Alert> : null}
    <TextField
      select
      fullWidth
      label={t('professor.sessionReview.summaryInstructions')}
      value={instructionId || ''}
      onChange={(event) => choose(instructions.find((entry) => entry._id === event.target.value))}
    >
      <MenuItem value="">{t('grades.aiGrading.selectInstruction')}</MenuItem>
      {instructions.filter((entry) => entry.kind === 'summary').map((entry) => <MenuItem key={entry._id} value={entry._id}>{entry.name}</MenuItem>)}
    </TextField>
    {selectedInstruction && !editing ? <Box sx={{ p: 1, borderLeft: 3, borderColor: 'primary.main', bgcolor: 'action.hover' }}>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{selectedInstruction.content}</Typography>
      {selectedInstruction._id !== BASIC_SUMMARY_ID ? <Button size="small" color="error" sx={{ mt: 0.5 }} onClick={() => onDeleteInstruction(selectedInstruction)}>{t('common.delete')}</Button> : null}
    </Box> : null}
    {!editing ? <Box sx={{ display: 'flex', gap: 1 }}>
      {instructionId ? <Button size="small" onClick={begin}>{t('common.edit')}</Button> : null}
      <Button size="small" onClick={() => { setDraft({ _id: '', name: '', content: '' }); setEditing(true); setMessage(''); }}>{t('grades.aiGrading.createInstruction')}</Button>
    </Box> : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Alert severity="info">{t('professor.sessionReview.unsavedSummaryInstructionWarning')}</Alert>
      <TextField size="small" label={t('common.name')} value={draft?.name || ''} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
      <TextField multiline minRows={4} label={t('professor.sessionReview.summaryInstructions')} value={draft?.content || ''} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} />
      <Box>
        <Button size="small" variant="contained" disabled={saving || !draft?.name.trim() || !draft?.content.trim()} onClick={save}>{saving ? t('common.saving') : t('common.save')}</Button>
        <Button size="small" sx={{ ml: 1 }} onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
      </Box>
    </Box>}
  </Box>;
}
