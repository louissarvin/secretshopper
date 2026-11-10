/** Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF, a leading BOM) into rows of fields. */
export function parseCsv(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ''
  let quoted = false
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) rows.push([...row, field])
  return rows
}

// The API prefixes formula-like cells with ' for spreadsheets (OWASP CSV injection); a table shows the value.
const GUARDED = /^'[=+\-@\t\r]/

/** CSV text with a header row into objects keyed by column name. */
export function csvObjects(text: string): Array<Record<string, string>> {
  const [head = [], ...rest] = parseCsv(text)
  return rest
    .filter((r) => r.some(Boolean))
    .map((r) =>
      Object.fromEntries(
        head.map((h, i) => {
          const v = r[i] ?? ''
          return [h, GUARDED.test(v) ? v.slice(1) : v]
        }),
      ),
    )
}
