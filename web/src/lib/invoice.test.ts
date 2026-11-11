// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildInvoice, isTemplate, payeesOf } from './invoice'

const f = {
  number: 'NW-2026-0230',
  total: '1.10',
  description: 'Toner, 2 cartridges',
  due: '2026-12-12',
  payee: 'northwind.ss-owner-e9c3db.testnet',
  billTo: 'Demo Co',
  today: '2026-11-12',
}

describe('buildInvoice keeps each vendor layout', () => {
  it('lines layout with pay_to', () => {
    const doc = buildInvoice(
      {
        due: '2026-11-02',
        lines: [{ qty: 1, unit_price: '0.92', description: 'Paper' }],
        total: '0.92',
        issued: '2026-10-03',
        number: 'NW-2026-0187',
        pay_to: '<account>',
        bill_to: '<company>',
        currency: 'USDC',
      },
      f,
    )
    expect(doc).toEqual({
      due: '2026-12-12',
      lines: [
        { qty: 1, unit_price: '1.10', description: 'Toner, 2 cartridges' },
      ],
      total: '1.10',
      issued: '2026-11-12',
      number: 'NW-2026-0230',
      pay_to: 'northwind.ss-owner-e9c3db.testnet',
      bill_to: 'Demo Co',
      currency: 'USDC',
    })
  })

  it('items layout with remit_to and a recent period', () => {
    const doc = buildInvoice(
      {
        items: [{ sku: 'vm-small', hours: 720, amount: '1.44' }],
        total: '1.44',
        period: '2026-09',
        currency: 'USDC',
        remit_to: '<account>',
        amount_due: '1.44',
        invoice_no: 'CC-55120',
      },
      { ...f, number: 'CC-55700', total: '1.10' },
    )
    expect(doc.items).toEqual([{ sku: 'vm-small', hours: 550, amount: '1.10' }])
    expect(doc).toMatchObject({
      period: '2026-10',
      remit_to: f.payee,
      total: '1.10',
      amount_due: '1.10',
      invoice_no: 'CC-55700',
    })
  })

  it('nested payment.account and a single service', () => {
    const doc = buildInvoice(
      {
        ref: 'FAB/10/2026/044',
        total: '1.75',
        payment: { terms: 'net 14', account: '<account>' },
        service: 'Office cleaning, October',
        currency: 'USDC',
      },
      { ...f, number: 'FAB/11/2026/050' },
    )
    expect(doc).toEqual({
      ref: 'FAB/11/2026/050',
      total: '1.10',
      payment: { terms: 'net 14', account: f.payee },
      service: 'Toner, 2 cartridges',
      currency: 'USDC',
    })
  })
})

describe('sample safety', () => {
  it('finds every payee field, including a hard-coded one', () => {
    expect(payeesOf({ pay_to: 'a.testnet' })).toEqual(['a.testnet'])
    expect(payeesOf({ payment: { account: 'b.testnet' } })).toEqual([
      'b.testnet',
    ])
    expect(
      payeesOf(
        buildInvoice(
          { pay_to: '<account>', remit_to: 'attacker.testnet', total: '1' },
          f,
        ),
      ),
    ).toEqual([f.payee, 'attacker.testnet'])
  })

  it('accepts only plain objects as templates', () => {
    expect(isTemplate({ a: 1 })).toBe(true)
    expect(isTemplate([])).toBe(false)
    expect(isTemplate('x')).toBe(false)
    expect(isTemplate(null)).toBe(false)
  })
})
