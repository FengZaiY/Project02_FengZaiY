// Clear only the value this window copied; never erase a later clipboard update.
export class SecretClipboard {
  constructor(clipboard, delay = 30000) { this.clipboard = clipboard; this.delay = delay; }
  copy(value) {
    this.clear(); this.clipboard.writeText(value); this.value = value;
    this.timer = setTimeout(() => this.clear(), this.delay); this.timer.unref?.();
  }
  clear() {
    clearTimeout(this.timer);
    try { if (this.value !== undefined && this.clipboard.readText() === this.value) this.clipboard.clear(); }
    finally { this.value = undefined; this.timer = null; }
  }
}
