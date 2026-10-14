import mammoth from 'mammoth';
import JSZip from 'jszip';

const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_HTML = 12 * 1024 * 1024;

async function checkArchive(buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files).filter(entry => !entry.dir);
  if (entries.length > 2000) throw new Error('文档内部文件过多，请使用本机应用打开');
  if (!archive.file('word/document.xml')) throw new Error('不是可读取的 DOCX 文档');
  let expanded = 0;
  // Count actual streamed output instead of trusting ZIP size metadata.
  for (const entry of entries) {
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream('uint8array');
      stream.on('data', chunk => {
        expanded += chunk.length;
        if (expanded > MAX_EXPANDED) {
          stream.pause(); reject(new Error('文档解压后过大，请使用本机应用打开'));
        }
      }).on('error', reject).on('end', resolve).resume();
    });
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.byteLength > 24 * 1024 * 1024) throw new Error('文档过大，请使用本机应用打开');
    await checkArchive(data);
    const result = await mammoth.convertToHtml({ arrayBuffer: data }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async image => {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.contentType))
          return { alt: '此图片格式需在原文件中查看' };
        const base64 = await image.read('base64');
        return { src: `data:${image.contentType};base64,${base64}` };
      })
    });
    if (result.value.length > MAX_HTML) throw new Error('文档预览内容过大，请使用本机应用打开');
    self.postMessage({ html: result.value, warnings: result.messages.length });
  } catch (error) {
    self.postMessage({ error: /文档|DOCX/.test(error.message) ? error.message : '文档无法解析，文件可能已损坏、加密或格式不受支持' });
  }
};
