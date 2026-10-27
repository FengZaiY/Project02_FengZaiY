// Bump when the renderer requires incompatible trusted-interface capabilities.
export const UI_PROTOCOL = 2;

export function assertUiProtocol(snapshot) {
  if (snapshot?.uiProtocol !== UI_PROTOCOL) throw Object.assign(new Error('页面与本机服务版本不一致，请重新启动应用或本机预览服务后重新加载。'), { code: 'UI_VERSION_MISMATCH' });
}
