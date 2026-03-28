import { describe, expect, test } from 'bun:test'
import { extractStructuredData } from '../../worker/src/extract-data.js'

describe('extractStructuredData', () => {
  describe('order extraction', () => {
    test('extracts order ID and total', () => {
      const result = extractStructuredData(
        'order',
        'Your order confirmation #ABC-12345',
        'Thank you for your purchase!\nOrder #ABC-12345\nTotal: $59.99\nItems shipped to your address.',
        'orders@amazon.com',
        'Amazon',
        []
      )
      expect(result.type).toBe('order')
      if (result.type === 'order') {
        expect(result.order_id).toBe('ABC-12345')
        expect(result.total).toBe('59.99')
        expect(result.currency).toBe('USD')
        expect(result.merchant).toBe('Amazon')
      }
    })

    test('extracts order from confirmation number format', () => {
      const result = extractStructuredData(
        'order',
        'Your order has been confirmed',
        'Confirmation #W9876543\nTotal: $129.00\nThank you.',
        'shop@store.com',
        'Store',
        []
      )
      if (result.type === 'order') {
        expect(result.order_id).toBe('W9876543')
        expect(result.total).toBe('129.00')
      }
    })

    test('handles missing order data gracefully', () => {
      const result = extractStructuredData(
        'order',
        'Thanks for shopping',
        'We hope you enjoy your purchase.',
        'shop@store.com',
        'Store',
        []
      )
      if (result.type === 'order') {
        expect(result.order_id).toBeNull()
        expect(result.total).toBeNull()
        expect(result.merchant).toBe('Store')
      }
    })
  })

  describe('shipping extraction', () => {
    test('extracts UPS tracking number', () => {
      const result = extractStructuredData(
        'shipping',
        'Your package has shipped',
        'Tracking number: 1Z999AA10123456784\nEstimated delivery: March 30, 2026',
        'shipping@ups.com',
        'UPS',
        []
      )
      if (result.type === 'shipping') {
        expect(result.tracking_number).toBe('1Z999AA10123456784')
        expect(result.carrier).toBe('UPS')
        expect(result.status).toBe('shipped')
      }
    })

    test('extracts generic tracking number', () => {
      const result = extractStructuredData(
        'shipping',
        'Shipped!',
        'Your tracking number: ABCD12345678',
        'noreply@shop.com',
        'Shop',
        []
      )
      if (result.type === 'shipping') {
        expect(result.tracking_number).toBe('ABCD12345678')
        expect(result.status).toBe('shipped')
      }
    })

    test('detects delivered status', () => {
      const result = extractStructuredData(
        'shipping',
        'Your package was delivered',
        'Your package has been delivered to your doorstep.',
        'noreply@carrier.com',
        'Carrier',
        []
      )
      if (result.type === 'shipping') {
        expect(result.status).toBe('delivered')
      }
    })
  })

  describe('calendar extraction', () => {
    test('parses ICS attachment', () => {
      const ics = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'SUMMARY:Team Standup',
        'DTSTART:20260401T100000Z',
        'DTEND:20260401T103000Z',
        'LOCATION:Conference Room A',
        'ATTENDEE;CN=Alice:mailto:alice@example.com',
        'ATTENDEE;CN=Bob:mailto:bob@example.com',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')

      const result = extractStructuredData(
        'calendar',
        'Meeting invite',
        'You have been invited',
        'calendar@company.com',
        'Company',
        [{ content_type: 'text/calendar', text_content: ics }]
      )
      if (result.type === 'calendar') {
        expect(result.title).toBe('Team Standup')
        expect(result.date).toBe('2026-04-01')
        expect(result.time).toBe('10:00')
        expect(result.location).toBe('Conference Room A')
        expect(result.attendees).toContain('alice@example.com')
        expect(result.attendees).toContain('bob@example.com')
      }
    })

    test('extracts from body text when no ICS', () => {
      const result = extractStructuredData(
        'calendar',
        'Meeting: Project Review',
        'Event: Project Review\nDate: April 5, 2026\nTime: 2:00 PM\nLocation: Room 301',
        'calendar@company.com',
        'Company',
        []
      )
      if (result.type === 'calendar') {
        expect(result.date).toBe('April 5, 2026')
        expect(result.time).toBe('2:00 PM')
        expect(result.location).toBe('Room 301')
      }
    })
  })

  describe('receipt extraction', () => {
    test('extracts amount and merchant', () => {
      const result = extractStructuredData(
        'receipt',
        'Receipt from Acme Corp',
        'Payment received\nAmount: $42.50\nDate: March 28, 2026\nPaid with: Visa ending 4242',
        'billing@acme.com',
        'Acme Corp',
        []
      )
      if (result.type === 'receipt') {
        expect(result.merchant).toBe('Acme Corp')
        expect(result.amount).toBe('42.50')
        expect(result.currency).toBe('USD')
        expect(result.date).toBe('March 28, 2026')
        expect(result.payment_method).toBe('Visa ending 4242')
      }
    })

    test('handles EUR amounts', () => {
      const result = extractStructuredData(
        'receipt',
        'Invoice',
        'Total: 99.99 EUR',
        'pay@eu-shop.com',
        'EU Shop',
        []
      )
      if (result.type === 'receipt') {
        expect(result.amount).toBe('99.99')
        expect(result.currency).toBe('EUR')
      }
    })
  })

  describe('code extraction', () => {
    test('extracts verification code', () => {
      const result = extractStructuredData(
        'code',
        'Your verification code',
        'Your verification code is 847293',
        'noreply@service.com',
        'Service',
        []
      )
      if (result.type === 'code') {
        expect(result.code).toBe('847293')
      }
    })

    test('returns null when no code found', () => {
      const result = extractStructuredData(
        'code',
        'Welcome',
        'Thanks for signing up!',
        'hello@service.com',
        'Service',
        []
      )
      if (result.type === 'code') {
        expect(result.code).toBeNull()
      }
    })
  })
})
