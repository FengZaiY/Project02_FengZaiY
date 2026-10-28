import test from 'node:test';
import assert from 'node:assert/strict';
import { activateDesktopWindow } from '../src/desktop/window-activation.mjs';

test('relaunch reveals hidden windows and restores minimized windows before focus', () => {
  for (const minimized of [false, true]) {
    let visible = false;
    const actions = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => actions.push('restore'),
      show: () => { visible = true; actions.push('show'); },
      focus: () => { assert.equal(visible, true); actions.push('focus'); }
    };
    assert.equal(activateDesktopWindow(window), true);
    assert.deepEqual(actions, minimized ? ['restore', 'show', 'focus'] : ['show', 'focus']);
  }
});

test('relaunch during startup or after window destruction is harmless', () => {
  assert.equal(activateDesktopWindow(undefined), false);
  assert.equal(activateDesktopWindow({ isDestroyed: () => true }), false);
});
