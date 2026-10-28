// Copy/cut/paste stay native so rich clipboard data and the existing sanitizing/import path are preserved.
export function handleEditorShortcut(editor, event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || editor.view.composing
    || !editor.isEditable || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.target.closest('input, textarea, select, button, [contenteditable="false"]')) return false;
  const key = event.key.toLowerCase();
  const command = key === 'z' ? (event.shiftKey ? 'redo' : 'undo')
    : !event.shiftKey && key === 'y' ? 'redo' : !event.shiftKey && key === 'a' ? 'selectAll' : null;
  if (!command) return false;
  // Even with an empty editor history, do not fall through to the browser's separate DOM undo stack.
  event.preventDefault(); event.stopImmediatePropagation();
  editor.commands[command]();
  return true;
}

export function shortcutHelp() {
  const help = document.createElement('details'); help.className = 'editor-shortcuts';
  help.innerHTML = `<summary>快捷键</summary><div role="note"><strong>光标放在正文中使用</strong>
    <span>撤销 <kbd>Ctrl+Z</kbd></span><span>重做 <kbd>Ctrl+Y</kbd> / <kbd>Ctrl+Shift+Z</kbd></span>
    <span>全选正文 <kbd>Ctrl+A</kbd></span><span>复制 <kbd>Ctrl+C</kbd></span>
    <span>粘贴 <kbd>Ctrl+V</kbd></span><span>剪切 <kbd>Ctrl+X</kbd></span>
    <small>标题、搜索框等输入区的快捷键只作用于当前输入区。</small></div>`;
  help.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); help.open = false; help.querySelector('summary').focus(); } });
  return help;
}
