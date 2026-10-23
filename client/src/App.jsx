import { Suspense, lazy, useEffect } from 'react';
import {
  BrowserRouter, Routes, Route, Navigate, useLocation,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ThemeProvider, CssBaseline } from '@mui/material';
import theme from './theme/index';
import { AuthProvider } from './contexts/AuthContext';
import RequireAuth from './components/common/RequireAuth';
import RequireRole from './components/common/RequireRole';
import AppLayout from './components/layout/AppLayout';
import Home from './pages/Home';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import SSOCallback from './pages/SSOCallback';
import PageLoadFallback from './components/common/PageLoadFallback';

const Profile = lazy(() => import('./pages/Profile'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const ProfDashboard = lazy(() => import('./pages/professor/ProfDashboard'));
const ProfCourseDetail = lazy(() => import('./pages/professor/CourseDetail'));
const SessionEditor = lazy(() => import('./pages/professor/SessionEditor'));
const ProfLiveSession = lazy(() => import('./pages/professor/LiveSession'));
const PresentationWindow = lazy(() => import('./pages/professor/SecondDesktop'));
const ProfSessionReview = lazy(() => import('./pages/professor/SessionReview'));
const StudentDashboard = lazy(() => import('./pages/student/StudentDashboard'));
const StudentCourseDetail = lazy(() => import('./pages/student/CourseDetail'));
const StudentPracticeSessionEditor = lazy(() => import('./pages/student/PracticeSessionEditor'));
const SessionReview = lazy(() => import('./pages/student/SessionReview'));
const StudentLiveSession = lazy(() => import('./pages/student/LiveSession'));
const StudentQuizSession = lazy(() => import('./pages/student/QuizSession'));
const JitsiWindow = lazy(() => import('./pages/JitsiWindow'));
const UserManual = lazy(() => import('./pages/manuals/UserManual'));

function RouteAccessibility() {
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    const routes = [
      [/^\/$/, t('pageTitles.home')],
      [/^\/login$/, t('pageTitles.login')],
      [/^\/sso-callback$/, t('pageTitles.signingIn')],
      [/^\/reset\/[^/]+$/, t('pageTitles.resetPassword')],
      [/^\/verify-email\/[^/]+$/, t('pageTitles.verifyEmail')],
      [/^\/profile$/, t('pageTitles.profile')],
      [/^\/admin$/, t('pageTitles.adminDashboard')],
      [/^\/prof$/, t('pageTitles.professorDashboard')],
      [/^\/prof\/course\/[^/]+$/, t('pageTitles.courseDetails')],
      [/^\/prof\/course\/[^/]+\/session\/[^/]+$/, t('pageTitles.sessionEditor')],
      [/^\/prof\/course\/[^/]+\/session\/[^/]+\/live$/, t('pageTitles.liveSession')],
      [/^\/prof\/course\/[^/]+\/session\/[^/]+\/review$/, t('pageTitles.sessionReview')],
      [/^\/prof\/course\/[^/]+\/session\/[^/]+\/present$/, t('pageTitles.presentationView')],
      [/^\/student$/, t('pageTitles.studentDashboard')],
      [/^\/student\/course\/[^/]+$/, t('pageTitles.course')],
      [/^\/student\/course\/[^/]+\/practice-sessions\/new$/, t('pageTitles.sessionEditor')],
      [/^\/student\/course\/[^/]+\/practice-sessions\/[^/]+$/, t('pageTitles.sessionEditor')],
      [/^\/student\/course\/[^/]+\/session\/[^/]+\/review$/, t('pageTitles.sessionReview')],
      [/^\/student\/course\/[^/]+\/session\/[^/]+\/live$/, t('pageTitles.liveSession')],
      [/^\/student\/course\/[^/]+\/session\/[^/]+\/quiz$/, t('pageTitles.quiz')],
      [/^\/manual\/admin$/, t('pageTitles.adminManual')],
      [/^\/manual\/professor$/, t('pageTitles.professorManual')],
      [/^\/manual\/student$/, t('pageTitles.studentManual')],
      [/^\/manual$/, t('pageTitles.userManual')],
    ];

    const appName = t('common.appName');
    const match = routes.find(([pattern]) => pattern.test(location.pathname));
    document.title = match ? `${match[1]} | ${appName}` : appName;

    const rafId = window.requestAnimationFrame(() => {
      const mainContent = document.getElementById('main-content');
      if (mainContent) return;

      const heading = document.querySelector('h1, h2, [role="heading"]');
      if (!(heading instanceof HTMLElement)) return;
      const hadTabIndex = heading.hasAttribute('tabindex');
      if (!hadTabIndex) heading.setAttribute('tabindex', '-1');
      heading.focus();
      if (!hadTabIndex) {
        heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [location.pathname, t]);

  return null;
}

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <RouteAccessibility />
          <Suspense fallback={<PageLoadFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/sso-callback" element={<SSOCallback />} />
              <Route path="/reset/:token" element={<ResetPassword />} />
              <Route path="/verify-email/:token" element={<VerifyEmail />} />
              {/* Presentation window route outside AppLayout (no appbar/avatar) */}
              <Route element={<RequireAuth />}>
                <Route path="/prof/course/:courseId/session/:sessionId/present" element={<RequireRole role="professor" allowInstructorCourses><PresentationWindow /></RequireRole>} />
                <Route path="/video/:courseId" element={<JitsiWindow />} />
                <Route path="/video/:courseId/category/:catNum/group/:groupIdx" element={<JitsiWindow />} />
              </Route>
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route path="/profile" element={<Profile />} />
                <Route path="/admin" element={<RequireRole role="admin"><AdminDashboard /></RequireRole>} />
                <Route path="/prof" element={<RequireRole role="professor" allowInstructorCourses={false}><ProfDashboard /></RequireRole>} />
                <Route path="/prof/course/:id" element={<RequireRole role="professor" allowInstructorCourses><ProfCourseDetail /></RequireRole>} />
                <Route path="/prof/course/:courseId/session/:sessionId" element={<RequireRole role="professor" allowInstructorCourses><SessionEditor /></RequireRole>} />
                <Route path="/prof/course/:courseId/session/:sessionId/live" element={<RequireRole role="professor" allowInstructorCourses><ProfLiveSession /></RequireRole>} />
                <Route path="/prof/course/:courseId/session/:sessionId/review" element={<RequireRole role="professor" allowInstructorCourses><ProfSessionReview /></RequireRole>} />
                <Route path="/student" element={<RequireRole role="student" allowAdmin={false}><StudentDashboard /></RequireRole>} />
                <Route path="/student/course/:id" element={<RequireRole role="student" allowAdmin={false}><StudentCourseDetail /></RequireRole>} />
                <Route path="/student/course/:courseId/practice-sessions/new" element={<RequireRole role="student" allowAdmin={false}><StudentPracticeSessionEditor /></RequireRole>} />
                <Route path="/student/course/:courseId/practice-sessions/:sessionId" element={<RequireRole role="student" allowAdmin={false}><StudentPracticeSessionEditor /></RequireRole>} />
                <Route path="/activity/:courseId/session/:sessionId/review" element={<SessionReview />} />
                <Route path="/activity/:courseId/session/:sessionId/live" element={<StudentLiveSession />} />
                <Route path="/activity/:courseId/session/:sessionId/quiz" element={<StudentQuizSession />} />
                <Route path="/student/course/:courseId/session/:sessionId/review" element={<RequireRole role="student" allowAdmin={false}><SessionReview /></RequireRole>} />
                <Route path="/student/course/:courseId/session/:sessionId/live" element={<RequireRole role="student" allowAdmin={false}><StudentLiveSession /></RequireRole>} />
                <Route path="/student/course/:courseId/session/:sessionId/quiz" element={<RequireRole role="student" allowAdmin={false}><StudentQuizSession /></RequireRole>} />
                <Route path="/manual" element={<UserManual />} />
                <Route path="/manual/:role" element={<UserManual />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
