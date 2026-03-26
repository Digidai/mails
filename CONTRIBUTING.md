# Contributing to mails

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/chekusu/mails.git
cd mails

# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

### Worker Development

```bash
cd worker
bun install
wrangler dev   # Local dev server
```

## Project Structure

```
src/
  cli/           # CLI entry point and commands
  core/          # Core logic (send, receive, storage, config)
  providers/
    send/        # Send providers (resend, hosted, worker)
    storage/     # Storage providers (sqlite, remote)
test/
  unit/          # Unit tests
  e2e/           # End-to-end tests
worker/
  src/           # Cloudflare Worker source
    handlers/    # API route handlers
```

## Running Tests

```bash
bun test                 # Unit + mock E2E tests
bun test:coverage        # With coverage report
bun test:live            # Live E2E (requires .env with RESEND_API_KEY)
```

## Pull Request Guidelines

1. **Fork** the repo and create your branch from `main`.
2. **Write tests** for any new functionality.
3. **Run the test suite** before submitting: `bun test && bun run typecheck`
4. **Keep PRs focused** — one feature or fix per PR.
5. **Follow existing code style** — no linter config needed, just match what's there.

## Commit Messages

Use clear, descriptive commit messages:

```
fix: handle empty subject in verification code extraction
feat: add --cc flag to send command
docs: update self-hosted deployment guide
test: add coverage for attachment parsing edge cases
```

## Reporting Bugs

Open an issue at [github.com/chekusu/mails/issues](https://github.com/chekusu/mails/issues) with:

- Your `mails version` output
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs (redact any API keys)

## Feature Requests

Open an issue with the `enhancement` label. Describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
