export function toggleMailgun(server, enabled) {
    const values = enabled
        ? {
            cloudflare_account_id: 'CLOUDFLARE_ACCOUNT',
            cloudflare_api_token: 'CLOUDFLARE_API_TOKEN',
            cloudflare_sending_domain: 'email.example.com'
        }
        : {
            cloudflare_account_id: null,
            cloudflare_api_token: null,
            cloudflare_sending_domain: null
        };

    for (const [key, value] of Object.entries(values)) {
        server.db.settings.findBy({key})
            ? server.db.settings.update({key}, {value})
            : server.create('setting', {key, value, group: 'email'});
    }
}

export function enableMailgun(server) {
    toggleMailgun(server, true);
}

export function disableMailgun(server) {
    toggleMailgun(server, false);
}
