import { useState } from 'react';
import { Link as RouterLink, Navigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import {
  canAccessManualRole,
  getAvailableManualRoles,
  getManualDashboardPath,
  getManualPath,
  getPreferredManualRole,
  USER_MANUAL_ROLES,
} from '../../utils/userManuals';

const MANUAL_SCROLL_MARGIN_TOP = 96;
const MANUAL_SIDEBAR_STICKY_TOP = 24;

function ManualScreenshot({ screenshot, figureId }) {
  if (screenshot?.imageSrc) {
    return (
      <Box component="figure" sx={{ m: 0 }} aria-labelledby={`${figureId}-title`}>
        <Paper variant="outlined" sx={{ overflow: 'hidden', bgcolor: 'background.paper' }}>
          <Box
            component="img"
            src={screenshot.imageSrc}
            alt={screenshot.alt || screenshot.title}
            sx={{
              display: 'block',
              width: '100%',
              height: 'auto',
            }}
          />
        </Paper>
        <Typography id={`${figureId}-title`} component="figcaption" variant="subtitle2" sx={{ mt: 1.5, fontWeight: 700 }}>
          {screenshot.title}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mt: 0.5
          }}>
          {screenshot.description}
        </Typography>
      </Box>
    );
  }

  const tabs = Array.isArray(screenshot?.tabs) ? screenshot.tabs : [];
  const sidebarItems = Array.isArray(screenshot?.sidebarItems) ? screenshot.sidebarItems : [];
  const cards = Array.isArray(screenshot?.cards) ? screenshot.cards : [];
  const chips = Array.isArray(screenshot?.chips) ? screenshot.chips : [];

  return (
    <Box component="figure" sx={{ m: 0 }} aria-labelledby={`${figureId}-title`}>
      <Paper
        variant="outlined"
        sx={{
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            px: 2,
            py: 1.25,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'action.hover',
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              minWidth: 0
            }}>
            <Chip label={screenshot.windowBadge} size="small" color="primary" variant="outlined" />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>{screenshot.windowTitle}</Typography>
          </Stack>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              textAlign: 'right'
            }}>{screenshot.windowNote}</Typography>
        </Box>

        <Box sx={{ p: { xs: 1.5, md: 2 }, display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '200px minmax(0, 1fr)' } }}>
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1, fontWeight: 700 }}>
              {screenshot.sidebarTitle}
            </Typography>
            <Stack spacing={1}>
              {sidebarItems.map((item) => (
                <Box
                  key={item}
                  sx={{
                    px: 1.25,
                    py: 0.9,
                    bgcolor: 'action.hover',
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="body2">{item}</Typography>
                </Box>
              ))}
            </Stack>
          </Paper>

          <Stack spacing={1.5}>
            {!!tabs.length && (
              <Stack direction="row" spacing={1} useFlexGap sx={{
                flexWrap: "wrap"
              }}>
                {tabs.map((tab) => (
                  <Chip key={tab} label={tab} color="primary" variant="outlined" size="small" />
                ))}
              </Stack>
            )}
            {!!chips.length && (
              <Stack direction="row" spacing={1} useFlexGap sx={{
                flexWrap: "wrap"
              }}>
                {chips.map((chip) => (
                  <Chip key={chip} label={chip} size="small" variant="outlined" />
                ))}
              </Stack>
            )}
            <Stack spacing={1.5}>
              {cards.map((card) => (
                <Paper key={card.title} variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{card.title}</Typography>
                    {Array.isArray(card.lines) && card.lines.map((line) => (
                      <Typography key={line} variant="body2" sx={{
                        color: "text.secondary"
                      }}>{line}</Typography>
                    ))}
                    {Array.isArray(card.metrics) && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{
                        flexWrap: "wrap"
                      }}>
                        {card.metrics.map((metric) => (
                          <Chip key={metric} label={metric} size="small" color="secondary" variant="outlined" />
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </Stack>
        </Box>
      </Paper>
      <Typography id={`${figureId}-title`} component="figcaption" variant="subtitle2" sx={{ mt: 1.5, fontWeight: 700 }}>
        {screenshot.title}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mt: 0.5
        }}>
        {screenshot.description}
      </Typography>
    </Box>
  );
}

function getScreenshotPresets(screenshot, t, context = {}) {
  const base = {
    title: screenshot?.title,
    description: screenshot?.description,
  };

  switch (screenshot?.variant) {
    case 'adminOverview':
      return [{
        ...base,
        imageSrc: '/manuals/admin-dashboard.png',
        alt: screenshot.title,
      }];
    case 'adminStorage':
      return [{
        ...base,
        imageSrc: '/manuals/admin-storage.png',
        alt: screenshot.title,
      }];
    case 'professorCourse':
      return [{
        ...base,
        imageSrc: '/manuals/professor-course.png',
        alt: screenshot.title,
      }, {
        imageSrc: '/manuals/professor-notifications.png',
        title: t('notifications.manage.button'),
        description: t('notifications.manage.formHelp'),
      }];
    case 'professorSession':
      return [{
        ...base,
        imageSrc: '/manuals/session-editor.png',
        alt: screenshot.title,
      }];
    case 'studentCourse':
      return [{
        ...base,
        imageSrc: '/manuals/student-course.png',
        alt: screenshot.title,
      }];
    case 'studentReview':
      return [{
        ...base,
        imageSrc: '/manuals/student-review.png',
        alt: screenshot.title,
      }];
    default:
      break;
  }

  const supplementalImages = {
    admin: {
      3: [
        { imageSrc: '/manuals/admin-users.png' },
        { imageSrc: '/manuals/admin-notifications.png', titleKey: 'notifications.manage.button' },
      ],
      4: '/manuals/admin-system-monitoring.png',
    },
    professor: {
      1: '/manuals/professor-groups.png',
      4: '/manuals/professor-question-library.png',
      5: '/manuals/professor-live-session.png',
      6: [
        { imageSrc: '/manuals/professor-join-code.png', titleKey: 'professor.liveSession.joinPeriod' },
        { imageSrc: '/manuals/professor-session-admission.png', titleKey: 'professor.liveSession.admitStudent' },
      ],
      7: '/manuals/professor-grades.png',
      8: [
        { imageSrc: '/manuals/professor-course-chat.png', titleKey: 'courseChat.title' },
        { imageSrc: '/manuals/professor-session-chat.png', titleKey: 'sessionChat.chat' },
      ],
      9: [
        { imageSrc: '/manuals/professor-ai-settings.png', titleKey: 'professor.course.aiSettings' },
        { imageSrc: '/manuals/professor-ai-chat.png', titleKey: 'ai.chat.title' },
      ],
    },
    student: {
      1: '/manuals/student-live-session.png',
      4: '/manuals/student-practice-session.png',
      5: [
        { imageSrc: '/manuals/student-course-chat.png', titleKey: 'courseChat.title' },
        { imageSrc: '/manuals/student-session-chat.png', titleKey: 'sessionChat.chat' },
      ],
      6: [{ imageSrc: '/manuals/student-ai-chat.png', titleKey: 'ai.chat.title' }],
    },
  };
  const configuredImages = supplementalImages[context.manualRole]?.[context.index];
  if (!configuredImages) return [];

  return (Array.isArray(configuredImages) ? configuredImages : [configuredImages]).map((configuredImage) => {
    const image = typeof configuredImage === 'string' ? { imageSrc: configuredImage } : configuredImage;
    const title = image.titleKey ? t(image.titleKey) : context.section?.title || '';
    return {
      imageSrc: image.imageSrc,
      title,
      description: context.section?.subtitle || context.section?.paragraphs?.[0] || '',
      alt: title,
    };
  });
}

function Section({ section, index, manualRole, sectionId, t }) {
  const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
  const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
  const screenshots = getScreenshotPresets(section?.screenshot, t, { index, manualRole, section });

  return (
    <Paper
      component="section"
      id={sectionId}
      variant="outlined"
      sx={{
        p: { xs: 2, md: 3 },
        scrollMarginTop: MANUAL_SCROLL_MARGIN_TOP,
      }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5" component="h2" sx={{ fontWeight: 700 }}>
            {index + 1}. {section.title}
          </Typography>
          {section.subtitle ? (
            <Typography
              variant="body1"
              sx={{
                color: "text.secondary",
                mt: 0.75
              }}>
              {section.subtitle}
            </Typography>
          ) : null}
        </Box>

        {paragraphs.map((paragraph) => (
          <Typography key={paragraph} variant="body1">{paragraph}</Typography>
        ))}

        {!!bullets.length && (
          <Box component="ul" sx={{ m: 0, pl: 3, display: 'grid', gap: 1 }}>
            {bullets.map((bullet) => (
              <Typography component="li" key={bullet} variant="body1">
                {bullet}
              </Typography>
            ))}
          </Box>
        )}

        {section.note ? <Alert severity="info">{section.note}</Alert> : null}
        {section.warning ? <Alert severity="warning">{section.warning}</Alert> : null}
        {section.success ? <Alert severity="success">{section.success}</Alert> : null}

        {screenshots.map((screenshot, screenshotIndex) => (
          <ManualScreenshot
            key={screenshot.imageSrc || `${sectionId}-${screenshotIndex}`}
            screenshot={screenshot}
            figureId={`${sectionId}-figure-${screenshotIndex + 1}`}
          />
        ))}
      </Stack>
    </Paper>
  );
}

function ManualNavigation({ dashboardPath, t }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
        {t('manuals.shared.navigationTitle')}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{
        flexWrap: "wrap"
      }}>
        <Button component={RouterLink} to={dashboardPath} variant="contained">
          {t('manuals.shared.backToDashboard')}
        </Button>
        <Button component={RouterLink} to="/profile" variant="outlined">
          {t('manuals.shared.openProfile')}
        </Button>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mt: 1
        }}>
        {t('manuals.shared.navigationHint')}
      </Typography>
    </Box>
  );
}

function ManualContents({ sections, t, onNavigate }) {
  return (
    <Box component="nav" aria-label={t('manuals.shared.contentsTitle')}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.25 }}>
        {t('manuals.shared.contentsTitle')}
      </Typography>
      <Stack spacing={0.5}>
        {sections.map((section, index) => (
          <Button
            key={section.id}
            component="a"
            href={`#${section.id}`}
            variant="text"
            color="inherit"
            onClick={onNavigate}
            sx={{ justifyContent: 'flex-start', textAlign: 'left', lineHeight: 1.3 }}
          >
            {index + 1}. {section.title}
          </Button>
        ))}
        {!!sections.length && (
          <Button
            component="a"
            href="#manual-top"
            variant="text"
            color="inherit"
            onClick={onNavigate}
            sx={{ justifyContent: 'flex-start' }}
          >
            ↑ {t('manuals.shared.navigationTitle')}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

function RelatedManuals({ manualRole, relatedManualRoles, t, onNavigate }) {
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.25 }}>
        {t('manuals.shared.relatedManualsTitle')}
      </Typography>
      <Stack spacing={1}>
        {relatedManualRoles.map((role) => (
          <Tooltip
            key={role}
            title={t('manuals.shared.relatedManualTooltip', { role: t(`manuals.shared.roles.${role}`) })}
            arrow
          >
            <Button
              component={RouterLink}
              to={getManualPath(role)}
              variant={role === manualRole ? 'contained' : 'outlined'}
              fullWidth
              onClick={onNavigate}
              sx={{ justifyContent: 'flex-start' }}
            >
              {t(`manuals.shared.roles.${role}`)}
            </Button>
          </Tooltip>
        ))}
      </Stack>
    </Box>
  );
}

function ManualSidebar({
  dashboardPath,
  manual,
  manualRole,
  relatedManualRoles,
  sections,
  t,
}) {
  return (
    <Stack
      spacing={2}
      sx={{
        minWidth: 0,
        display: { xs: 'none', md: 'flex' },
        position: { md: 'sticky' },
        top: { md: MANUAL_SIDEBAR_STICKY_TOP },
        maxHeight: { md: `calc(100vh - ${MANUAL_SIDEBAR_STICKY_TOP * 2}px)` },
        overflowY: { md: 'auto' },
        pr: { md: 0.5 },
      }}
    >
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
        <ManualContents sections={sections} t={t} />
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
        <Stack spacing={2}>
          <Box>
            <Chip color="primary" variant="outlined" size="small" label={t(`manuals.shared.roles.${manualRole}`)} />
            <Typography variant="h6" sx={{ mt: 1.5, fontWeight: 700 }}>
              {t('manuals.shared.navigationTitle')}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mt: 0.75
              }}>
              {manual.summary}
            </Typography>
          </Box>
          <ManualNavigation dashboardPath={dashboardPath} t={t} />
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.25 }}>
          {t('manuals.shared.quickStartTitle')}
        </Typography>
        <Box component="ol" sx={{ m: 0, pl: 3, display: 'grid', gap: 1 }}>
          {(Array.isArray(manual.quickStart) ? manual.quickStart : []).map((step) => (
            <Typography component="li" key={step} variant="body2" sx={{
              color: "text.secondary"
            }}>
              {step}
            </Typography>
          ))}
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
        <RelatedManuals
          manualRole={manualRole}
          relatedManualRoles={relatedManualRoles}
          t={t}
        />
      </Paper>
    </Stack>
  );
}

function ManualTopNavigation({
  dashboardPath,
  manual,
  manualRole,
  relatedManualRoles,
  sections,
  t,
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <Paper
        id="manual-top"
        variant="outlined"
        sx={{
          position: 'sticky',
          top: 8,
          zIndex: 10,
          mb: 3,
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          bgcolor: 'background.paper',
          boxShadow: 2,
        }}
      >
        <Button
          variant="contained"
          startIcon={<MenuIcon />}
          onClick={() => setDrawerOpen(true)}
          aria-haspopup="dialog"
        >
          {t('manuals.shared.contentsTitle')}
        </Button>
        <Typography variant="body2" sx={{ fontWeight: 700, display: { xs: 'none', sm: 'block' } }} noWrap>
          {manual.title}
        </Typography>
        <Chip size="small" variant="outlined" label={t(`manuals.shared.roles.${manualRole}`)} />
      </Paper>

      <Drawer anchor="left" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Box sx={{ width: { xs: 300, sm: 380 }, maxWidth: '90vw', p: 2.5 }}>
          <Stack spacing={2.5}>
            <Box>
              <Chip color="primary" variant="outlined" size="small" label={t(`manuals.shared.roles.${manualRole}`)} />
              <Typography variant="h6" sx={{ mt: 1.5, fontWeight: 700 }}>{manual.title}</Typography>
            </Box>
            <ManualContents sections={sections} t={t} onNavigate={() => setDrawerOpen(false)} />
            <Divider />
            <ManualNavigation dashboardPath={dashboardPath} t={t} />
            <RelatedManuals
              manualRole={manualRole}
              relatedManualRoles={relatedManualRoles}
              t={t}
              onNavigate={() => setDrawerOpen(false)}
            />
          </Stack>
        </Box>
      </Drawer>
    </>
  );
}

export default function UserManual() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { role: requestedRole } = useParams();
  const roles = user?.profile?.roles || [];
  const preferredRole = getPreferredManualRole(roles, user?.hasInstructorCourses);
  const manualRole = USER_MANUAL_ROLES.includes(requestedRole) ? requestedRole : preferredRole;
  const dashboardPath = getManualDashboardPath(roles, user?.hasInstructorCourses);

  if (!USER_MANUAL_ROLES.includes(requestedRole || '')) {
    return <Navigate to={getManualPath(manualRole)} replace />;
  }

  const availableRoles = getAvailableManualRoles(roles, user?.hasInstructorCourses);
  const canAccess = canAccessManualRole(roles, manualRole, user?.hasInstructorCourses);
  const value = t(`manuals.${manualRole}`, { returnObjects: true });
  const manual = value && typeof value === 'object' ? value : {};

  if (!canAccess) {
    return (
      <Box sx={{ p: 3, maxWidth: 860, mx: 'auto' }}>
        <Paper variant="outlined" sx={{ p: { xs: 2.5, md: 3 } }}>
          <Stack spacing={2}>
            <Typography variant="h4">{t('accessDenied.title')}</Typography>
            <Alert severity="warning">{t('manuals.shared.accessDenied', { manual: t(`manuals.shared.roles.${manualRole}`) })}</Alert>
            <ManualNavigation dashboardPath={dashboardPath} t={t} />
            {!!availableRoles.length && (
              <Stack direction="row" spacing={1} useFlexGap sx={{
                flexWrap: "wrap"
              }}>
                {availableRoles.map((role) => (
                  <Button key={role} component={RouterLink} to={getManualPath(role)} variant="outlined">
                    {t(`manuals.shared.openManualForRole`, { role: t(`manuals.shared.roles.${role}`) })}
                  </Button>
                ))}
              </Stack>
            )}
          </Stack>
        </Paper>
      </Box>
    );
  }

  const roleColors = {
    admin: 'error',
    professor: 'primary',
    student: 'success',
  };
  const roleColor = roleColors[manualRole] || 'primary';
  const sections = Array.isArray(manual.sections) ? manual.sections : [];
  const sectionEntries = sections.map((section, index) => ({ ...section, id: `manual-section-${index + 1}` }));
  const relatedManualRoles = availableRoles;

  return (
    <Box sx={{ p: { xs: 1, sm: 2, md: 3 }, maxWidth: 1320, mx: 'auto' }}>
      <ManualTopNavigation
        dashboardPath={dashboardPath}
        manual={manual}
        manualRole={manualRole}
        relatedManualRoles={relatedManualRoles}
        sections={sectionEntries}
        t={t}
      />
      <Box
        sx={{
          display: 'grid',
          gap: 3,
          alignItems: 'start',
          gridTemplateColumns: { xs: '1fr', md: '300px minmax(0, 1fr)' },
        }}
      >
        <ManualSidebar
          dashboardPath={dashboardPath}
          manual={manual}
          manualRole={manualRole}
          relatedManualRoles={relatedManualRoles}
          sections={sectionEntries}
          t={t}
        />

        <Stack spacing={2.5}>
          <Paper variant="outlined" sx={{ p: { xs: 2.5, md: 3 } }}>
            <Stack spacing={2.5}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{
                  alignItems: { xs: 'flex-start', sm: 'center' },
                  justifyContent: "space-between"
                }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h4" component="h1" gutterBottom>{manual.title}</Typography>
                  <Typography variant="body1" sx={{
                    color: "text.secondary"
                  }}>
                    {manual.intro}
                  </Typography>
                </Box>
                <Chip color={roleColor} label={t(`manuals.shared.roles.${manualRole}`)} />
              </Stack>

              <Alert severity="info">{manual.summary}</Alert>

              <Divider />

              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('manuals.shared.navigationHint')}
              </Typography>
            </Stack>
          </Paper>

          <Stack spacing={2.5}>
            {sectionEntries.map((section, index) => (
              <Section
                key={section.title}
                section={section}
                index={index}
                manualRole={manualRole}
                sectionId={section.id}
                t={t}
              />
            ))}
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
