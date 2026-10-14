// Exact fractions avoid float exhaustion when repeatedly inserting between neighbours.
export function validNoteOrder(value) {
  return value === null || typeof value === 'string' && /^(0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/.test(value) && value.length <= 2048;
}

export function compareNoteOrder(a, b) {
  const left = a.data.noteOrder, right = b.data.noteOrder;
  if (left && right) {
    const [an, ad] = left.split('/').map(BigInt), [bn, bd] = right.split('/').map(BigInt);
    const delta = an * bd - bn * ad;
    return delta < 0n ? -1 : delta > 0n ? 1 : a.id.localeCompare(b.id);
  }
  if (left || right) return left ? -1 : 1;
  return a.data.title.localeCompare(b.data.title, 'zh-CN') || a.id.localeCompare(b.id);
}

export function orderBetween(left, right) {
  const [an, ad] = left ? left.split('/').map(BigInt) : [0n, 1n];
  const [bn, bd] = right ? right.split('/').map(BigInt) : [0n, 1n];
  let n = !left ? bn - bd : !right ? an + ad : an * bd + bn * ad;
  let d = !left ? bd : !right ? ad : 2n * ad * bd;
  let x = n < 0n ? -n : n, y = d;
  while (y) [x, y] = [y, x % y];
  n /= x; d /= x;
  return `${n}/${d}`;
}
