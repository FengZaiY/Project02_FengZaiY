const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const videos = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const symbols = { image: 'image', video: 'film', audio: 'music', document: 'file-text', archive: 'file-archive', other: 'file' };
const thumbnails = new Map();
let thumbnailBytes = 0;
function rememberThumbnail(key, blob) {
  if (!key || !blob || blob.size > 1024 * 1024) return;
  if (thumbnails.has(key)) thumbnailBytes -= thumbnails.get(key).size;
  thumbnails.delete(key); thumbnails.set(key, blob); thumbnailBytes += blob.size;
  while (thumbnails.size > 48 || thumbnailBytes > 12 * 1024 * 1024) {
    const first = thumbnails.keys().next().value; thumbnailBytes -= thumbnails.get(first).size; thumbnails.delete(first);
  }
}

export function thumbnailMarkup(row, { esc, icon }) {
  const media = row.available && !row.deleted && !row.conflict
    ? images.has(row.data.mime) ? 'image' : videos.has(row.data.mime) ? 'video' : '' : '';
  const ext = row.data.filename.includes('.') ? row.data.filename.split('.').at(-1).toUpperCase().slice(0, 8) : 'FILE';
  const status = row.deleted ? '已回收' : row.conflict ? '属性冲突' : !row.available ? '待下载' : '';
  const key = !status && row.storage?.previewIdentity ? `${row.id}:${row.storage.previewIdentity}` : '';
  for (const old of thumbnails.keys()) if (old.startsWith(`${row.id}:`) && old !== key) {
    thumbnailBytes -= thumbnails.get(old).size; thumbnails.delete(old);
  }
  return `<button class="material-thumbnail" data-kind="${row.kind}" data-action="${status ? 'material-detail' : 'preview-asset'}"
    data-asset="${row.id}" data-thumbnail-key="${esc(key)}" ${media ? `data-thumbnail-media="${media}"` : ''} aria-label="${status ? '查看资料' : '预览资料'}：${esc(row.data.title)}" title="${esc(row.data.title)}${status ? ` · ${status}` : ''}">
    <span class="material-thumbnail-fallback">${icon(symbols[row.kind] || 'file')}<span>${esc(status || ext)}</span></span>
    ${media === 'image' ? '<img alt="" decoding="async" draggable="false">' : media === 'video' ? '<video muted playsinline preload="none" tabindex="-1" aria-hidden="true"></video><span class="material-video-badge" aria-hidden="true">' + icon('play') + '</span>' : ''}
    </button>`;
}

// Observe the scroll area and bound decoding work; detached media must stop reading originals.
export function mountThumbnails(host, mediaUrl) {
  const queue = [], cleanups = [];
  let active = 0, stopped = false;
  function load(button) {
    active++;
    const key = button.dataset.thumbnailKey, cached = thumbnails.get(key);
    let media = button.querySelector('img,video'), cachedUrl;
    if (cached) {
      thumbnails.delete(key); thumbnails.set(key, cached);
      if (media.tagName === 'VIDEO') { const img = document.createElement('img'); img.alt = ''; img.draggable = false; media.replaceWith(img); media = img; }
      cachedUrl = URL.createObjectURL(cached);
    }
    const video = media.tagName === 'VIDEO';
    let finished = false, timer;
    const finish = success => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      media.onload = media.onerror = media.onloadedmetadata = media.onloadeddata = media.onseeked = null;
      if (!stopped && button.isConnected) {
        button.dataset.thumbnailState = success ? 'ready' : 'unavailable';
        if (!success) {
          button.querySelector('.material-thumbnail-fallback span').textContent = '无法预览';
          media.removeAttribute('src'); if (video) media.load();
        }
        if (success && !cached && key) {
          try {
            const width = video ? media.videoWidth : media.naturalWidth, height = video ? media.videoHeight : media.naturalHeight;
            const scale = Math.min(1, 320 / width, 240 / height), canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => { if (!stopped && button.isConnected) rememberThumbnail(key, blob); }, 'image/png');
          } catch { /* The original remains visible when a platform cannot capture a thumbnail. */ }
        }
      }
      active--; pump();
    };
    cleanups.push(() => {
      finish(false);
      if (video) media.pause();
      media.removeAttribute('src'); if (video) media.load();
      if (cachedUrl) URL.revokeObjectURL(cachedUrl);
    });
    media.onerror = () => finish(false);
    timer = setTimeout(() => finish(false), 20000);
    if (video) {
      media.muted = true;
      media.onloadedmetadata = () => {
        if (Number.isFinite(media.duration) && media.duration > 0.1) media.currentTime = Math.min(0.5, media.duration / 2);
      };
      media.onloadeddata = () => { if (!media.seeking) finish(media.videoWidth > 0); };
      media.onseeked = () => finish(media.videoWidth > 0);
      media.preload = 'metadata';
    } else media.onload = () => finish(media.naturalWidth > 0);
    button.dataset.thumbnailState = 'loading';
    if (!cachedUrl) media.crossOrigin = 'anonymous';
    media.src = cachedUrl || mediaUrl(button.dataset.asset);
  }
  function pump() {
    while (!stopped && active < 3 && queue.length) {
      const button = queue.shift();
      if (button.isConnected) load(button);
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target); queue.push(entry.target);
    }
    pump();
  }, { root: host, rootMargin: '80px' });
  host.querySelectorAll('[data-thumbnail-media]').forEach(button => observer.observe(button));
  return () => { stopped = true; observer.disconnect(); queue.length = 0; cleanups.forEach(clean => clean()); };
}

export function fitFilterLabels(host) {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  const resize = new ResizeObserver(() => {
    for (const select of host.querySelectorAll('[data-material-filter]')) {
      const full = select.nextElementSibling, style = getComputedStyle(select);
      const text = select.selectedOptions[0]?.textContent || '';
      context.font = `${style.fontSize} ${style.fontFamily}`;
      full.textContent = text;
      full.hidden = context.measureText(text).width <= select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      select.title = text;
    }
  });
  host.querySelectorAll('[data-material-filter]').forEach(select => resize.observe(select));
  return () => resize.disconnect();
}
