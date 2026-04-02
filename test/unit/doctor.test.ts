import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

describe('doctor command', () => {
  let output: string[]
  let origLog: typeof console.log
  let origError: typeof console.error
  let origExit: typeof process.exit

  beforeEach(() => {
    output = []
    origLog = console.log
    origError = console.error
    origExit = process.exit
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
  })

  afterEach(() => {
    console.log = origLog
    console.error = origError
    process.exit = origExit
    mock.restore()
  })

  test('shows config check pass when config exists', async () => {
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand()
    const text = output.join('\n')
    expect(text).toContain('Config:')
  })

  test('shows API check when api_key is configured', async () => {
    // This will attempt a real API call but will show the attempt
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand()
    const text = output.join('\n')
    // Should contain either API pass or fail
    expect(text).toMatch(/API:|api_key/)
  })

  test('shows mails doctor header', async () => {
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand()
    const text = output.join('\n')
    expect(text).toContain('mails doctor')
  })
})
