import { describe, expect, test } from 'bun:test'
import { detectLabels } from '../../worker/src/auto-label.js'

describe('detectLabels', () => {
  test('returns newsletter when List-Unsubscribe header present', () => {
    const labels = detectLabels('news@company.com', { 'List-Unsubscribe': '<mailto:unsub@company.com>' }, null)
    expect(labels).toContain('newsletter')
    expect(labels).not.toContain('personal')
  })

  test('returns newsletter when List-Id header present', () => {
    const labels = detectLabels('news@company.com', { 'List-Id': '<list.company.com>' }, null)
    expect(labels).toContain('newsletter')
  })

  test('returns notification for noreply@ sender', () => {
    const labels = detectLabels('noreply@service.com', {}, null)
    expect(labels).toContain('notification')
    expect(labels).not.toContain('personal')
  })

  test('returns notification for no-reply@ sender', () => {
    const labels = detectLabels('no-reply@service.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns notification for no_reply@ sender', () => {
    const labels = detectLabels('no_reply@service.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns notification for notifications@ sender', () => {
    const labels = detectLabels('notifications@github.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns notification for alerts@ sender', () => {
    const labels = detectLabels('alerts@monitoring.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns code when verification code is present', () => {
    const labels = detectLabels('noreply@service.com', {}, '123456')
    expect(labels).toContain('code')
    expect(labels).toContain('notification')
  })

  test('returns multiple labels when applicable', () => {
    const labels = detectLabels('noreply@service.com', { 'List-Unsubscribe': '<url>' }, '9876')
    expect(labels).toContain('newsletter')
    expect(labels).toContain('notification')
    expect(labels).toContain('code')
    expect(labels).not.toContain('personal')
  })

  test('returns personal when no other labels match', () => {
    const labels = detectLabels('alice@example.com', {}, null)
    expect(labels).toEqual(['personal'])
  })

  test('returns personal for regular sender with no special headers', () => {
    const labels = detectLabels('bob@company.com', { 'Subject': 'Hello' }, null)
    expect(labels).toEqual(['personal'])
  })

  test('detects newsletter with lowercase list-unsubscribe header', () => {
    const labels = detectLabels('news@company.com', { 'list-unsubscribe': '<mailto:unsub@company.com>' }, null)
    expect(labels).toContain('newsletter')
  })

  test('detects newsletter with mixed-case LIST-UNSUBSCRIBE header', () => {
    const labels = detectLabels('news@company.com', { 'LIST-UNSUBSCRIBE': '<mailto:unsub@company.com>' }, null)
    expect(labels).toContain('newsletter')
  })

  test('detects newsletter with lowercase list-id header', () => {
    const labels = detectLabels('news@company.com', { 'list-id': '<list.company.com>' }, null)
    expect(labels).toContain('newsletter')
  })

  test('returns notification for no.reply@ sender', () => {
    const labels = detectLabels('no.reply@service.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns notification for mailer-daemon@ sender', () => {
    const labels = detectLabels('mailer-daemon@example.com', {}, null)
    expect(labels).toContain('notification')
  })

  test('returns notification for bounce@ sender', () => {
    const labels = detectLabels('bounce@example.com', {}, null)
    expect(labels).toContain('notification')
  })
})
