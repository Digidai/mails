import type { Env } from '../types'

/**
 * Custom domain management handler.
 *
 * POST /v1/domains — register a new domain, returns required DNS records
 * GET /v1/domains — list domains and their verification status
 * POST /v1/domains/:id/verify — trigger manual verification check
 * DELETE /v1/domains/:id — remove a domain
 */

interface DomainRecord {
  id: string
  domain: string
  status: string // pending | dns_verified | verified | failed
  mx_verified: number
  spf_verified: number
  dkim_verified: number
  created_at: string
  verified_at: string | null
}

/**
 * Returns the DNS records a user needs to configure for a custom domain.
 */
function getDnsRecords(domain: string) {
  return {
    mx: {
      type: 'MX',
      host: domain,
      value: 'isaac.mx.cloudflare.net',
      priority: 10,
      purpose: 'Route inbound email to Cloudflare Email Routing',
    },
    spf: {
      type: 'TXT',
      host: domain,
      value: 'v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all',
      purpose: 'Authorize Resend (via SES) and Cloudflare to send on your behalf',
    },
    dmarc: {
      type: 'TXT',
      host: `_dmarc.${domain}`,
      value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@mails0.com',
      purpose: 'DMARC policy for authentication failure handling (recommended)',
    },
  }
}

export async function handleDomains(
  request: Request,
  url: URL,
  env: Env,
  mailbox?: string,
): Promise<Response> {
  // Extract domain ID from path: /api/domains/:id or /api/domains/:id/verify
  const pathParts = url.pathname.replace(/^\/(v1|api)\//, '').split('/')
  const domainId = pathParts[1] || null
  const action = pathParts[2] || null

  if (request.method === 'GET' && !domainId) {
    // List domains (scoped to mailbox when available)
    const rows = mailbox
      ? await env.DB.prepare(
          'SELECT * FROM domains WHERE mailbox = ? OR mailbox IS NULL ORDER BY created_at DESC'
        ).bind(mailbox).all<DomainRecord>()
      : await env.DB.prepare(
          'SELECT * FROM domains ORDER BY created_at DESC'
        ).all<DomainRecord>()

    return Response.json({
      domains: (rows.results ?? []).map(d => ({
        id: d.id,
        domain: d.domain,
        status: d.status,
        mx_verified: !!d.mx_verified,
        spf_verified: !!d.spf_verified,
        dkim_verified: !!d.dkim_verified,
        created_at: d.created_at,
        verified_at: d.verified_at,
      })),
    })
  }

  if (request.method === 'POST' && !domainId) {
    // Register new domain
    let body: { domain: string }
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const domain = body.domain?.toLowerCase().trim()
    if (!domain || !domain.includes('.') || domain.length > 253) {
      return Response.json({ error: 'Invalid domain' }, { status: 400 })
    }

    // Check if already registered
    const existing = await env.DB.prepare(
      'SELECT id FROM domains WHERE domain = ?'
    ).bind(domain).first()
    if (existing) {
      return Response.json({ error: 'Domain already registered' }, { status: 409 })
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    await env.DB.prepare(
      'INSERT INTO domains (id, domain, mailbox, status, mx_verified, spf_verified, dkim_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)'
    ).bind(id, domain, mailbox ?? null, 'pending', now).run()

    const records = getDnsRecords(domain)

    return Response.json({
      id,
      domain,
      status: 'pending',
      dns_records: records,
      instructions: `Add these DNS records to ${domain}, then POST /v1/domains/${id}/verify to check.`,
    }, { status: 201 })
  }

  if (request.method === 'GET' && domainId && !action) {
    // Get single domain with DNS records (scoped to mailbox)
    const row = mailbox
      ? await env.DB.prepare(
          'SELECT * FROM domains WHERE id = ? AND (mailbox = ? OR mailbox IS NULL)'
        ).bind(domainId, mailbox).first<DomainRecord>()
      : await env.DB.prepare(
          'SELECT * FROM domains WHERE id = ?'
        ).bind(domainId).first<DomainRecord>()
    if (!row) {
      return Response.json({ error: 'Domain not found' }, { status: 404 })
    }

    const records = getDnsRecords(row.domain)
    return Response.json({
      id: row.id,
      domain: row.domain,
      status: row.status,
      mx_verified: !!row.mx_verified,
      spf_verified: !!row.spf_verified,
      dkim_verified: !!row.dkim_verified,
      created_at: row.created_at,
      verified_at: row.verified_at,
      dns_records: records,
    })
  }

  if (request.method === 'POST' && domainId && action === 'verify') {
    // Manual verification trigger (scoped to mailbox)
    const row = mailbox
      ? await env.DB.prepare(
          'SELECT * FROM domains WHERE id = ? AND (mailbox = ? OR mailbox IS NULL)'
        ).bind(domainId, mailbox).first<DomainRecord>()
      : await env.DB.prepare(
          'SELECT * FROM domains WHERE id = ?'
        ).bind(domainId).first<DomainRecord>()
    if (!row) {
      return Response.json({ error: 'Domain not found' }, { status: 404 })
    }

    // Check MX record via DNS
    let mxOk = false
    let spfOk = false
    try {
      // Use Cloudflare DNS-over-HTTPS to verify records
      const mxRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${row.domain}&type=MX`, {
        headers: { 'Accept': 'application/dns-json' },
      })
      const mxData = await mxRes.json() as { Answer?: Array<{ data: string }> }
      mxOk = (mxData.Answer ?? []).some(a => a.data.includes('cloudflare.net'))

      const txtRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${row.domain}&type=TXT`, {
        headers: { 'Accept': 'application/dns-json' },
      })
      const txtData = await txtRes.json() as { Answer?: Array<{ data: string }> }
      spfOk = (txtData.Answer ?? []).some(a => a.data.includes('amazonses.com'))
    } catch (err) {
      console.error(`DNS verification failed for ${row.domain}: ${err}`)
    }

    const newStatus = (mxOk && spfOk) ? 'dns_verified' : 'pending'
    const now = new Date().toISOString()

    await env.DB.prepare(
      'UPDATE domains SET mx_verified = ?, spf_verified = ?, status = ?, verified_at = ? WHERE id = ?'
    ).bind(mxOk ? 1 : 0, spfOk ? 1 : 0, newStatus, newStatus === 'dns_verified' ? now : null, domainId).run()

    return Response.json({
      id: row.id,
      domain: row.domain,
      status: newStatus,
      mx_verified: mxOk,
      spf_verified: spfOk,
      message: newStatus === 'dns_verified'
        ? 'Domain verified! You can now create mailboxes on this domain.'
        : `Verification incomplete. MX: ${mxOk ? 'OK' : 'MISSING'}, SPF: ${spfOk ? 'OK' : 'MISSING'}`,
    })
  }

  if (request.method === 'DELETE' && domainId) {
    // Delete domain (scoped to mailbox)
    const result = mailbox
      ? await env.DB.prepare('DELETE FROM domains WHERE id = ? AND (mailbox = ? OR mailbox IS NULL)').bind(domainId, mailbox).run()
      : await env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(domainId).run()
    if (!result.meta.changes) {
      return Response.json({ error: 'Domain not found' }, { status: 404 })
    }
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}
