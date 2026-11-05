export function splitLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text) => ({ type: 'del', text })),
      ...newLines.map((text) => ({ type: 'add', text }))
    ];
  }

  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', text: newLines[j] });
    j += 1;
  }
  return ops;
}

export function unifiedDiff(oldText, newText, options = {}) {
  const path = options.path ?? 'plik';
  const context = options.context ?? 3;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffOps(oldLines, newLines);

  if (!ops.some((op) => op.type !== 'equal')) return [];

  const lineNumbers = [];
  let oldNumber = 1;
  let newNumber = 1;
  for (const op of ops) {
    lineNumbers.push({ old: oldNumber, new: newNumber });
    if (op.type !== 'add') oldNumber += 1;
    if (op.type !== 'del') newNumber += 1;
  }

  const changed = [];
  ops.forEach((op, index) => {
    if (op.type !== 'equal') changed.push(index);
  });

  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length, changed[0] + context + 1);

  for (let index = 1; index < changed.length; index += 1) {
    const change = changed[index];
    if (change <= end + context) {
      end = Math.min(ops.length, change + context + 1);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, change - context);
      end = Math.min(ops.length, change + context + 1);
    }
  }
  hunks.push([start, end]);

  const output = [];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.type !== 'add').length;
    const newCount = slice.filter((op) => op.type !== 'del').length;
    const oldStart = oldCount === 0 ? lineNumbers[from].old - 1 : lineNumbers[from].old;
    const newStart = newCount === 0 ? lineNumbers[from].new - 1 : lineNumbers[from].new;

    output.push({
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      type: 'hunk'
    });

    for (const op of slice) {
      if (op.type === 'equal') output.push({ text: ` ${op.text}`, type: 'context' });
      else if (op.type === 'add') output.push({ text: `+${op.text}`, type: 'add' });
      else output.push({ text: `-${op.text}`, type: 'del' });
    }
  }

  const header = [
    { text: `--- a/${path}`, type: 'meta' },
    { text: `+++ b/${path}`, type: 'meta' }
  ];

  return [...header, ...output];
}
