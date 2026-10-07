/**
 * Line diff between two prompt versions, shaped like a unified diff: hunks of
 * context / removed / added lines with 1-based line numbers on both sides. The
 * panel renders the lines directly; no patch application exists anywhere, so
 * the output is presentation data, not a patch format.
 */

export interface PromptDiffLine {
  readonly type: 'context' | 'removed' | 'added';
  readonly text: string;
  /** 1-based line number in the `from` text; `null` for added lines. */
  readonly fromLine: number | null;
  /** 1-based line number in the `to` text; `null` for removed lines. */
  readonly toLine: number | null;
}

export interface PromptDiffHunk {
  /** 1-based first `from` line in the hunk, or 0 when the hunk adds only. */
  readonly fromStart: number;
  readonly fromCount: number;
  /** 1-based first `to` line in the hunk, or 0 when the hunk removes only. */
  readonly toStart: number;
  readonly toCount: number;
  readonly lines: readonly PromptDiffLine[];
}

type Op = PromptDiffLine;

const CONTEXT_LINES = 3;

/**
 * Longest-common-subsequence cells above this budget fall back to one
 * whole-text hunk. Real prompt files are a few hundred lines; the budget only
 * guards the pathological case of two ~65k-line versions.
 * ponytail: LCS whole-matrix diff, 4M-cell budget; a Myers frontier diff if
 * someone ever diffs line-per-character prompts and wants minimal hunks.
 */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

export function unifiedPromptDiff(from: string, to: string, context = CONTEXT_LINES): PromptDiffHunk[] {
  const fromLines = splitLines(from);
  const toLines = splitLines(to);
  const ops = diffOps(fromLines, toLines);
  if (ops.every((op) => op.type === 'context')) {
    return [];
  }
  return groupHunks(ops, context);
}

function diffOps(fromLines: readonly string[], toLines: readonly string[]): Op[] {
  const n = fromLines.length;
  const m = toLines.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...fromLines.map((text, i) => ({ type: 'removed', text, fromLine: i + 1, toLine: null }) as Op),
      ...toLines.map((text, i) => ({ type: 'added', text, fromLine: null, toLine: i + 1 }) as Op),
    ];
  }
  // Suffix LCS lengths: dp[i * (m + 1) + j] is the LCS length of
  // fromLines[i..] and toLines[j..], so the walk below starts at (0, 0). The
  // matrix is filled completely before it is read, but the indexed reads stay
  // `?? 0` so `noUncheckedIndexedAccess` cannot widen them.
  const dp = new Int32Array((n + 1) * (m + 1));
  const cell = (i: number, j: number): number => dp[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] =
        fromLines[i] === toLines[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (fromLines[i] === toLines[j]) {
      ops.push({ type: 'context', text: fromLines[i] ?? '', fromLine: i + 1, toLine: j + 1 });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      ops.push({ type: 'removed', text: fromLines[i] ?? '', fromLine: i + 1, toLine: null });
      i += 1;
    } else {
      ops.push({ type: 'added', text: toLines[j] ?? '', fromLine: null, toLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'removed', text: fromLines[i] ?? '', fromLine: i + 1, toLine: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'added', text: toLines[j] ?? '', fromLine: null, toLine: j + 1 });
    j += 1;
  }
  return ops;
}

function groupHunks(ops: readonly Op[], context: number): PromptDiffHunk[] {
  // Ranges of op indices that must appear: each change pulls in `context`
  // neighbours, and changes whose ranges overlap or touch share one hunk.
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.type === 'context') {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges.map((range) => {
    const lines = ops.slice(range.start, range.end + 1);
    const counted = (side: 'fromLine' | 'toLine'): { start: number; count: number } => {
      const numbered = lines.filter((line) => line[side] !== null);
      return {
        start: numbered.length === 0 ? 0 : (numbered[0]?.[side] ?? 0),
        count: numbered.length,
      };
    };
    const from = counted('fromLine');
    const to = counted('toLine');
    return { fromStart: from.start, fromCount: from.count, toStart: to.start, toCount: to.count, lines };
  });
}
