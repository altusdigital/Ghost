# Receiving and Testing Emails

## Use Mailpit by default

The normal development environment starts Mailpit with Ghost. Run:

```bash
pnpm dev
```

Transactional emails sent by the development site are captured at
[http://localhost:8025](http://localhost:8025) rather than delivered. The Docker
development configuration connects Ghost to Mailpit automatically.

Use Mailpit for ordinary local work. It is quick, keeps test messages on your
machine, and does not require provider credentials. It does not exercise the
Cloudflare Email API used for newsletters and other bulk email.

## Capture bulk email in Mailpit

To capture newsletters and other bulk email locally, run:

```bash
pnpm dev:fake-cloudflare
```

This starts the full development environment, including the Admin and Portal
watchers, plus a fake Cloudflare Email API running in Docker. Ghost sends
transactional and bulk email to that API, which forwards each message to
[Mailpit](http://localhost:8025). No Cloudflare credentials or local
configuration files are needed.

The fake server is only exposed on the internal Docker network. Compose waits
for Mailpit and the fake API to be healthy before starting Ghost. Press `Ctrl+C`
to stop the development environment; database and content volumes are preserved.
Run one development variant at a time.

## Test with Cloudflare Email

Use the Cloudflare development variant when the provider interaction is part of
the behaviour you need to test. It routes transactional, newsletter, and
automation email through the Cloudflare Email API:

```bash
pnpm dev:cloudflare
```

Copy [`.env.example`](../../.env.example) to `.env` and provide a Cloudflare
account id, zone id, sending domain, and API token. Never commit `.env` or
provider credentials.

The development variant supplies Ghost's Cloudflare configuration for you. Do not
add those credentials to `config.local.json`.

This sends real email through an external service. Use test addresses and the
smallest useful recipient list. Return to `pnpm dev` when provider behaviour is
not under test.

## Automated tests

Automated tests must not call the real Cloudflare Email API. Browser E2E tests
can enable the suite's fake Cloudflare Email service:

```ts
test.use({cloudflareEnabled: true});
```

The fake service records send requests and forwards rendered messages to
Mailpit, where tests can inspect them with the existing email fixture. See the
[E2E workspace README](../../e2e/README.md) and the
[newsletter-send test](../../e2e/tests/admin/posts/newsletter-send.test.ts) for
the current fixtures and an example.

Ghost Core tests should use the Cloudflare client stubs and email test utilities
instead of provider credentials. Start with the [testing guide](testing.md) to
choose the suite closest to the behaviour being changed.
