import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

function normalizeSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

export default function SessionSelectorDialog({
  open,
  title,
  sessions = [],
  selectedIds = [],
  headerContent = null,
  onChange,
  onClose,
  onConfirm,
  confirmLabel,
  getSessionSecondaryText,
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const filteredSessions = useMemo(() => {
    const normalizedSearch = normalizeSearchValue(search);
    if (!normalizedSearch) return sessions;
    return sessions.filter((session) => (
      normalizeSearchValue(session?.name).includes(normalizedSearch)
    ));
  }, [search, sessions]);

  const filteredIds = filteredSessions.map((session) => String(session._id));
  const selectedIdSet = new Set((selectedIds || []).map((id) => String(id)));
  const selectedFilteredCount = filteredIds.filter((id) => selectedIdSet.has(id)).length;
  const allFilteredSelected = filteredIds.length > 0 && selectedFilteredCount === filteredIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;

  const toggleSession = (sessionId) => {
    const normalizedSessionId = String(sessionId);
    if (selectedIdSet.has(normalizedSessionId)) {
      onChange?.((selectedIds || []).filter((id) => String(id) !== normalizedSessionId));
      return;
    }
    onChange?.([...(selectedIds || []), normalizedSessionId]);
  };

  const toggleAll = (checked) => {
    if (checked) {
      onChange?.([...new Set([...(selectedIds || []), ...filteredIds])]);
      return;
    }
    onChange?.((selectedIds || []).filter((id) => !filteredIds.includes(String(id))));
  };

  const handleClose = () => {
    setSearch('');
    onClose?.();
  };

  const handleConfirm = () => {
    setSearch('');
    onConfirm?.();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {headerContent ? <>{headerContent}</> : null}
        <TextField
          size="small"
          fullWidth
          label={t('grades.coursePanel.searchSessions', { defaultValue: 'Search sessions' })}
          placeholder={t('grades.coursePanel.filterBySession', { defaultValue: 'Filter by session name' })}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ mb: 1.25 }}
        />
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={allFilteredSelected}
              indeterminate={someFilteredSelected}
              onChange={(event) => toggleAll(event.target.checked)}
            />
          )}
          label={t('grades.coursePanel.selectAll', {
            count: filteredIds.length,
            defaultValue: `Select all (${filteredIds.length})`,
          })}
          sx={{ mb: 1 }}
        />
        {filteredSessions.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('grades.coursePanel.noSessionsMatch', { defaultValue: 'No sessions match the current filter.' })}
          </Typography>
        ) : (
          <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 360, overflowY: 'auto' }}>
            {filteredSessions.map((session) => {
              const sessionId = String(session._id);
              const checked = selectedIdSet.has(sessionId);
              const sessionName = session.name || t('grades.coursePanel.untitledSession', { defaultValue: 'Untitled session' });
              return (
                <ListItemButton key={sessionId} onClick={() => toggleSession(sessionId)}>
                  <Checkbox
                    size="small"
                    checked={checked}
                    slotProps={{
                      input: {
                        'aria-label': t('grades.coursePanel.toggleSessionSelection', {
                          session: sessionName,
                          defaultValue: `Toggle selection for ${sessionName}`,
                        }),
                      }
                    }}
                  />
                  <ListItemText
                    primary={sessionName}
                    secondary={typeof getSessionSecondaryText === 'function'
                      ? getSessionSecondaryText(session)
                      : (session.status ? t('grades.coursePanel.sessionStatus', {
                        status: session.status,
                        defaultValue: `Status: ${session.status}`,
                      }) : undefined)}
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={handleConfirm}>
          {confirmLabel || t('common.confirm', { defaultValue: 'Confirm' })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
