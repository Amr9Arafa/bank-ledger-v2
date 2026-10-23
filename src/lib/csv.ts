// CSV that Excel opens correctly, Arabic included.

// Excel needs the UTF-8 byte order mark to read Arabic text.
export const UTF8_BOM = String.fromCharCode(0xfeff);

// Quotes a cell when needed. Text cells starting with = + - @ get a leading ' so a
// spreadsheet never runs them as formulas (CSV injection). Numbers ("-1250.50") pass through.
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  const isNumber = /^-?\d+(\.\d+)?$/.test(s);
  if (!isNumber && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return UTF8_BOM + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
