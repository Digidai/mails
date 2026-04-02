import { send } from '../../core/send.js'
import { getInbox } from '../../core/receive.js'
import { loadConfig } from '../../core/config.js'
import { doctorCommand } from './doctor.js'

export async function demoCommand() {
  const config = loadConfig()
  const mailbox = config.mailbox

  if (!mailbox) {
    console.error('No mailbox configured. Run: mails claim <name>')
    process.exit(1)
  }

  console.log('')
  console.log('  mails demo')
  console.log('  ──────────')
  console.log(`  Sending test email to ${mailbox}...`)

  try {
    await send({
      to: mailbox,
      subject: 'mails-agent demo',
      text: `This email was sent by "mails demo" at ${new Date().toISOString()}.\n\nYour agent can now send and receive email.`,
    })
  } catch (err) {
    console.error(`  ✗ Send failed: ${err instanceof Error ? err.message : err}`)
    console.error('')
    console.error('  Running diagnostics...')
    await doctorCommand()
    process.exit(1)
  }

  console.log('  ✓ Email sent. Waiting for it to arrive...')

  // Poll inbox until the demo email appears (max 30 seconds)
  const deadline = Date.now() + 30_000
  const since = new Date(Date.now() - 5000).toISOString() // 5s buffer

  while (Date.now() < deadline) {
    try {
      const emails = await getInbox(mailbox, { limit: 5 })
      const found = emails.find(
        (e) => e.subject === 'mails-agent demo' && e.received_at > since,
      )
      if (found) {
        console.log('')
        console.log(`  ✓ Email received!`)
        console.log(`    From:    ${found.from_address}`)
        console.log(`    Subject: ${found.subject}`)
        console.log(`    Date:    ${found.received_at}`)
        console.log('')
        console.log('  Demo complete! Your agent can now send and receive email.')
        console.log('')
        return
      }
    } catch {
      // Ignore fetch errors during polling
    }
    await new Promise((r) => setTimeout(r, 2000))
    process.stderr.write('.')
  }

  // Timeout — auto-diagnose
  console.log('')
  console.error('  ⚠ Email not received within 30 seconds.')
  console.error('    This can happen if Cloudflare Email Routing is still propagating.')
  console.error('    Check your inbox manually: mails inbox')
  console.error('')
  console.error('  Running diagnostics...')
  await doctorCommand()
}
