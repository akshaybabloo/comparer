/**
 * Display helpers. Kept out of `utils.ts` because shadcn-svelte owns that file
 * and rewrites it whenever the CLI runs.
 */

/** Formats a byte count for display next to a filename. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `1234567` -> `1,234,567`, for line and row counts. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
