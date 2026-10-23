import { Box, ListItem } from '@mui/material';
import StudentIdentity from './StudentIdentity';

/**
 * Reusable component for showing a student in a list.
 *
 * Shows: name, email (greyed out second line), clickable avatar (opens full-size
 * profile image). Clicking the text area to the right of the avatar triggers `onClick`
 * if provided.
 *
 * @param {Object}   props
 * @param {Object}   props.student          – student user object ({ _id, profile, emails })
 * @param {Function} [props.onClick]        – called when the row (not avatar) is clicked
 * @param {React.ReactNode} [props.action]  – optional trailing action (e.g. icon button)
 * @param {Object}   [props.sx]            – extra sx passed to outer ListItem
 */
export default function StudentListItem({ student, onClick, action, sx }) {
  return (
    <ListItem
      sx={{
        pr: action ? 8 : undefined,
        ...sx,
      }}
      secondaryAction={action}
    >
      <Box sx={{ width: '100%' }}>
        <StudentIdentity student={student} onClick={onClick} />
      </Box>
    </ListItem>
  );
}
