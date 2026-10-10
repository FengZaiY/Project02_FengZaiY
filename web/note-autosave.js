// One writer per note; edits made during an in-flight save remain queued.
export function createNoteAutosave({ capture, write, apply, status, delay = 1500 }) {
  const jobs = new Map();
  const jobFor = key => {
    if (!jobs.has(key)) jobs.set(key, { revision: 0, timer: null, running: null, blocked: false, state: 'saved' });
    return jobs.get(key);
  };
  const notify = (key, job, value, error) => { job.state = value; job.error = error; status(key, value, error); };
  const schedule = (key, job) => {
    clearTimeout(job.timer);
    if (!job.blocked) job.timer = setTimeout(() => { void flush(key).catch(() => {}); }, delay);
  };
  async function flush(key, manual = false) {
    const job = jobFor(key);
    clearTimeout(job.timer);
    if (job.running) {
      try { await job.running; } catch (error) { if (!manual) throw error; }
      return flush(key, manual);
    }
    if (job.blocked && !manual) return;
    const input = capture(key);
    if (!input) { notify(key, job, 'saved'); return; }
    const revision = job.revision;
    job.blocked = false;
    notify(key, job, 'saving');
    job.running = (async () => {
      try {
        const saved = await write(input, manual);
        const unchanged = revision === job.revision;
        apply(key, saved, unchanged, input);
        job.blocked = !!saved.conflict;
        notify(key, job, job.blocked ? 'conflict' : unchanged ? 'saved' : 'queued');
      } catch (error) {
        job.blocked = true;
        notify(key, job, error.code === 'CONFLICT' ? 'conflict' : 'error', error);
        throw error;
      } finally {
        job.running = null;
        if (!job.blocked && capture(key)) schedule(key, job);
      }
    })();
    await job.running;
  }
  return {
    changed(key) {
      const job = jobFor(key); job.revision++;
      if (!job.blocked) notify(key, job, job.running ? 'saving' : 'queued');
      schedule(key, job);
    },
    flush,
    state: key => jobFor(key).state,
    async forget(key) {
      const job = jobs.get(key); if (!job) return;
      clearTimeout(job.timer);
      try { await job.running; } catch {}
      clearTimeout(job.timer); jobs.delete(key);
    }
  };
}
