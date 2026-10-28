import { marked } from 'marked';

const escape = text => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
const branch = /^[ \t│┃|]*(?:[├└][─━]+|[+`\\|]-{2,})[ \t]*\S/;
const trunk = /^[ \t│┃|]*$/;
const rootLine = /(?:[/\\]|^\s*\.|^[A-Za-z]:[/\\].*)\s*$/;
const preformatted = element => ['pre', 'pre-wrap', 'break-spaces'].includes(element.style?.whiteSpace);

export function textCodePaste(text) {
  if (!text || text.length > 1024 * 1024) return null;
  const source = text.replace(/\r\n?/g, '\n');
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(source)) {
    const tokens = marked.lexer(source);
    if (tokens.some(token => token.type === 'code' && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw))) return marked.parser(tokens);
  }
  const lines = source.split('\n'), parts = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!branch.test(lines[i])) continue;
    const start = i > cursor && rootLine.test(lines[i - 1]) ? i - 1 : i;
    let end = i, branches = 0;
    while (end < lines.length && (branch.test(lines[end]) || trunk.test(lines[end]))) {
      if (branch.test(lines[end])) branches++;
      end++;
    }
    if (branches < 2) { i = end - 1; continue; }
    parts.push(lines.slice(cursor, start).map(line => `<p>${escape(line)}</p>`).join(''));
    parts.push(`<pre><code>${escape(lines.slice(start, end).join('\n'))}</code></pre>`);
    cursor = end; i = end - 1;
  }
  if (!parts.length) return null;
  parts.push(lines.slice(cursor).map(line => `<p>${escape(line)}</p>`).join(''));
  return parts.join('');
}

export function clipboardCodePaste(text, html) {
  if (html) {
    const template = document.createElement('template'); template.innerHTML = html;
    // Structured rich text keeps its original route; plain wrappers may accompany copied trees.
    if (template.content.querySelector('pre,code,table,ul,ol,blockquote,h1,h2,h3,h4,h5,h6,strong,b,em,i,a,img,video,figure,aside')
      || [...template.content.querySelectorAll('[style]')].some(preformatted)) return null;
  }
  return textCodePaste(text);
}

function codeText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1 || node.matches('script,style,button,input,select,textarea,svg')) return '';
  if (node.tagName === 'BR') return '\n';
  let result = '';
  for (const child of node.childNodes) {
    const block = child.nodeType === 1 && child.matches('div,p,li');
    if (block && result && !result.endsWith('\n')) result += '\n';
    result += codeText(child);
    if (block && child.nextSibling && !result.endsWith('\n')) result += '\n';
  }
  return result;
}

export function normalizePastedCode(html) {
  const template = document.createElement('template'); template.innerHTML = html;
  for (const element of template.content.querySelectorAll('pre,code,[style]')) {
    if (!template.content.contains(element) || element.parentElement?.closest('pre,[data-ss-block]')) continue;
    const isPre = element.tagName === 'PRE';
    const isCode = element.tagName === 'CODE' && (element.textContent.includes('\n') || element.querySelector('br'));
    if (!isPre && !isCode && !preformatted(element)) continue;
    if (!isPre && element.querySelector('pre')) continue;
    const pre = document.createElement('pre'), code = document.createElement('code');
    const language = [...(element.querySelector('code') || element).classList].find(name => /^language-[\w+#.-]{1,40}$/.test(name));
    if (language) code.className = language;
    code.textContent = codeText(element); pre.append(code); element.replaceWith(pre);
  }
  return template.innerHTML;
}
