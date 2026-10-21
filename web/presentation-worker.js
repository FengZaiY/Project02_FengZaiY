import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import { presentationLimits as limits } from '../src/core/presentation-schema.mjs';

let context, runtime, dispatch, deadline = 0, commands = [], bytes = 0, initialized = false;
const bootstrap = `
(() => {
  const handlers = new Map();
  const emit = (op, id, value) => __emit(JSON.stringify({op,id,value}));
  const events = new Set(['click','input','change','select']);
  globalThis.page = Object.freeze({
    data: JSON.parse(__data),
    on(id, event, fn) { if (!events.has(event) || typeof fn !== 'function') throw Error('Invalid handler'); handlers.set(id+':'+event, fn); },
    text: (id, value) => emit('text', id, String(value)),
    html: (id, value) => emit('html', id, String(value)),
    style: (id, value) => emit('style', id, value),
    show: (id, value) => emit('show', id, !!value),
    value: (id, value) => emit('value', id, value),
    chart: (id, value) => emit('chart', id, value),
    formula: (id, value) => emit('formula', id, String(value)),
    diagram: (id, value) => emit('diagram', id, String(value)),
    animate: (id, frames, options = {}) => emit('animate', id, {frames,options}),
    every(id, ms, fn) { if (typeof fn !== 'function') throw Error('Invalid timer'); handlers.set(id+':tick', fn); emit('every',id,ms); },
    cancel(id) { handlers.delete(id+':tick'); emit('cancel',id,null); }
  });
  globalThis.__dispatch = raw => { const event = JSON.parse(raw); const fn = handlers.get(event.id+':'+event.type); if (fn) fn(event); };
  delete globalThis.__data;
})();`;

function release() {
  dispatch?.dispose(); dispatch = null;
  context?.dispose(); context = null;
  runtime?.dispose(); runtime = null;
}
function run(fn, timeout) {
  commands = []; bytes = 0; deadline = Date.now() + timeout;
  const result = fn();
  if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new Error(String(error?.message || error).slice(0, 500)); }
  result.value.dispose();
  const jobs = runtime.executePendingJobs(20);
  if (jobs.error) { jobs.error.dispose(); throw new Error('页面异步计算失败'); }
  if (runtime.hasPendingJob()) throw new Error('页面异步任务过多');
  postMessage({ type: 'result', commands });
}
self.onmessage = async ({ data: message }) => {
  try {
    if (message?.type === 'init' && !initialized) {
      initialized = true;
      const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary: wasm.buffer }));
      runtime = module.newRuntime(); runtime.setMemoryLimit(limits.memory); runtime.setMaxStackSize(512 * 1024);
      runtime.setInterruptHandler(() => Date.now() > deadline);
      context = runtime.newContext();
      const emit = context.newFunction('__emit', value => {
        const json = context.getString(value); bytes += json.length;
        if (commands.length >= limits.commands || bytes > limits.message) throw new Error('页面更新过多');
        commands.push(JSON.parse(json));
      });
      context.setProp(context.global, '__emit', emit); emit.dispose();
      const data = context.newString(JSON.stringify(message.data)); context.setProp(context.global, '__data', data); data.dispose();
      run(() => context.evalCode(`${bootstrap}\n${message.script}`, 'note-page.js'), limits.initMs);
      dispatch = context.getProp(context.global, '__dispatch');
    } else if (message?.type === 'event' && context && dispatch) {
      const event = context.newString(JSON.stringify(message.event));
      try { run(() => context.callFunction(dispatch, context.undefined, event), limits.callbackMs); }
      finally { event.dispose(); }
    } else throw new Error('页面运行消息无效');
  } catch (error) {
    postMessage({ type: 'error', message: `交互已停止：${String(error.message).slice(0, 500)}` });
    release(); self.close();
  }
};
