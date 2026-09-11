export type DiffTag = 'equal' | 'delete' | 'insert';

export type DiffSegment = {
  emphasized: boolean;
  value: string;
};

export type DiffRow = {
  tag: DiffTag;
  /** 1-based line number in the left document, or null for inserted lines. */
  oldLine: number | null;
  /** 1-based line number in the right document, or null for deleted lines. */
  newLine: number | null;
  segments: DiffSegment[];
  /** The source line had no trailing newline. */
  missingNewline: boolean;
};

/**
 * A run of rows around one or more changes. Equal stretches between hunks are
 * dropped, which is what keeps a 100k-line file with three edits small.
 */
export type DiffHunk = {
  rows: DiffRow[];
  /** Equal lines collapsed between the previous hunk and this one. */
  collapsedBefore: number;
};

export type DiffStats = {
  added: number;
  removed: number;
  /** Rows actually kept across all hunks. */
  rows: number;
};

export type DiffResult = {
  hunks: DiffHunk[];
  stats: DiffStats;
  identical: boolean;
  /** Set when the diff was cut short because it exceeded `maxRows`. */
  truncated: boolean;
  elapsedMs: number;
};

export type DiffRequest = {
  type: 'diff';
  id: number;
  oldText: string;
  newText: string;
  /** Equal lines to keep either side of a change. */
  context: number;
  /** Stop after this many kept rows, to keep a pathological diff renderable. */
  maxRows: number;
};

export type DiffResponse =
  | { type: 'result'; id: number; result: DiffResult }
  | { type: 'error'; id: number; message: string };
