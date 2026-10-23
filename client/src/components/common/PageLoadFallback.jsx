import { Box, CircularProgress } from '@mui/material';

export default function PageLoadFallback() {
  return (
    <Box sx={{ minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <CircularProgress />
    </Box>
  );
}
