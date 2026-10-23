import './agent-mcp.css';
import { copyVisibleText } from './editor-text.js';

export function mcpConfiguration(url, kind) {
  if (!url) return '';
  if (kind === 'codex') return `[mcp_servers.studyself]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "STUDYSELF_AGENT_TOKEN"`;
  return JSON.stringify({ mcpServers: { studyself: { url, headers: { Authorization: 'Bearer <填写本次授权的访问凭证>' } } } }, null, 2);
}

export function mcpConnectionMarkup(access, { esc, icon }) {
  return `<section class="settings-section agent-mcp" aria-label="MCP 连接"><h2>MCP 连接</h2>
    <label class="check-row"><input id="agent-enabled" type="checkbox" ${access.enabled || access.requestedEnabled ? 'checked' : ''}>启用本机 MCP 连接</label>
    ${access.error ? `<div class="notice danger">${esc(access.error)}</div>` : ''}
    <div class="definition-list"><div><span>Streamable HTTP</span><code id="agent-mcp-url">${esc(access.mcpUrl || '未开启')}</code>
      <button class="icon-button" id="agent-mcp-copy-url" title="复制 MCP 地址" aria-label="复制 MCP 地址" ${access.mcpUrl ? '' : 'disabled'}>${icon('copy')}</button></div></div>
    <div class="agent-mcp-controls"><label for="agent-mcp-client">客户端配置</label><select id="agent-mcp-client" ${access.mcpUrl ? '' : 'disabled'}><option value="codex">Codex</option><option value="http">通用 MCP 客户端</option></select>
      <button class="icon-button" id="agent-mcp-copy-config" title="复制 MCP 配置" aria-label="复制 MCP 配置" ${access.mcpUrl ? '' : 'disabled'}>${icon('copy')}</button></div>
    <textarea id="agent-mcp-config" aria-label="MCP 配置示例" readonly spellcheck="false" rows="4">${esc(access.mcpUrl ? mcpConfiguration(access.mcpUrl, 'codex') : '请先启用本机 MCP 连接')}</textarea>
    <p id="agent-mcp-auth" class="muted">${access.mcpUrl ? '凭证变量：STUDYSELF_AGENT_TOKEN（在 Codex 启动环境中设置）。每个客户端单独授权。' : '连接关闭'}</p></section>`;
}

export function bindMcpConnection(access, { root, run, toast }) {
  const select = root.querySelector('#agent-mcp-client'), config = root.querySelector('#agent-mcp-config');
  select.onchange = () => {
    config.value = mcpConfiguration(access.mcpUrl, select.value);
    config.rows = select.value === 'codex' ? 4 : 10;
    root.querySelector('#agent-mcp-auth').textContent = select.value === 'codex'
      ? '凭证变量：STUDYSELF_AGENT_TOKEN（在 Codex 启动环境中设置）。每个客户端单独授权。'
      : 'Authorization 中填写独立授权凭证。需要支持 Streamable HTTP 和自定义请求头的本机客户端。';
  };
  const copy = (value, target, label) => run(async () => {
    if (!value) return;
    const copied = await copyVisibleText(value, target);
    toast(copied ? '已复制' : `自动复制受限，已选中${label}，请按 Ctrl+C 复制`);
  });
  const url = root.querySelector('#agent-mcp-url');
  url.tabIndex = -1;
  root.querySelector('#agent-mcp-copy-url').onclick = () => copy(access.mcpUrl, url, '地址');
  root.querySelector('#agent-mcp-copy-config').onclick = () => copy(mcpConfiguration(access.mcpUrl, select.value), config, '配置');
}
