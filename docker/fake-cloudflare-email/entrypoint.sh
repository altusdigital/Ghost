#!/bin/sh
set -eu

exec node --import tsx --input-type=module <<'JS'
import { FakeCloudflareEmailServer } from './helpers/services/cloudflare/fake-cloudflare-email-server.ts';

const server = new FakeCloudflareEmailServer({ port: 4010, mailpitUrl: 'http://mailpit:8025' });
await server.start();
console.log('Fake Cloudflare Email listening on port 4010; mail goes to Mailpit.');

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
        await server.stop();
    });
}
JS
