import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: opts?.silent ? 'pipe' : 'inherit' }).trim()
  } catch (err) {
    if (opts?.silent) return ''
    throw err
  }
}

function runCapture(cmd: string): { stdout: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim()
    return { stdout, ok: true }
  } catch (err: any) {
    return { stdout: err.stdout?.toString().trim() ?? '', ok: false }
  }
}

export async function deployCommand(args: string[]) {
  const workerDir = resolve(process.cwd(), 'worker')
  if (!existsSync(resolve(workerDir, 'wrangler.toml'))) {
    // Try to find worker dir relative to package
    const pkgWorkerDir = resolve(__dirname, '../../worker')
    if (existsSync(resolve(pkgWorkerDir, 'wrangler.toml'))) {
      process.chdir(pkgWorkerDir)
    } else {
      console.error('Cannot find worker/ directory. Run this from the mails project root, or cd into the worker/ directory first.')
      process.exit(1)
    }
  } else {
    process.chdir(workerDir)
  }

  console.log('')
  console.log('  mails deploy — one-click self-hosted setup')
  console.log('  ──────────────────────────────────────────')
  console.log('')

  // Step 1: Check wrangler
  console.log('  [1/7] Checking wrangler...')
  const wranglerCheck = runCapture('npx wrangler --version')
  if (!wranglerCheck.ok) {
    console.error('  wrangler not found. Install: npm install -g wrangler')
    process.exit(1)
  }
  console.log(`  wrangler ${wranglerCheck.stdout}`)

  // Step 2: Check Cloudflare auth
  console.log('  [2/7] Checking Cloudflare auth...')
  const authCheck = runCapture('npx wrangler whoami')
  if (!authCheck.ok || authCheck.stdout.includes('not authenticated')) {
    console.error('  Not logged in. Run: npx wrangler login')
    process.exit(1)
  }
  console.log('  Authenticated.')

  // Step 3: Create D1 database (skip if exists)
  console.log('  [3/7] Creating D1 database...')
  const d1List = runCapture('npx wrangler d1 list')
  if (d1List.stdout.includes('mails')) {
    console.log('  D1 database "mails" already exists.')
  } else {
    const d1Create = runCapture('npx wrangler d1 create mails')
    if (!d1Create.ok) {
      console.error('  Failed to create D1 database. Check your Cloudflare account.')
      process.exit(1)
    }
    console.log('  D1 database "mails" created.')
    // Extract database_id from output
    const idMatch = d1Create.stdout.match(/database_id\s*=\s*"([^"]+)"/)
    if (idMatch) {
      const dbId = idMatch[1]
      const tomlPath = resolve('wrangler.toml')
      let toml = readFileSync(tomlPath, 'utf-8')
      toml = toml.replace(/YOUR_D1_DATABASE_ID|REPLACE_WITH_YOUR_DATABASE_ID/, dbId!)
      writeFileSync(tomlPath, toml)
      console.log(`  Updated wrangler.toml with database_id: ${dbId!.slice(0, 8)}...`)
    }
  }

  // Step 4: Run schema migration
  console.log('  [4/7] Running schema migration...')
  const schemaResult = runCapture('npx wrangler d1 execute mails --file=schema.sql --remote')
  if (!schemaResult.ok) {
    console.error('  Schema migration failed. You may need to run it manually:')
    console.error('  npx wrangler d1 execute mails --file=schema.sql --remote')
  } else {
    console.log('  Schema applied.')
  }

  // Step 5: Set secrets
  console.log('  [5/7] Setting secrets...')
  console.log('  You will be prompted for each secret value.')
  console.log('')

  try {
    console.log('  Enter your Resend API key (re_...):')
    run('npx wrangler secret put RESEND_API_KEY')
  } catch {
    console.warn('  Skipped RESEND_API_KEY (you can set it later: npx wrangler secret put RESEND_API_KEY)')
  }

  // Generate random AUTH_TOKEN
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  console.log(`  Generated AUTH_TOKEN: ${token.slice(0, 8)}...`)
  try {
    execSync(`echo "${token}" | npx wrangler secret put AUTH_TOKEN`, { stdio: 'pipe' })
    console.log('  AUTH_TOKEN set.')
  } catch {
    console.warn(`  Failed to set AUTH_TOKEN. Set it manually: npx wrangler secret put AUTH_TOKEN`)
    console.warn(`  Value: ${token}`)
  }

  // Step 6: Deploy
  console.log('  [6/7] Deploying Worker...')
  const deployResult = runCapture('npx wrangler deploy')
  if (!deployResult.ok) {
    console.error('  Deploy failed. Check output above.')
    process.exit(1)
  }
  // Extract worker URL
  const urlMatch = deployResult.stdout.match(/https:\/\/[\w.-]+\.workers\.dev/)
  const workerUrl = urlMatch ? urlMatch[0] : 'https://mails-worker.<your-subdomain>.workers.dev'
  console.log(`  Deployed to: ${workerUrl}`)

  // Step 7: Print config commands
  console.log('  [7/7] Setup complete!')
  console.log('')
  console.log('  Run these commands to configure the CLI:')
  console.log('')
  console.log(`  mails config set worker_url ${workerUrl}`)
  console.log(`  mails config set worker_token ${token}`)
  console.log(`  mails config set mailbox agent@yourdomain.com`)
  console.log(`  mails config set default_from agent@yourdomain.com`)
  console.log('')
  console.log('  Then set up Email Routing in Cloudflare Dashboard:')
  console.log('  Dashboard → your domain → Email → Email Routing → Enable')
  console.log('  Catch-all → Send to a Worker → select your Worker')
  console.log('')
  console.log('  Test it:')
  console.log('  mails inbox')
  console.log(`  mails send --to you@gmail.com --subject "Test" --body "Hello from mails"`)
  console.log('')
}
