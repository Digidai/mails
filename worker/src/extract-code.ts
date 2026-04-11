/**
 * Extract verification codes (4-8 digit/alphanumeric) from text.
 * Covers common formats across English, Chinese, Japanese, Korean.
 */
export function extractCode(text: string): string | null {
  // Ordered by specificity: try numeric-first patterns, then alphanumeric.
  // Rationale: real verification codes are almost always numeric. Matching
  // alphanumeric first causes false positives like "Your" being captured
  // after "verification code " (where the next token is a word, not a code).
  const patterns = [
    // "code is 123456" / "code: 123456" — numeric only
    /\bcode\s*(?:is|:)\s*(\d{4,8})\b/i,
    // "验证码：123456" / "verification code: 123456" — numeric only, require explicit delimiter (colon, 是/为/is)
    /(?:验证码|verification\s*code|認証コード|确认码|confirm(?:ation)?\s*code|security\s*code|passcode|OTP|pin\s*code|인증\s*코드|코드)\s*(?:[:：]|is|\bis\b|为|是)\s*(\d{4,8})\b/i,
    // Alphanumeric with explicit "is" or colon delimiter
    /\bcode\s*(?:is|:)\s*([A-Za-z0-9]{4,8})\b/i,
    /(?:验证码|verification\s*code|認証コード|确认码|confirm(?:ation)?\s*code|security\s*code|passcode|OTP|pin\s*code|인증\s*코드|코드)\s*(?:[:：]|is|为|是)\s*([A-Za-z0-9]{4,8})\b/i,
    // Standalone 4-8 digit number (surrounded by whitespace/boundaries)
    /(?:^|\s)(\d{4,8})(?:\s|$|\.|,)/m,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}
