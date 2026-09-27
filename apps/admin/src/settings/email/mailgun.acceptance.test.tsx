import { describe, expect, it } from 'vitest';

import { fakeEditSettings, fakeSettingsScreens, renderAdminApp } from '@test-utils/acceptance';
import { settingsScreen } from '@/settings/settings.screen';

describe('Cloudflare Email settings', () => {
  it('saves the account, zone, sending domain, and API token', async () => {
    fakeSettingsScreens();
    const settingsApi = fakeEditSettings();
    await renderAdminApp('/settings/newsletters');

    const section = settingsScreen.mailgun();
    await expect
      .element(section.getByText('Cloudflare Email is not set up', { exact: true }))
      .toBeVisible();
    await section.getByRole('button', { name: 'Edit' }).click();
    await section.getByLabelText('Account ID').fill('account-id');
    await section.getByLabelText('Zone ID').fill('zone-id');
    await section.getByLabelText('Sending domain').fill('email.example.com');
    await section.getByLabelText('API token').fill('token');
    await section.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(section.getByText('Cloudflare Email is set up', { exact: true }))
      .toBeVisible();
    expect(settingsApi.requests).toEqual([
      {
        settings: [
          { key: 'cloudflare_account_id', value: 'account-id' },
          { key: 'cloudflare_api_token', value: 'token' },
          { key: 'cloudflare_zone_id', value: 'zone-id' },
          { key: 'cloudflare_sending_domain', value: 'email.example.com' },
        ],
      },
    ]);
  });
});
