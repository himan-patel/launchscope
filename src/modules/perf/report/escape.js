/**
 * Every string in a report can come from the site being measured (URLs, titles, console
 * messages), so all of it is escaped before it is placed in HTML, SVG, or CSV.
 */

const HTML_ESCAPES = /** @type {Record<string, string>} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escapes text for HTML/SVG element content and quoted attribute values.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Formats one CSV cell (RFC 4180). Cells that a spreadsheet would treat as a formula are
 * prefixed with an apostrophe so opening the file cannot execute anything (CSV injection).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {string[]} header
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
