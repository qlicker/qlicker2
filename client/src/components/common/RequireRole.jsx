import { useAuth } from '../../contexts/AuthContext';
import { Typography, Box } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function RequireRole({
  role,
  children,
  allowAdmin = true,
  allowInstructorCourses = role === 'professor',
  allowStudentCourses = role === 'student',
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const roles = user?.profile?.roles || [];
  const hasRole = role === 'professor'
    ? roles.includes('professor') || (allowInstructorCourses && !!user?.hasInstructorCourses)
    : role === 'student'
      ? roles.includes('student') || (allowStudentCourses && !!user?.hasStudentCourses)
      : roles.includes(role);
  const hasAdmin = roles.includes('admin');

  if (!hasRole && !(allowAdmin && hasAdmin)) {
    return (
      <Box
        sx={{
          p: 4,
          textAlign: "center"
        }}>
        <Typography variant="h5" color="error">{t('accessDenied.title')}</Typography>
        <Typography>{t('accessDenied.message')}</Typography>
      </Box>
    );
  }

  return children;
}
