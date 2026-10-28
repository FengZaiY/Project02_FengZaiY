import TurndownService from 'turndown';
import gfmPlugin from 'turndown-plugin-gfm';

export function readableMarkdown(data, assetLink = id => `fengzaiy://asset/${id}`) {
  if (data.format !== 'html') return data.content || '';
  const richBlock = (content, node) => {
      try {
        const block = JSON.parse(node.getAttribute('data-ss-block'));
        const label = String(block.label || '资料').replace(/[\[\]\\]/g, '\\$&');
        if (block.assetId) return `\n\n${block.kind === 'image' ? '!' : ''}[${label}](<${assetLink(block.assetId)}>)\n\n`;
        if (block.kind === 'formula') return `\n\n$$\n${block.source || ''}\n$$\n\n`;
        if (block.kind === 'sticker') return `\n\n> ${String(block.text || '').replace(/\n/g, '\n> ')}\n\n`;
        const source = block.source || (block.kind === 'canvas' ? JSON.stringify(block.shapes || [], null, 2) : JSON.stringify(block, null, 2));
        const fence = '`'.repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return `\n\n${label}\n\n${fence}${block.kind === 'diagram' ? 'mermaid' : 'json'}\n${source}\n${fence}\n\n`;
      } catch { return '\n\n富内容（请在 FengZaiY 中查看）\n\n'; }
    };
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced',
    blankReplacement: (content, node) => node.hasAttribute?.('data-ss-block') ? richBlock(content, node) : node.isBlock ? '\n\n' : '' });
  converter.use(gfmPlugin.gfm);
  converter.remove(['script', 'style', 'iframe']);
  converter.addRule('rich-block', { filter: node => node.hasAttribute?.('data-ss-block'), replacement: richBlock });
  converter.addRule('asset-link', {
    filter: node => node.nodeName === 'A' && /^(?:fengzaiy|studyself):\/\/asset\//.test(node.getAttribute('href') || ''),
    replacement: (content, node) => {
      const id = new URL(node.getAttribute('href')).pathname.slice(1);
      return `[${content || '资料'}](<${assetLink(id)}>)`;
    }
  });
  return converter.turndown(data.content || '');
}
