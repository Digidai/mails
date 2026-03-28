/**
 * Rule-based structured data extraction from email content.
 * No LLM dependency — all regex/pattern-based.
 */

import { extractCode } from './extract-code.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractionType = 'order' | 'shipping' | 'calendar' | 'receipt' | 'code'

export interface OrderExtraction {
  type: 'order'
  order_id: string | null
  total: string | null
  currency: string | null
  merchant: string | null
  items: string[]
}

export interface ShippingExtraction {
  type: 'shipping'
  tracking_number: string | null
  carrier: string | null
  eta: string | null
  status: string | null
}

export interface CalendarExtraction {
  type: 'calendar'
  title: string | null
  date: string | null
  time: string | null
  location: string | null
  attendees: string[]
}

export interface ReceiptExtraction {
  type: 'receipt'
  merchant: string | null
  amount: string | null
  currency: string | null
  date: string | null
  payment_method: string | null
}

export interface CodeExtraction {
  type: 'code'
  code: string | null
}

export type ExtractionResult =
  | OrderExtraction
  | ShippingExtraction
  | CalendarExtraction
  | ReceiptExtraction
  | CodeExtraction

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function extractStructuredData(
  type: ExtractionType,
  subject: string,
  bodyText: string,
  fromAddress: string,
  fromName: string,
  attachments: Array<{ content_type: string; text_content: string }>
): ExtractionResult {
  const text = `${subject}\n${bodyText}`

  switch (type) {
    case 'order':
      return extractOrder(text, fromName, fromAddress)
    case 'shipping':
      return extractShipping(text)
    case 'calendar':
      return extractCalendar(text, attachments)
    case 'receipt':
      return extractReceipt(text, subject, fromName, fromAddress)
    case 'code':
      // Try body first (more specific), then combined text
      return { type: 'code', code: extractCode(bodyText) ?? extractCode(subject) }
  }
}

// ---------------------------------------------------------------------------
// Order extraction
// ---------------------------------------------------------------------------

function extractOrder(text: string, fromName: string, fromAddress: string): OrderExtraction {
  // Match "order #ABC-123" or "order number ABC-123" — require # or explicit keyword before the ID
  const orderIdMatch = text.match(/(?:order|confirmation)\s*(?:#|number|id|no\.)\s*:?\s*([A-Z0-9][\w-]{3,19})/i)
  const totalMatch = text.match(/(?:total|amount|charged|grand\s*total)[:\s]*(?:\$|€|£|¥)?\s*([\d,]+\.\d{2})/i)
  const currencyMatch = text.match(/(?:USD|EUR|GBP|JPY|CNY|CAD|AUD|\$|€|£|¥)/i)

  return {
    type: 'order',
    order_id: orderIdMatch?.[1] ?? null,
    total: totalMatch?.[1]?.replace(/,/g, '') ?? null,
    currency: normalizeCurrency(currencyMatch?.[0] ?? null),
    merchant: fromName?.trim() || fromAddress.split('@')[0] || null,
    items: [],
  }
}

// ---------------------------------------------------------------------------
// Shipping extraction
// ---------------------------------------------------------------------------

const TRACKING_PATTERNS: Array<{ carrier: string; pattern: RegExp }> = [
  { carrier: 'UPS', pattern: /\b(1Z[A-Z0-9]{16})\b/i },
  { carrier: 'FedEx', pattern: /\b(\d{12,22})\b/ },
  { carrier: 'USPS', pattern: /\b(9[2-5]\d{18,22})\b/ },
  { carrier: 'DHL', pattern: /\b(\d{10,11})\b/ },
]

function extractShipping(text: string): ShippingExtraction {
  let trackingNumber: string | null = null
  let carrier: string | null = null

  // Try carrier-specific patterns
  for (const { carrier: c, pattern } of TRACKING_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      trackingNumber = match[1]
      carrier = c
      break
    }
  }

  // Fallback: generic "tracking" keyword nearby a number
  if (!trackingNumber) {
    const genericMatch = text.match(/tracking\s*(?:#|number|id|no\.?)?[\s:]*([A-Z0-9]{8,30})/i)
    if (genericMatch) {
      trackingNumber = genericMatch[1]
    }
  }

  // Carrier detection from text if not already found
  if (!carrier && trackingNumber) {
    if (/\bups\b/i.test(text)) carrier = 'UPS'
    else if (/\bfedex\b/i.test(text)) carrier = 'FedEx'
    else if (/\busps\b/i.test(text)) carrier = 'USPS'
    else if (/\bdhl\b/i.test(text)) carrier = 'DHL'
  }

  // ETA extraction
  const etaMatch = text.match(/(?:deliver|arrival|eta|expected|estimated)[:\s]*(?:by\s+)?(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)

  // Shipping status
  let status: string | null = null
  if (/\bdelivered\b/i.test(text)) status = 'delivered'
  else if (/\bout for delivery\b/i.test(text)) status = 'out_for_delivery'
  else if (/\bin transit\b/i.test(text)) status = 'in_transit'
  else if (/\bshipped\b/i.test(text)) status = 'shipped'

  return {
    type: 'shipping',
    tracking_number: trackingNumber,
    carrier,
    eta: etaMatch?.[1] ?? null,
    status,
  }
}

// ---------------------------------------------------------------------------
// Calendar extraction
// ---------------------------------------------------------------------------

function extractCalendar(
  text: string,
  attachments: Array<{ content_type: string; text_content: string }>
): CalendarExtraction {
  // Try ICS attachment first
  const icsAttachment = attachments.find(
    (a) => a.content_type === 'text/calendar' || a.content_type === 'application/ics'
  )

  if (icsAttachment?.text_content) {
    return parseICS(icsAttachment.text_content)
  }

  // Fallback: extract from body text
  const titleMatch = text.match(/(?:subject|event|meeting|invitation)[:\s]+(.+?)(?:\n|$)/i)
  const dateMatch = text.match(/(?:date|when)[:\s]+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)
  const timeMatch = text.match(/(?:time|at)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i)
  const locationMatch = text.match(/(?:location|where|venue|place)[:\s]+(.+?)(?:\n|$)/i)

  return {
    type: 'calendar',
    title: titleMatch?.[1]?.trim() ?? null,
    date: dateMatch?.[1]?.trim() ?? null,
    time: timeMatch?.[1]?.trim() ?? null,
    location: locationMatch?.[1]?.trim() ?? null,
    attendees: [],
  }
}

function parseICS(ics: string): CalendarExtraction {
  const get = (key: string): string | null => {
    const match = ics.match(new RegExp(`^${key}[;:](.+)$`, 'im'))
    return match?.[1]?.trim() ?? null
  }

  const dtStart = get('DTSTART')
  let date: string | null = null
  let time: string | null = null
  if (dtStart) {
    // Parse YYYYMMDDTHHMMSS or YYYYMMDD format
    const dtMatch = dtStart.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/)
    if (dtMatch) {
      date = `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`
      if (dtMatch[4] && dtMatch[5]) {
        time = `${dtMatch[4]}:${dtMatch[5]}`
      }
    }
  }

  const attendees: string[] = []
  const attendeeMatches = ics.matchAll(/^ATTENDEE[^:]*:mailto:(.+)$/gim)
  for (const m of attendeeMatches) {
    attendees.push(m[1].trim())
  }

  return {
    type: 'calendar',
    title: get('SUMMARY'),
    date,
    time,
    location: get('LOCATION'),
    attendees,
  }
}

// ---------------------------------------------------------------------------
// Receipt extraction
// ---------------------------------------------------------------------------

function extractReceipt(text: string, subject: string, fromName: string, fromAddress: string): ReceiptExtraction {
  const amountMatch = text.match(/(?:\$|€|£|¥)\s*([\d,]+\.\d{2})|([\d,]+\.\d{2})\s*(?:USD|EUR|GBP|JPY|CNY)/i)
  const currencyMatch = text.match(/(?:USD|EUR|GBP|JPY|CNY|CAD|AUD|\$|€|£|¥)/i)
  const dateMatch = text.match(/(?:date|on|dated)[:\s]+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)
  const paymentMatch = text.match(/(?:paid\s+(?:with|via|by)|payment\s+method|card\s+ending)[:\s]+(.+?)(?:\n|$)/i)

  return {
    type: 'receipt',
    merchant: fromName?.trim() || fromAddress.split('@')[0] || null,
    amount: amountMatch?.[1]?.replace(/,/g, '') ?? amountMatch?.[2]?.replace(/,/g, '') ?? null,
    currency: normalizeCurrency(currencyMatch?.[0] ?? null),
    date: dateMatch?.[1]?.trim() ?? null,
    payment_method: paymentMatch?.[1]?.trim() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCurrency(raw: string | null): string | null {
  if (!raw) return null
  const map: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }
  return map[raw] ?? raw.toUpperCase()
}
