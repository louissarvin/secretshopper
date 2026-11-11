// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { csvObjects, parseCsv } from './csv'

describe('ledger CSV parsing', () => {
  it('handles the BOM, quotes, doubled quotes, commas and CRLF', () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""no"""\r\n2,"line\r\nbreak",\r\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "no"'],
      ['2', 'line\r\nbreak', ''],
    ])
  })

  it('maps rows to columns and removes the formula guard for display', () => {
    const rows = csvObjects(
      "type,note\r\ndecline,'=HYPERLINK(1)\r\npay,'quoted\r\n",
    )
    expect(rows).toEqual([
      { type: 'decline', note: '=HYPERLINK(1)' },
      { type: 'pay', note: "'quoted" },
    ])
  })
})
