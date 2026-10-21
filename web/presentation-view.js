import * as echarts from 'echarts';
import { validatePresentation, validatePageHtml, validatePageCss, presentationBody, presentationLimits as limits } from '../src/core/presentation-schema.mjs';
import { renderBlock } from './rich-editor.js';
import './presentation.css';

export async function pageCurrent(data) {
  if (!data.presentation) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(presentationBody(data)));
  return data.presentation.basis?.contentHash === [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function chartOptions(value) {
  let count = 0;
  const visit = (item, depth = 0) => {
    if (++count > 15000 || depth > 30) throw new Error('图表数据过多');
    if (typeof item === 'string' && (item.length > 20000 || /(?:image:\/\/|https?:|data:|blob:|file:|url\s*\()/i.test(item))) throw new Error('图表不能加载外部内容');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype', 'link', 'sublink', 'image', 'toolbox', 'formatter', 'rich', 'renderMode'].includes(key)) throw new Error('图表选项不受支持');
      visit(child, depth + 1);
    }
  };
  visit(value);
  return { ...value, tooltip: { ...value.tooltip, renderMode: 'richText' }, animationDuration: 250, animationDurationUpdate: 150 };
}

export function mountPresentation(host, data, { mediaUrl, openNote, onError = () => {} } = {}) {
  let page, frame, doc, worker, disposed = false, stopped = false, busy = false, watchdog, observer, pendingRenders = 0, resourceErrors = false;
  const charts = new Map(), timers = new Map(), animations = new Set(), cleanups = [];
  const pendingEvents = [];
  const renders = new WeakMap();
  const bar = document.createElement('div'); bar.className = 'page-runtime-bar';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = '正在准备交互页面';
  const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '停止'; stop.title = '停止交互';
  const restart = document.createElement('button'); restart.type = 'button'; restart.textContent = '重新运行';
  bar.append(status, stop, restart); host.replaceChildren(bar);
  const fail = error => { halt(); status.textContent = error.message || String(error); onError(error); };
  function halt() {
    stopped = true; busy = false; clearTimeout(watchdog); worker?.terminate(); worker = null;
    pendingEvents.length = 0;
    for (const timer of timers.values()) clearInterval(timer); timers.clear();
    for (const animation of animations) animation.cancel(); animations.clear();
    charts.forEach(chart => chart.getZr().animation.stop());
    doc?.querySelectorAll('video,audio').forEach(el => el.pause());
    stop.disabled = true;
  }
  function dispose() {
    disposed = true; halt(); observer?.disconnect();
    charts.forEach(chart => chart.dispose()); charts.clear();
    cleanups.splice(0).forEach(fn => fn());
    doc?.querySelectorAll('video,audio,img').forEach(el => { el.removeAttribute('src'); if (el.tagName !== 'IMG') el.load(); });
    frame?.remove(); bar.remove();
  }
  stop.onclick = () => { halt(); status.textContent = '交互已停止'; };
  restart.onclick = () => { if (!disposed) { dispose(); const next = mountPresentation(host, data, { mediaUrl, openNote, onError }); host._presentation = next; } };
  const instance = { destroy: dispose }; host._presentation = instance;
  function post(event) {
    if (disposed || stopped || !worker) return;
    if (busy) {
      if (event.type === 'tick') return;
      const previous = event.type === 'input' ? pendingEvents.findIndex(item => item.type === event.type && item.id === event.id) : -1;
      if (previous >= 0) pendingEvents[previous] = event;
      else if (pendingEvents.length < 50) pendingEvents.push(event);
      else fail(new Error('页面操作队列过长，已停止交互'));
      return;
    }
    busy = true; watchdog = setTimeout(() => fail(new Error('页面运行超时，已停止；正文仍可阅读')), 2000);
    worker.postMessage({ type: 'event', event });
  }
  function resources(root) {
    for (const el of root.querySelectorAll('img,video,audio')) {
      const assetId = el.dataset.assetId;
      if (!assetId || !page.assetIds.includes(assetId)) continue;
      if (el.tagName !== 'IMG') { el.controls = true; el.preload = 'metadata'; }
      else el.loading = 'lazy';
      el.addEventListener('error', () => {
        if (disposed || !el.isConnected) return;
        resourceErrors = true;
        const placeholder = doc.createElement('span'); placeholder.textContent = '附件暂不可用';
        placeholder.setAttribute('role', 'status'); el.replaceWith(placeholder);
        status.textContent = '部分附件不可用，可切换正文查看出处';
      }, { once: true });
      // The guest has no DOM/URL access; only the host maps declared IDs to protected media.
      el.src = mediaUrl(assetId);
    }
  }
  function target(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z][\w-]{0,79}$/.test(id)) throw new Error('页面元素标识无效');
    const el = doc.getElementById(id); if (!el) throw new Error(`找不到页面元素：${id}`); return el;
  }
  function checkChartSize(el) {
    const size = el.getBoundingClientRect();
    if (size.width > 8192 || size.height > 8192 || size.width * size.height > 4000000) throw new Error('图表显示尺寸过大');
  }
  function commands(batch) {
    if (!Array.isArray(batch) || batch.length > limits.commands || JSON.stringify(batch).length > limits.message) throw new Error('页面更新超出限制');
    for (const { op, id, value } of batch) {
      if (op === 'every') {
        if (typeof id !== 'string' || !/^[a-zA-Z][\w-]{0,79}$/.test(id) || !Number.isFinite(value) || value < 50 || value > 60000 || (timers.size >= 16 && !timers.has(id))) throw new Error('页面计时器超出限制');
        clearInterval(timers.get(id)); timers.set(id, setInterval(() => post({ id, type: 'tick', time: performance.now() }), value)); continue;
      }
      if (op === 'cancel') { clearInterval(timers.get(id)); timers.delete(id); continue; }
      const el = target(id);
      if (['text', 'html', 'formula', 'diagram'].includes(op)) {
        renders.delete(el);
        charts.forEach((chart, key) => { if (el.contains(chart.getDom())) { chart.dispose(); charts.delete(key); } });
      }
      if (op === 'text') { if (typeof value !== 'string' || value.length > 100000) throw new Error('显示文字过多'); el.textContent = value; }
      else if (op === 'html') {
        const html = validatePageHtml(value, page);
        const template = doc.createElement('template'); template.innerHTML = html;
        for (const node of template.content.querySelectorAll('[id]')) {
          const existing = doc.getElementById(node.id);
          if (existing && (existing === el || !el.contains(existing))) throw new Error('页面元素标识重复');
        }
        if (doc.querySelectorAll('*').length - el.querySelectorAll('*').length + template.content.querySelectorAll('*').length > limits.nodes + 500) throw new Error('页面节点过多');
        el.replaceChildren(template.content);
        void resources(el);
      } else if (op === 'show') el.hidden = !value;
      else if (op === 'value') { if (['INPUT', 'SELECT', 'OUTPUT'].includes(el.tagName)) { if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value).slice(0, 10000); } }
      else if (op === 'style') { validatePageCss(value, true); el.style.cssText = value; }
      else if (op === 'chart') {
        const option = chartOptions(value);
        checkChartSize(el);
        if (!charts.has(id) && charts.size >= 8) throw new Error('图表数量过多');
        if (!charts.has(id)) {
          // SVG stays visible across the host/isolated-document boundary without script permission.
          const chart = echarts.init(el, null, { renderer: 'svg' }); charts.set(id, chart);
          chart.on('click', event => post({ id, type: 'select', name: String(event.name).slice(0, 1000), index: event.dataIndex, value: event.value }));
        }
        charts.get(id).setOption(option, { notMerge: true });
      } else if (['formula', 'diagram'].includes(op)) {
        if (pendingRenders >= 4) throw new Error('同时绘制的公式或图表过多');
        pendingRenders++;
        const token = {}, temporary = doc.createElement('div'); renders.set(el, token);
        void renderBlock(temporary, { v: 1, kind: op, label: '', source: value }, () => '').then(ok => {
          if (disposed || stopped || renders.get(el) !== token || !el.isConnected) return;
          el.replaceChildren(...temporary.childNodes);
          if (!ok) status.textContent = '部分内容显示失败，可切换正文';
        }).finally(() => { pendingRenders--; });
      } else if (op === 'animate') {
        if (!Array.isArray(value?.frames) || value.frames.length > 30 || !value.options || Object.keys(value.options).some(k => !['duration', 'iterations', 'direction', 'easing', 'fill'].includes(k))) throw new Error('动画配置无效');
        for (const item of value.frames) for (const [property, val] of Object.entries(item)) {
          if (!['opacity', 'transform', 'backgroundColor', 'color', 'offset'].includes(property) || (typeof val !== 'string' && typeof val !== 'number')) throw new Error('动画属性无效');
          validatePageCss(`x:${val}`, true);
        }
        if (!Number.isFinite(value.options.duration) || value.options.duration < 50 || value.options.duration > 60000 || (value.options.iterations !== undefined && (!Number.isFinite(value.options.iterations) || value.options.iterations < 1 || value.options.iterations > 100)) || animations.size >= 50) throw new Error('动画超出限制');
        const animation = el.animate(value.frames, value.options); animations.add(animation); animation.onfinish = () => animations.delete(animation);
      } else throw new Error('页面命令不受支持');
    }
  }
  try {
    page = validatePresentation(data.presentation);
    if (!page) throw new Error('没有交互页面');
    page = { ...page, html: validatePageHtml(page.html, page) };
    frame = document.createElement('iframe'); frame.className = 'interactive-page'; frame.title = '交互笔记';
    // Guest code never runs in this document. Only the host renders validated content.
    frame.setAttribute('sandbox', 'allow-same-origin'); frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' studyself-media:; media-src 'self' studyself-media:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><link rel="stylesheet" href="${new URL('./page-formula.css', window.location.href).href}"><style>html{color:#25312e;background:white;font:16px/1.65 system-ui,sans-serif}body{margin:0;padding:24px;overflow-wrap:anywhere}*{box-sizing:border-box;letter-spacing:0}img,video,canvas,svg{max-width:100%}button,input,select{font:inherit;max-width:100%}button{cursor:pointer}[hidden]{display:none!important}:focus-visible{outline:2px solid #20816b}h1{font-size:30px;line-height:1.3}h2{font-size:23px}table{border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd}@media(max-width:600px){body{padding:16px}}${page.css.replace(/</g, '\\3c ')}</style></head><body>${page.html}</body></html>`;
    frame.onload = () => {
      if (disposed) return;
      try {
        doc = frame.contentDocument;
        if (!doc) throw new Error('页面隔离加载失败');
        for (const type of ['click', 'input', 'change']) {
          const handler = event => {
            const el = event.target.closest('[id],[data-note-id]'); if (!el || !doc.body.contains(el)) return;
            if (type === 'click' && el.dataset.noteId) { if (event.isTrusted && page.noteIds.includes(el.dataset.noteId)) openNote?.(el.dataset.noteId); return; }
            if (!event.isTrusted) return;
            post({ id: el.id, type, value: String(el.value ?? '').slice(0, 10000), checked: el.checked === true });
          };
          doc.addEventListener(type, handler); cleanups.push(() => doc.removeEventListener(type, handler));
        }
        void resources(doc);
        worker = new Worker(new URL('./presentation-worker.js', window.location.href), { type: 'module' });
        worker.onerror = () => fail(new Error('交互程序加载失败，正文仍可阅读'));
        worker.onmessage = ({ data: message }) => {
          if (disposed || stopped) return;
          clearTimeout(watchdog); busy = false;
          try {
            if (message?.type === 'error') throw new Error(message.message);
            if (message?.type !== 'result') throw new Error('页面响应无效');
            commands(message.commands);
            charts.forEach(chart => { checkChartSize(chart.getDom()); chart.resize(); });
            status.textContent = resourceErrors ? '部分附件不可用，可切换正文查看出处' : '交互运行中';
            if (pendingEvents.length) post(pendingEvents.shift());
          } catch (error) { fail(error); }
        };
        busy = true; watchdog = setTimeout(() => fail(new Error('页面启动超时，正文仍可阅读')), 10000);
        worker.postMessage({ type: 'init', script: page.script, data: page.data });
        observer = new ResizeObserver(() => {
          if (disposed || stopped) return;
          try { charts.forEach(chart => { checkChartSize(chart.getDom()); chart.resize(); }); }
          catch (error) { fail(error); }
        }); observer.observe(host);
      } catch (error) { fail(error); }
    };
    host.append(frame);
  } catch (error) { fail(error); }
  return instance;
}
