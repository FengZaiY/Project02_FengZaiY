import DOMPurify from 'dompurify';

export const isDocx = asset => /\.docx$/i.test(asset.filename || '')
  || asset.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function readDocx(binary, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('预览已取消', 'AbortError')); return; }
    const worker = new Worker(new URL('./docx-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, value) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException('预览已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('文档解析超时，请使用本机应用打开')), 20000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(new Error('文档预览未能加载，请重试')); };
    worker.onmessage = ({ data }) => {
      if (data.error) { finish(new Error(data.error)); return; }
      try { finish(null, { html: safeDocxHtml(data.html), warnings: data.warnings }); }
      catch { finish(new Error('文档预览内容无效')); }
    };
    worker.postMessage(binary.buffer, [binary.buffer]);
  });
}

export function safeDocxHtml(html) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'del', 'sup', 'sub', 'br',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'a', 'blockquote', 'pre', 'code', 'hr'],
    ALLOWED_ATTR: ['src', 'alt', 'href', 'id', 'colspan', 'rowspan']
  });
  for (const image of fragment.querySelectorAll('img')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(image.getAttribute('src') || '')) {
      const label = document.createElement('span'); label.textContent = image.alt || '图片需在原文件中查看';
      image.replaceWith(label);
    }
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('#')) {
      if (/^https?:\/\//i.test(href)) link.title = href;
      link.removeAttribute('href');
    }
  }
  const host = document.createElement('div'); host.append(fragment);
  return host.innerHTML;
}

export function docxPage(html) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:16px;color:#25362e;background:#fff;font:14px/1.8 "Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
p{margin:0 0 12px}h1{font-size:23px}h2{font-size:20px}h3{font-size:17px}h4,h5,h6{font-size:15px}h1,h2,h3,h4,h5,h6{line-height:1.5;margin:20px 0 10px}
img{display:block;max-width:100%;height:auto;margin:12px auto}table{border-collapse:collapse;max-width:100%;width:100%;table-layout:fixed;margin:16px 0}
td,th{border:1px solid #cdd7d1;padding:8px;vertical-align:top;overflow-wrap:anywhere}td p,th p{margin:0}th{background:#f0f4f2}ul,ol{padding-left:24px}
pre{white-space:pre-wrap}blockquote{margin:12px 0;padding-left:12px;border-left:3px solid #9bb4a5}a{color:#286a81}
</style></head><body>${html || '<p>文档没有可显示的正文内容。</p>'}</body></html>`;
}
