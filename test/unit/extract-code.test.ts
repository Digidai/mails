import { describe, expect, test } from 'bun:test'
import { extractCode } from '../../worker/src/extract-code'

describe('extractCode', () => {
  test('extracts Chinese verification code', () => {
    expect(extractCode('您的验证码：123456')).toBe('123456')
    expect(extractCode('您的验证码: 789012')).toBe('789012')
    expect(extractCode('确认码：ABCD12')).toBe('ABCD12')
  })

  test('extracts English verification code', () => {
    expect(extractCode('Your verification code is 654321')).toBe('654321')
    expect(extractCode('Your verification code: 111222')).toBe('111222')
    expect(extractCode('confirmation code: 998877')).toBe('998877')
    expect(extractCode('security code: 4455')).toBe('4455')
    expect(extractCode('Your OTP: 7890')).toBe('7890')
    expect(extractCode('passcode: 5678')).toBe('5678')
    expect(extractCode('pin code: 9012')).toBe('9012')
  })

  test('extracts Japanese verification code', () => {
    expect(extractCode('認証コード：345678')).toBe('345678')
  })

  test('extracts Korean verification code', () => {
    expect(extractCode('인증 코드: 456789')).toBe('456789')
  })

  test('extracts "code is/:" pattern', () => {
    expect(extractCode('Your code is 112233')).toBe('112233')
    expect(extractCode('code: ABCDEF')).toBe('ABCDEF')
  })

  test('extracts standalone digit codes', () => {
    expect(extractCode('Please enter 5678 to verify')).toBe('5678')
    expect(extractCode(' 12345678 ')).toBe('12345678')
  })

  test('returns null when no code found', () => {
    expect(extractCode('Hello, this is a regular email')).toBeNull()
    expect(extractCode('')).toBeNull()
    expect(extractCode('Short 12')).toBeNull()
  })

  test('handles mixed content', () => {
    expect(extractCode('Subject: Login 验证码：998877 please check')).toBe('998877')
  })

  test('does not capture word after "verification code" when numeric code follows', () => {
    // Regression: subject "Your verification code" + body "Your code is 824593" was
    // capturing "Your" because the first pattern allowed whitespace as delimiter.
    expect(extractCode('Your verification code Your code is 824593. Valid for 10 minutes.')).toBe('824593')
  })

  test('does not match word tokens after label', () => {
    // The label "verification code" followed by "Your" (a word) should NOT be captured.
    expect(extractCode('verification code Your email is ready')).toBeNull()
  })

  test('still captures numeric code after label without colon', () => {
    expect(extractCode('verification code is 987654')).toBe('987654')
  })

  test('rejects 4-digit years (1900-2099) as false positive', () => {
    // Real-world case: subject "Order Confirmation #ABC-12345" got code: "2026"
    expect(extractCode('Order Confirmation #ABC-12345 sent on 2026-04-11')).toBeNull()
    expect(extractCode('Receipt dated 1999')).toBeNull()
    expect(extractCode('Thanks for joining us in 2024!')).toBeNull()
  })

  test('rejects 8-digit YYYYMMDD dates as false positive', () => {
    // Real-world case: "QA LANG JA 20260411" got code: "20260411"
    expect(extractCode('QA LANG JA 20260411')).toBeNull()
    expect(extractCode('Date: 19991231')).toBeNull()
    expect(extractCode('reference 20260101 please')).toBeNull()
  })

  test('still extracts 5-7 digit codes that happen to fall in year range', () => {
    // 12345, 123456 etc are not years, should still be extracted
    expect(extractCode('code is 12345')).toBe('12345')
    expect(extractCode('code is 123456')).toBe('123456')
  })

  test('extracts Chinese code with 是： (dual delimiter)', () => {
    // Real-world case: "您的验证码是：654321" was returning null
    expect(extractCode('您好，您的验证码是：654321。请勿泄露。')).toBe('654321')
    expect(extractCode('您的验证码是 654321')).toBe('654321')
    expect(extractCode('您的验证码为：987654')).toBe('987654')
  })

  test('extracts Japanese code with です suffix', () => {
    expect(extractCode('認証コードは 456789 です')).toBe('456789')
  })

  test('rejects year/date even when after code keyword', () => {
    // "Your code is 2026" should still reject 2026 as year
    expect(extractCode('Subject mentions code 2026 year')).toBeNull()
  })
})
