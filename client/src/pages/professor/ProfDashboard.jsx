import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import {
  Box, Typography, Button, TextField, Card, CardContent,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, Snackbar,
  CircularProgress, Chip, InputAdornment, Select, MenuItem, Autocomplete,
  FormControl, InputLabel,
} from '@mui/material';
import {
  Add as AddIcon, Search as SearchIcon, ContentCopy as CopyIcon,
  School as SchoolIcon, PlayCircle as LiveIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import {
  SEMESTER_OPTIONS,
  formatSemester,
  getYearOptions,
} from '../../utils/courseSemester';
import { buildCourseTitle } from '../../utils/courseTitle';
import { fetchAllCourses } from '../../utils/fetchAllCourses';
import { sortCoursesByRecentActivity } from '../../utils/courseSorting';
import { isRequestCanceled } from '../../utils/requestCancellation';
import SessionListCard from '../../components/common/SessionListCard';
import JoinActivityButton from '../../components/common/JoinActivityButton';

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': {
    px: 1.15,
  },
};

const INACTIVE_COURSE_ERROR_CODE = 'COURSE_INACTIVE';

const LIVE_SESSION_GRID_SX = {
  display: 'grid',
  gap: 1.25,
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
};

const COURSE_GRID_SX = {
  display: 'grid',
  gap: 2,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
};

function getSuggestedSemester() {
  const now = new Date();
  const month = now.getMonth(); // 0-indexed
  const year = now.getFullYear();
  if (month >= 10 || month <= 1) {
    // November-February → Winter
    return { season: 'Winter', year: String(month >= 10 ? year + 1 : year) };
  }
  if (month <= 6) {
    // March-July → Summer
    return { season: 'Summer', year: String(year) };
  }
  // August-October → Fall
  return { season: 'Fall', year: String(year) };
}

export default function ProfDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, loadUser } = useAuth();
  const [courses, setCourses] = useState([]);
  const [studentCourses, setStudentCourses] = useState([]);
  const [liveSessions, setLiveSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState(null);

  // Create course dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const suggested = getSuggestedSemester();
  const yearOptions = getYearOptions();
  const [newCourse, setNewCourse] = useState({
    name: '', deptCode: '', courseNumber: '', section: '', season: suggested.season, year: suggested.year,
  });

  const isInactiveCourseEnrollError = useCallback((error) => {
    const response = error?.response;
    const payload = response?.data || {};
    if (payload.code === INACTIVE_COURSE_ERROR_CODE) return true;
    if (response?.status !== 403) return false;
    return String(payload.message || '').toLowerCase().includes('inactive');
  }, []);

  const fetchCourses = useCallback(async ({ signal } = {}) => {
    setLoading(true);
    try {
      const [coursesRes, studentCoursesRes, liveRes] = await Promise.all([
        fetchAllCourses(apiClient, { view: 'instructor' }, { signal }),
        fetchAllCourses(apiClient, { view: 'student' }, { signal }).catch((err) => {
          if (isRequestCanceled(err)) throw err;
          return [];
        }),
        apiClient.get('/sessions/live', { params: { view: 'instructor' }, signal }).catch((err) => {
          if (isRequestCanceled(err)) throw err;
          return { data: { liveSessions: [] } };
        }),
      ]);
      setCourses(coursesRes);
      setStudentCourses(studentCoursesRes);
      setLiveSessions(liveRes.data.liveSessions || []);
    } catch (err) {
      if (isRequestCanceled(err)) return;
      setMsg({ severity: 'error', text: t('professor.dashboard.failedLoadCourses') });
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    fetchCourses({ signal: controller.signal });
    return () => controller.abort();
  }, [fetchCourses]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const { season, year, ...rest } = newCourse;
      const semester = formatSemester(season, year);
      if (!semester) {
        setMsg({ severity: 'error', text: t('professor.dashboard.semesterYearRequired', 'Semester and year are required.') });
        return;
      }
      await apiClient.post('/courses', { ...rest, semester });
      setCreateOpen(false);
      const s = getSuggestedSemester();
      setNewCourse({ name: '', deptCode: '', courseNumber: '', section: '', season: s.season, year: s.year });
      fetchCourses();
      setMsg({ severity: 'success', text: t('professor.dashboard.courseCreated') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.dashboard.failedCreateCourse') });
    } finally {
      setCreating(false);
    }
  };

  const handleEnroll = async () => {
    if (!enrollCode.trim()) return;
    if (/^S-/i.test(enrollCode.trim())) {
      setMsg({ severity: 'error', text: t('student.dashboard.activityCodeUseJoin') });
      return;
    }
    setEnrolling(true);
    try {
      await apiClient.post('/courses/enroll', { enrollmentCode: enrollCode.trim() });
      setEnrollOpen(false);
      setEnrollCode('');
      await Promise.all([fetchCourses(), loadUser()]);
      setMsg({ severity: 'success', text: t('professor.dashboard.enrollSuccessAsStudent') });
    } catch (err) {
      if (isInactiveCourseEnrollError(err)) {
        setEnrollOpen(false);
        setEnrollCode('');
        setMsg({
          severity: 'warning',
          text: t('student.dashboard.inactiveCourseCannotEnroll'),
        });
      } else {
        setMsg({
          severity: 'error',
          text: err.response?.data?.message || t('professor.dashboard.failedEnrollAsStudent'),
        });
      }
    } finally {
      setEnrolling(false);
    }
  };

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    setMsg({ severity: 'success', text: t('professor.dashboard.enrollmentCodeCopied') });
  };

  const canCreateCourses = user?.profile?.roles?.includes('professor') || user?.profile?.roles?.includes('admin');

  const studentCourseIds = useMemo(
    () => new Set(studentCourses.map((course) => String(course._id))),
    [studentCourses]
  );
  const instructorCourseIds = useMemo(
    () => new Set(courses.map((course) => String(course._id))),
    [courses]
  );
  const mergedCourses = useMemo(() => {
    const byId = new Map();
    courses.forEach((course) => {
      byId.set(String(course._id), course);
    });
    studentCourses.forEach((course) => {
      if (!byId.has(String(course._id))) {
        byId.set(String(course._id), course);
      }
    });
    return Array.from(byId.values());
  }, [courses, studentCourses]);
  const filtered = sortCoursesByRecentActivity(mergedCourses.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const searchable = [
      buildCourseTitle(c, 'short'),
      buildCourseTitle(c, 'medium'),
      buildCourseTitle(c, 'long'),
      c.section,
    ]
      .map((entry) => String(entry || '').trim())
      .join(' ')
      .toLowerCase();
    return searchable.includes(q);
  }));

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Typography variant="h4">{t('professor.dashboard.myCourses')}</Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" startIcon={<SchoolIcon />} onClick={() => setEnrollOpen(true)}>
            {t('professor.dashboard.enrollInCourseAsStudent')}
          </Button>
          <JoinActivityButton />
          {canCreateCourses ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              {t('professor.dashboard.createCourse')}
            </Button>
          ) : null}
        </Box>
      </Box>

      <TextField
        size="small"
        placeholder={t('professor.dashboard.searchCourses')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> } }}
        sx={{ mb: 3, minWidth: 300 }}
      />

      {liveSessions.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            <LiveIcon sx={{ verticalAlign: 'middle', mr: 0.5, color: 'success.main' }} />
            {t('dashboard.liveSessions')}
          </Typography>
          <Box sx={LIVE_SESSION_GRID_SX}>
            {liveSessions.map((ls) => (
              <SessionListCard
                key={ls._id}
                highlighted
                onClick={() => navigate(
                  ls.quiz || ls.practiceQuiz
                    ? `/prof/course/${ls.courseId}/session/${ls._id}/review`
                    : `/prof/course/${ls.courseId}/session/${ls._id}/live`
                )}
                title={ls.name}
                subtitle={ls.courseName}
              />
            ))}
          </Box>
        </Box>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : filtered.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <SchoolIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" sx={{
            color: "text.secondary"
          }}>
            {search ? t('professor.dashboard.noCoursesMatch') : t('professor.dashboard.noCoursesYet')}
          </Typography>
          {!search && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2
              }}>
              {t('professor.dashboard.createFirstCourse')}
            </Typography>
          )}
        </Box>
      ) : (
        <Box sx={{ mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
            {t('dashboard.courses')}
          </Typography>
          <Box sx={COURSE_GRID_SX}>
            {filtered.map((course) => (
              <Box key={course._id}>
                <Card
                  variant="outlined"
                  sx={{ height: '100%', display: 'flex', flexDirection: 'column', cursor: 'pointer', '&:hover': { boxShadow: 3 } }}
                  onClick={() => navigate(
                    instructorCourseIds.has(String(course._id))
                      ? `/prof/course/${course._id}`
                      : `/student/course/${course._id}`
                  )}
                >
                  <CardContent sx={{ flexGrow: 1, minHeight: 160 }}>
                    <Typography variant="h6" sx={{ fontWeight: 700 }} noWrap>
                      {buildCourseTitle(course, 'short')}
                    </Typography>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      {course.semester}
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {buildCourseTitle(course, 'medium')}
                    </Typography>
                    {course.section && (
                      <Typography
                        variant="body2"
                        sx={{
                          color: "text.secondary",
                          mt: 0.5
                        }}>
                        {t('professor.dashboard.section', { section: course.section })}
                      </Typography>
                    )}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
                      <Chip
                        label={course.inactive ? t('professor.dashboard.inactive') : t('professor.dashboard.active')}
                        color={course.inactive ? 'default' : 'success'}
                        size="small"
                        sx={COMPACT_CHIP_SX}
                      />
                      {studentCourseIds.has(String(course._id)) ? (
                        <Chip
                          label={t('professor.dashboard.enrolledAsStudent')}
                          color="info"
                          size="small"
                          sx={COMPACT_CHIP_SX}
                        />
                      ) : null}
                    </Box>
                    {course.enrollmentCode && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>{t('professor.dashboard.code')}</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                          {course.enrollmentCode}
                        </Typography>
                        <CopyIcon
                          fontSize="small"
                          sx={{ cursor: 'pointer', color: 'action.active', '&:hover': { color: 'primary.main' } }}
                          onClick={(e) => { e.stopPropagation(); copyCode(course.enrollmentCode); }}
                        />
                      </Box>
                    )}
                  </CardContent>
                </Card>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Create Course Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('professor.dashboard.createCourse')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleCreate();
          }}
        >
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
            <TextField label={t('professor.dashboard.courseName')} placeholder={t('professor.dashboard.courseNamePlaceholder')} required value={newCourse.name} onChange={(e) => setNewCourse((s) => ({ ...s, name: e.target.value }))} />
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField label={t('professor.dashboard.deptCode')} placeholder={t('professor.dashboard.deptCodePlaceholder')} value={newCourse.deptCode} onChange={(e) => setNewCourse((s) => ({ ...s, deptCode: e.target.value }))} sx={{ flex: 1 }} />
              <TextField label={t('professor.dashboard.courseNumber')} placeholder={t('professor.dashboard.courseNumberPlaceholder')} value={newCourse.courseNumber} onChange={(e) => setNewCourse((s) => ({ ...s, courseNumber: e.target.value }))} sx={{ flex: 1 }} />
            </Box>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField label={t('professor.dashboard.sectionLabel')} placeholder={t('professor.dashboard.sectionPlaceholder')} value={newCourse.section} onChange={(e) => setNewCourse((s) => ({ ...s, section: e.target.value }))} sx={{ flex: 1 }} />
              <FormControl sx={{ flex: 1 }}>
                <InputLabel>{t('professor.dashboard.semester')}</InputLabel>
                <Select
                  label={t('professor.dashboard.semester')}
                  value={newCourse.season}
                  onChange={(e) => setNewCourse((s) => ({ ...s, season: e.target.value }))}
                >
                  {SEMESTER_OPTIONS.map((option) => (
                    <MenuItem key={option} value={option}>{option}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Autocomplete
                freeSolo
                options={yearOptions}
                value={newCourse.year}
                onChange={(_, value) => {
                  setNewCourse((s) => ({ ...s, year: String(value || '').trim() }));
                }}
                onInputChange={(_, value) => {
                  setNewCourse((s) => ({ ...s, year: value }));
                }}
                sx={{ flex: 1 }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={t('professor.dashboard.year')}
                    placeholder={t('professor.dashboard.yearPlaceholder')}
                    helperText={t('professor.dashboard.yearHelp')}
                  />
                )}
              />
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={creating || !newCourse.name || !newCourse.season || !newCourse.year}>
              {creating ? t('professor.dashboard.creating') : t('common.create')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={enrollOpen} onClose={() => setEnrollOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('professor.dashboard.enrollInCourseAsStudent')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleEnroll();
          }}
        >
          <DialogContent sx={{ pt: '8px !important' }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2
              }}>
              {t('student.dashboard.enrollmentCodeMessage')}
            </Typography>
            <TextField
              label={t('student.dashboard.enrollmentCode')}
              value={enrollCode}
              onChange={(event) => setEnrollCode(event.target.value)}
              fullWidth
              autoFocus
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setEnrollOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={enrolling || !enrollCode.trim()}>
              {enrolling ? t('student.dashboard.enrolling') : t('student.dashboard.enroll')}
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
