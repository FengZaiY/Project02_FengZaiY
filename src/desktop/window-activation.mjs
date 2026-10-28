export function activateDesktopWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  // Windows can keep a running instance hidden when its launcher used SW_HIDE.
  window.show();
  window.focus();
  return true;
}
