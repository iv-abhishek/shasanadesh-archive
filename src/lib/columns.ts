/**
 * Two-column PDF pages (ADR-085).
 *
 * `pdftotext -layout` keeps the two columns side by side on each line; the
 * page text was then whitespace-normalised, which interleaved the columns
 * line by line ("…the purchaser's interest in all Rule 172 (2) Part payment
 * to suppliers: respects. …" in GFR 2017). This finds a vertical gutter —
 * a run of spaces at the same position on most lines — and returns the left
 * column, then the right column. Single-column pages are returned unchanged.
 */

const MIN_GUTTER = 3;

function hasGutterAt(line: string, column: number): boolean {
  // Blank at the gutter (or the line ends before it).
  return line.slice(column - 1, column - 1 + MIN_GUTTER).trim() === "";
}

/**
 * The gutter column, or null when the page is not laid out in two columns.
 * A table (three or more columns: delegation-of-powers schedules, price
 * lists) is not split — its rows already read correctly line by line.
 */
export function findGutter(layoutText: string): number | null {
  const column = findSplit(layoutText, 60);
  if (column === null) return null;
  const lines = layoutText.split("\n");
  const leftSide = lines.map((line) => line.slice(0, column)).join("\n");
  const rightSide = lines.map((line) => line.slice(column)).join("\n");
  if (findSplit(leftSide, 30) !== null || findSplit(rightSide, 30) !== null) return null;
  return column;
}

function findSplit(layoutText: string, minWidth: number): number | null {
  const lines = layoutText.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 8) return null;
  const width = Math.max(...lines.map((line) => line.length));
  if (width < minWidth) return null;

  let best: { column: number; both: number } | null = null;
  for (let column = Math.floor(width * 0.3); column <= Math.floor(width * 0.7); column++) {
    let both = 0;
    let blocked = 0;
    for (const line of lines) {
      const left = line.slice(0, column).trim();
      const right = line.slice(column + MIN_GUTTER - 1).trim();
      if (!hasGutterAt(line, column)) {
        blocked++;
      } else if (left && right) {
        both++;
      }
    }
    // Most lines must leave the gutter blank, and many must use both sides.
    if (blocked <= lines.length * 0.15 && both >= lines.length * 0.35) {
      if (!best || both > best.both) best = { column, both };
    }
  }
  return best ? best.column : null;
}

/** Left column then right column; unchanged when there is no gutter. */
export function decolumn(layoutText: string): string {
  const gutter = findGutter(layoutText);
  if (gutter === null) return layoutText;
  const left: string[] = [];
  const right: string[] = [];
  for (const line of layoutText.split("\n")) {
    if (!hasGutterAt(line, gutter)) {
      // A line running across the gutter (a full-width heading) stays whole.
      left.push(line);
      continue;
    }
    left.push(line.slice(0, gutter).trimEnd());
    right.push(line.slice(gutter).trim());
  }
  return `${left.join("\n")}\n\n${right.join("\n")}`;
}
