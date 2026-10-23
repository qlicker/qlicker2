import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box, Typography, Button, Paper, TextField, Divider, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, List, Chip,
  Alert, CircularProgress, Tooltip, Snackbar,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon,
  NavigateBefore as PrevIcon, NavigateNext as NextIcon,
  Download as DownloadIcon, Upload as UploadIcon,
  Edit as EditIcon, Check as CheckIcon, Close as CloseIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import StudentListItem from '../common/StudentListItem';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortStudentsByLastName(students = []) {
  return [...students].sort((a, b) => {
    const aLast = (a?.profile?.lastname || '').toLowerCase();
    const bLast = (b?.profile?.lastname || '').toLowerCase();
    const cmp = aLast.localeCompare(bLast);
    if (cmp !== 0) return cmp;
    const aFirst = (a?.profile?.firstname || '').toLowerCase();
    const bFirst = (b?.profile?.firstname || '').toLowerCase();
    return aFirst.localeCompare(bFirst);
  });
}

function matchesSearch(student, term) {
  if (!term) return true;
  const lower = term.toLowerCase();
  const first = (student?.profile?.firstname || '').toLowerCase();
  const last = (student?.profile?.lastname || '').toLowerCase();
  const email = (student?.emails?.[0]?.address || student?.email || '').toLowerCase();
  return first.includes(lower) || last.includes(lower) || email.includes(lower);
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * GroupManagementPanel — full group management UI, designed to be a tab panel
 * within the professor CourseDetail page.
 *
 * @param {string} courseId   – the course _id
 * @param {Array}  students   – array of populated student objects from the course
 */
export default function GroupManagementPanel({ courseId, students = [] }) {
  const { t } = useTranslation();

  // API data
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selection state
  const [selectedCatIdx, setSelectedCatIdx] = useState(-1);
  const [selectedGroupIdx, setSelectedGroupIdx] = useState(-1);

  // Create category dialog
  const [createCatOpen, setCreateCatOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatGroupCount, setNewCatGroupCount] = useState(2);
  const [creating, setCreating] = useState(false);

  // Rename group
  const [renamingGroup, setRenamingGroup] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // CSV upload
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadCatName, setUploadCatName] = useState('');
  const [uploadCsvText, setUploadCsvText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileInputRef = useRef(null);

  // Student filter
  const [searchTerm, setSearchTerm] = useState('');
  const [showUngrouped, setShowUngrouped] = useState(true);
  const searchDebounceRef = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Snackbar
  const [msg, setMsg] = useState(null);

  // Build student lookup
  const studentMap = useMemo(() => {
    const map = {};
    for (const s of students) {
      if (s?._id) map[s._id] = s;
    }
    return map;
  }, [students]);

  // Debounce search input
  const handleSearchChange = useCallback((e) => {
    const val = e.target.value;
    setSearchTerm(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(val), 150);
  }, []);

  // ---- Fetch ----
  const fetchGroups = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/groups`);
      setCategories(data.groupCategories || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || t('groups.failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [courseId, t]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  // Keep selection valid after data changes
  useEffect(() => {
    if (selectedCatIdx >= categories.length) {
      setSelectedCatIdx(categories.length > 0 ? 0 : -1);
      setSelectedGroupIdx(-1);
    }
  }, [categories, selectedCatIdx]);

  useEffect(() => {
    const cat = categories[selectedCatIdx];
    if (cat && selectedGroupIdx >= (cat.groups || []).length) {
      setSelectedGroupIdx(cat.groups.length > 0 ? 0 : -1);
    }
  }, [categories, selectedCatIdx, selectedGroupIdx]);

  // ---- Derived data ----
  const selectedCat = categories[selectedCatIdx] || null;
  const selectedGroup = selectedCat ? (selectedCat.groups || [])[selectedGroupIdx] : null;

  const studentsInSelectedGroup = useMemo(() => {
    if (!selectedGroup) return [];
    return sortStudentsByLastName(
      (selectedGroup.members || []).map((id) => studentMap[id]).filter(Boolean)
    );
  }, [selectedGroup, studentMap]);

  const allStudentsInCategory = useMemo(() => {
    if (!selectedCat) return new Set();
    const ids = new Set();
    for (const g of (selectedCat.groups || [])) {
      for (const id of (g.members || [])) ids.add(id);
    }
    return ids;
  }, [selectedCat]);

  const studentsToShow = useMemo(() => {
    if (!selectedCat) return sortStudentsByLastName(students);
    const pool = showUngrouped
      ? students.filter((s) => !allStudentsInCategory.has(s._id))
      : students.filter((s) => allStudentsInCategory.has(s._id));
    return sortStudentsByLastName(pool.filter((s) => matchesSearch(s, debouncedSearch)));
  }, [selectedCat, students, showUngrouped, allStudentsInCategory, debouncedSearch]);

  // ---- API helpers ----
  const updateCategories = (data) => {
    setCategories(data.groupCategories || []);
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    setCreating(true);
    try {
      const { data } = await apiClient.post(`/courses/${courseId}/groups`, {
        categoryName: newCatName.trim(),
        numberOfGroups: Math.max(1, newCatGroupCount),
      });
      updateCategories(data);
      const newIdx = (data.groupCategories || []).length - 1;
      setSelectedCatIdx(newIdx);
      setSelectedGroupIdx(0);
      setCreateCatOpen(false);
      setNewCatName('');
      setNewCatGroupCount(2);
      setMsg({ severity: 'success', text: t('groups.categoryCreated') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedCreateCategory') });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!selectedCat) return;
    if (!window.confirm(t('groups.deleteCategoryConfirm', { name: selectedCat.categoryName }))) return;
    try {
      const { data } = await apiClient.delete(`/courses/${courseId}/groups/${selectedCat.categoryNumber}`);
      updateCategories(data);
      setSelectedCatIdx(-1);
      setSelectedGroupIdx(-1);
      setMsg({ severity: 'success', text: t('groups.categoryDeleted') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedDeleteCategory') });
    }
  };

  const handleAddGroup = async () => {
    if (!selectedCat) return;
    try {
      const { data } = await apiClient.post(`/courses/${courseId}/groups/${selectedCat.categoryNumber}/groups`, {});
      updateCategories(data);
      const cat = (data.groupCategories || []).find((c) => c.categoryNumber === selectedCat.categoryNumber);
      if (cat) setSelectedGroupIdx(cat.groups.length - 1);
      setMsg({ severity: 'success', text: t('groups.groupAdded') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedAddGroup') });
    }
  };

  const handleDeleteGroup = async () => {
    if (!selectedCat || selectedGroupIdx < 0) return;
    if (!window.confirm(t('groups.deleteGroupConfirm'))) return;
    try {
      const { data } = await apiClient.delete(
        `/courses/${courseId}/groups/${selectedCat.categoryNumber}/groups/${selectedGroupIdx}`
      );
      updateCategories(data);
      setSelectedGroupIdx(0);
      setMsg({ severity: 'success', text: t('groups.groupDeleted') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedDeleteGroup') });
    }
  };

  const handleRenameGroup = async () => {
    if (!selectedCat || selectedGroupIdx < 0 || !renameValue.trim()) return;
    try {
      const { data } = await apiClient.patch(
        `/courses/${courseId}/groups/${selectedCat.categoryNumber}/groups/${selectedGroupIdx}`,
        { name: renameValue.trim() }
      );
      updateCategories(data);
      setRenamingGroup(false);
      setRenameValue('');
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedRenameGroup') });
    }
  };

  const handleAddStudentToGroup = async (studentId) => {
    if (!selectedCat || selectedGroupIdx < 0) return;
    try {
      const { data } = await apiClient.post(
        `/courses/${courseId}/groups/${selectedCat.categoryNumber}/groups/${selectedGroupIdx}/students`,
        { studentId }
      );
      updateCategories(data);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedToggleStudent') });
    }
  };

  const handleRemoveStudentFromGroup = async (studentId) => {
    if (!selectedCat || selectedGroupIdx < 0) return;
    try {
      const { data } = await apiClient.delete(
        `/courses/${courseId}/groups/${selectedCat.categoryNumber}/groups/${selectedGroupIdx}/students/${studentId}`
      );
      updateCategories(data);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedToggleStudent') });
    }
  };

  // When showing "students already in a group", clicking navigates to that group
  const handleSetGroupFromStudent = (studentId) => {
    if (!selectedCat) return;
    for (let gi = 0; gi < (selectedCat.groups || []).length; gi++) {
      if ((selectedCat.groups[gi].members || []).includes(studentId)) {
        setSelectedGroupIdx(gi);
        return;
      }
    }
  };

  const handleDownloadCsv = async () => {
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/groups/csv`, { responseType: 'text' });
      const csvText = typeof data === 'string' ? data : JSON.stringify(data);
      downloadCsv('groups.csv', csvText);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedDownloadCsv') });
    }
  };

  const handleUploadCsv = async () => {
    if (!uploadCatName.trim() || !uploadCsvText.trim()) return;
    setUploading(true);
    try {
      const { data } = await apiClient.post(`/courses/${courseId}/groups/csv`, {
        categoryName: uploadCatName.trim(),
        csv: uploadCsvText.trim(),
      });
      updateCategories(data);
      setUploadResult(data.imported);
      const newIdx = (data.groupCategories || []).findIndex(
        (c) => c.categoryName === uploadCatName.trim()
      );
      if (newIdx >= 0) {
        setSelectedCatIdx(newIdx);
        setSelectedGroupIdx(0);
      }
      setMsg({ severity: 'success', text: t('groups.csvUploaded') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('groups.failedUploadCsv') });
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setUploadCsvText(ev.target.result || '');
    reader.readAsText(file);
  };

  const handleNavigateGroup = (delta) => {
    const cat = categories[selectedCatIdx];
    if (!cat) return;
    const next = selectedGroupIdx + delta;
    if (next >= 0 && next < cat.groups.length) setSelectedGroupIdx(next);
  };

  // ---- Render ----

  if (loading) return <CircularProgress size={24} />;
  if (error) return <Alert severity="error">{error}</Alert>;

  const nGroups = selectedCat ? (selectedCat.groups || []).length : 0;

  const addStudentOnClick = selectedCat && showUngrouped && selectedGroupIdx >= 0;
  const studentListLabel = selectedCat
    ? showUngrouped
      ? t('groups.studentsNotIn', { category: selectedCat.categoryName })
      : t('groups.studentsIn', { category: selectedCat.categoryName })
    : t('groups.allStudents');

  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, minHeight: 400 }}>
      {/* === Left column: Categories === */}
      <Paper variant="outlined" sx={{ flex: 1, p: 2, minWidth: 220 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>{t('groups.categories')}</Typography>

        {categories.length > 0 && (
          <Button size="small" startIcon={<DownloadIcon />} onClick={handleDownloadCsv} sx={{ mb: 1, mr: 1 }}>
            {t('groups.downloadCsv')}
          </Button>
        )}

        <Button size="small" startIcon={<UploadIcon />} onClick={() => { setUploadOpen(true); setUploadResult(null); setUploadCsvText(''); setUploadCatName(''); }} sx={{ mb: 1, mr: 1 }}>
          {t('groups.uploadCsv')}
        </Button>

        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setCreateCatOpen(true)} sx={{ mb: 1 }}>
          {t('groups.createCategory')}
        </Button>

        {categories.length > 0 && (
          <TextField
            select
            size="small"
            fullWidth
            label={t('groups.selectCategory')}
            value={selectedCatIdx >= 0 ? String(selectedCatIdx) : ''}
            onChange={(e) => {
              const idx = Number(e.target.value);
              setSelectedCatIdx(idx);
              const cat = categories[idx];
              setSelectedGroupIdx(cat && cat.groups && cat.groups.length > 0 ? 0 : -1);
              setRenamingGroup(false);
            }}
            sx={{ mb: 1 }}
            slotProps={{
              select: { native: true },
              inputLabel: { shrink: true }
            }}>
            <option value="" disabled>{t('groups.chooseCategory')}</option>
            {categories.map((cat, idx) => (
              <option key={cat.categoryNumber} value={String(idx)}>
                {cat.categoryName} ({(cat.groups || []).length} {t('groups.groupsLabel')})
              </option>
            ))}
          </TextField>
        )}

        {selectedCat && (
          <TextField
            select
            size="small"
            fullWidth
            label={t('groups.selectGroup')}
            value={selectedGroupIdx >= 0 ? String(selectedGroupIdx) : ''}
            onChange={(e) => { setSelectedGroupIdx(Number(e.target.value)); setRenamingGroup(false); }}
            sx={{ mb: 1 }}
            slotProps={{
              select: { native: true },
              inputLabel: { shrink: true }
            }}>
            {(selectedCat.groups || []).map((g, idx) => (
              <option key={idx} value={String(idx)}>
                {g.name} ({(g.members || []).length} {t('groups.membersLabel')})
              </option>
            ))}
          </TextField>
        )}

        {selectedCat && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Button size="small" onClick={handleAddGroup}>{t('groups.addGroup')}</Button>
            <Button size="small" color="error" onClick={handleDeleteCategory}>{t('groups.deleteCategory')}</Button>
          </Box>
        )}
      </Paper>

      {/* === Middle column: Group membership === */}
      <Paper variant="outlined" sx={{ flex: 1, p: 2, minWidth: 260 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>{t('groups.groupMembership')}</Typography>

        {selectedGroup ? (
          <>
            {/* Group name with rename */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              {renamingGroup ? (
                <>
                  <TextField
                    size="small"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    placeholder={selectedGroup.name}
                    sx={{ flex: 1 }}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRenameGroup(); }}
                  />
                  <IconButton size="small" aria-label={t('common.confirmRename')} onClick={handleRenameGroup} color="primary"><CheckIcon fontSize="small" /></IconButton>
                  <IconButton size="small" aria-label={t('common.cancelRename')} onClick={() => setRenamingGroup(false)}><CloseIcon fontSize="small" /></IconButton>
                </>
              ) : (
                <>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>{selectedGroup.name}</Typography>
                  <Tooltip title={t('groups.renameGroup')}>
                    <IconButton size="small" aria-label={t('common.rename')} onClick={() => { setRenamingGroup(true); setRenameValue(selectedGroup.name); }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {nGroups > 1 && (
                    <Tooltip title={t('groups.deleteGroup')}>
                      <IconButton size="small" color="error" aria-label={t('common.delete')} onClick={handleDeleteGroup}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </>
              )}
            </Box>

            {/* Group navigation */}
            {nGroups > 1 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, mb: 1 }}>
                <Button size="small" startIcon={<PrevIcon />} disabled={selectedGroupIdx <= 0} onClick={() => handleNavigateGroup(-1)}>
                  {t('groups.prevGroup')}
                </Button>
                <Button size="small" endIcon={<NextIcon />} disabled={selectedGroupIdx >= nGroups - 1} onClick={() => handleNavigateGroup(1)}>
                  {t('groups.nextGroup')}
                </Button>
              </Box>
            )}

            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t('groups.memberCount', { count: studentsInSelectedGroup.length })}
              {studentsInSelectedGroup.length > 0 ? ` — ${t('groups.clickToRemove')}` : ''}
            </Typography>

            <List dense disablePadding sx={{ maxHeight: 420, overflow: 'auto' }}>
              {studentsInSelectedGroup.map((s) => (
                <StudentListItem
                  key={s._id}
                  student={s}
                  onClick={() => handleRemoveStudentFromGroup(s._id)}
                />
              ))}
            </List>
          </>
        ) : (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {selectedCat ? t('groups.selectGroupPrompt') : t('groups.selectCategoryPrompt')}
          </Typography>
        )}
      </Paper>

      {/* === Right column: Student list === */}
      <Paper variant="outlined" sx={{ flex: 1, p: 2, minWidth: 260 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>{t('groups.studentsColumn')}</Typography>

        {selectedCat && (
          <Button
            size="small"
            variant="text"
            onClick={() => setShowUngrouped(!showUngrouped)}
            sx={{ mb: 1 }}
          >
            {showUngrouped ? t('groups.showGroupedStudents') : t('groups.showUngroupedStudents')}
          </Button>
        )}

        <TextField
          size="small"
          fullWidth
          placeholder={t('groups.searchStudents')}
          value={searchTerm}
          onChange={handleSearchChange}
          sx={{ mb: 1 }}
        />

        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mb: 0.5,
            display: 'block'
          }}>
          {studentListLabel} ({studentsToShow.length})
          {addStudentOnClick && studentsToShow.length > 0 ? ` — ${t('groups.clickToAdd')}` : ''}
        </Typography>

        <List dense disablePadding sx={{ maxHeight: 420, overflow: 'auto' }}>
          {studentsToShow.map((s) => (
            <StudentListItem
              key={s._id}
              student={s}
              onClick={
                addStudentOnClick
                  ? () => handleAddStudentToGroup(s._id)
                  : !showUngrouped && selectedCat
                    ? () => handleSetGroupFromStudent(s._id)
                    : undefined
              }
            />
          ))}
        </List>
      </Paper>

      {/* === Create category dialog === */}
      <Dialog open={createCatOpen} onClose={() => setCreateCatOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('groups.createCategory')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleCreateCategory();
          }}
        >
          <DialogContent sx={{ pt: '8px !important', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label={t('groups.categoryName')}
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              fullWidth
              autoFocus
            />
            <TextField
              label={t('groups.numberOfGroups')}
              type="number"
              value={newCatGroupCount}
              onChange={(e) => setNewCatGroupCount(Math.max(1, Number(e.target.value) || 1))}
              fullWidth
              slotProps={{
                htmlInput: { min: 1 }
              }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateCatOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={creating || !newCatName.trim()}>
              {creating ? t('common.loading') : t('common.create')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      {/* === CSV upload dialog === */}
      <Dialog open={uploadOpen} onClose={() => setUploadOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('groups.uploadCsv')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleUploadCsv();
          }}
        >
          <DialogContent sx={{ pt: '8px !important', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label={t('groups.categoryName')}
              value={uploadCatName}
              onChange={(e) => setUploadCatName(e.target.value)}
              fullWidth
              autoFocus
            />
            <Button variant="outlined" onClick={() => fileInputRef.current?.click()}>
              {t('groups.chooseFile')}
            </Button>
            <input type="file" accept=".csv" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} />
            <TextField
              label={t('groups.csvContent')}
              multiline
              rows={6}
              value={uploadCsvText}
              onChange={(e) => setUploadCsvText(e.target.value)}
              fullWidth
              placeholder={t('groups.csvExamplePlaceholder')}
            />
            {uploadResult && (
              <Alert severity="info">
                {t('groups.importSummary', {
                  groups: uploadResult.groups,
                  students: uploadResult.students,
                })}
                {uploadResult.notFound?.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      {t('groups.emailsNotFound')}: {uploadResult.notFound.join(', ')}
                    </Typography>
                  </Box>
                )}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setUploadOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={uploading || !uploadCatName.trim() || !uploadCsvText.trim()}>
              {uploading ? t('common.loading') : t('groups.importBtn')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
