import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function updateNotesMarkup(notes) {
  // Release text is remote, untrusted content. Keep formatting, without any resource loads or navigation.
  return DOMPurify.sanitize(marked.parse(String(notes || '').slice(0, 20000), { async: false }), {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
  });
}
