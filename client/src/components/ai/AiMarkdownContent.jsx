import { Box } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

function normalizeMarkdownMath(value) {
  return String(value || '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$\n${math.trim()}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`)
    .replace(/(^|\s)\(\s*([^\n]+?)\s*\((?=\s|$)/g, (_, prefix, math) => `${prefix}$${math.trim()}$`);
}

const markdownSx = {
  overflowWrap: 'anywhere',
  '& > :first-of-type': { mt: 0 },
  '& > :last-child': { mb: 0 },
  '& p, & ul, & ol, & blockquote, & pre, & table': { my: 0.75 },
  '& ul, & ol': { pl: 3 },
  '& blockquote': { borderLeft: 3, borderColor: 'divider', pl: 1.25, ml: 0, color: 'text.secondary' },
  '& pre': { overflowX: 'auto', p: 1, borderRadius: 1, bgcolor: 'action.hover' },
  '& code': { fontFamily: 'monospace', fontSize: '0.9em' },
  '& :not(pre) > code': { px: 0.4, py: 0.15, borderRadius: 0.5, bgcolor: 'action.hover' },
  '& table': { borderCollapse: 'collapse', maxWidth: '100%' },
  '& th, & td': { border: 1, borderColor: 'divider', p: 0.6, textAlign: 'left' },
  '& img': { display: 'block', maxWidth: '100%', height: 'auto', my: 1, borderRadius: 1 },
};

export default function AiMarkdownContent({ content }) {
  return <Box sx={markdownSx}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalizeMarkdownMath(content)}
    </ReactMarkdown>
  </Box>;
}
