import { Worker } from 'node:worker_threads';

let worker, active, serial = 0, idleTimer, completedBytes = 0, completedTasks = 0;
const queue = [];
export const fileWorkStatus = () => ({ active: !!active, queued: queue.length, threadId: worker?.threadId || null, completedBytes, completedTasks });

function pump() {
  if (active || !queue.length) return;
  clearTimeout(idleTimer);
  if (!worker) {
    const instance = new Worker(new URL('./file-worker.mjs', import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
    worker = instance;
    instance.on('message', result => {
      if (worker !== instance || result.id !== active?.id) return;
      const job = active; active = null;
      if (!result.error) { completedBytes += job.size; completedTasks++; }
      if (result.error) job.reject(Object.assign(new Error(result.error), { code: result.code })); else job.resolve(result);
      if (queue.length) pump();
      else {
        instance.unref();
        idleTimer = setTimeout(() => { if (worker === instance && !active) { worker = null; void instance.terminate(); } }, 30000);
        idleTimer.unref();
      }
    });
    let failure;
    instance.on('error', error => { failure = error; });
    instance.on('exit', code => {
      if (worker !== instance) return;
      worker = null;
      // Reject only after exit: callers still own the descriptor until all worker reads stop.
      const job = active; active = null;
      job?.reject(failure || new Error(`文件校验线程已退出（${code}），请重试`));
      pump();
    });
  }
  active = queue.shift(); worker.ref();
  worker.postMessage({ id: active.id, fd: active.fd, size: active.size, content: active.content });
}

// The caller retains and closes the handle, including queued tasks. No path or database reaches the worker.
export function readFileWork(handle, size, { content = false } = {}) {
  if (queue.length >= 64) return Promise.reject(Object.assign(new Error('文件校验繁忙，请稍后重试'), { code: 'BUSY' }));
  return new Promise((resolve, reject) => { queue.push({ id: ++serial, fd: handle.fd, size, content, resolve, reject }); pump(); });
}
