// The "freeband" wordmark: a 7-row pixel face drawn as an LED dot matrix,
// every font pixel a 2×2 block of dots. Unlit dots stay faintly visible, and
// the letters thin out left to right through a 4×4 Bayer ordered dither.
// Built once at module load; constant markup with no user data.

const GLYPHS: Record<string, string[]> = {
  f: [".##", "#..", "###", "#..", "#..", "#..", "#.."],
  r: ["....", "....", "#.##", "##..", "#...", "#...", "#..."],
  e: ["....", "....", ".##.", "#..#", "####", "#...", ".###"],
  b: ["#...", "#...", "###.", "#..#", "#..#", "#..#", "###."],
  a: ["....", "....", ".##.", "...#", ".###", "#..#", ".###"],
  n: ["....", "....", "###.", "#..#", "#..#", "#..#", "#..#"],
  d: ["...#", "...#", ".###", "#..#", "#..#", "#..#", ".###"],
};

const WORD = "freeband";
/** Share of dots lit per letter, in sixteenths (one level of the 4×4 Bayer matrix each). */
const DENSITY = [16, 16, 16, 16, 13, 11, 10, 8];
const PITCH = 2; // one dot every 2 units
const DOT = 1.5; // dot size
const DOTS_PER_PX = 2;
const PX = PITCH * DOTS_PER_PX; // one font pixel = 4 units
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function build(): { svg: string; width: number; height: number } {
  // Font-pixel runs per letter, as path commands.
  const paths: Array<{ level: number; d: string }> = [];
  let col = 0;
  [...WORD].forEach((ch, i) => {
    const rows = GLYPHS[ch] as string[];
    let d = "";
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== "#") {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < row.length && row[end] === "#") end++;
        d += `M${(col + x) * PX} ${y * PX}h${(end - x) * PX}v${PX}h-${(end - x) * PX}z`;
        x = end;
      }
    });
    paths.push({ level: DENSITY[i] as number, d });
    col += (rows[0] as string).length + 1;
  });
  const width = (col - 1) * PX;
  const height = 7 * PX;

  // One pattern per density: a 4×4-dot tile lit where the Bayer value is below the level.
  const levels = [...new Set(DENSITY)];
  const tile = 4 * PITCH;
  const patterns = levels
    .map((level) => {
      let rects = "";
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          if ((BAYER[y] as number[])[x] as number < level) rects += `<rect x="${x * PITCH}" y="${y * PITCH}" width="${DOT}" height="${DOT}"/>`;
        }
      }
      return `<pattern id="fbw-${level}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><g fill="#EDEDED">${rects}</g></pattern>`;
    })
    .join("");

  // Merge letters that share a density into one path.
  const byLevel = new Map<number, string>();
  for (const p of paths) byLevel.set(p.level, (byLevel.get(p.level) ?? "") + p.d);
  const letters = [...byLevel.entries()].map(([level, d]) => `<path fill="url(#fbw-${level})" d="${d}"/>`).join("");

  const svg =
    `<svg class="wordmark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Freeband" xmlns="http://www.w3.org/2000/svg">` +
    `<title>Freeband</title><defs>` +
    `<pattern id="fbw-off" width="${PITCH}" height="${PITCH}" patternUnits="userSpaceOnUse"><rect width="${DOT}" height="${DOT}" fill="#1F1F1F"/></pattern>` +
    patterns +
    `</defs><rect width="${width}" height="${height}" fill="url(#fbw-off)"/>${letters}</svg>`;
  return { svg, width, height };
}

export const WORDMARK = build();
