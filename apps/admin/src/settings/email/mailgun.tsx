import React from 'react';
import TopLevelGroup from '@/settings/components/top-level-group';
import useSettingGroup from '@/settings/hooks/use-setting-group';
import { Field, FieldDescription, FieldLabel, Input } from '@tryghost/shade/components';
import { Inline } from '@tryghost/shade/primitives';
import { LucideIcon } from '@tryghost/shade/utils';
import {
  SettingGroupContent,
  SettingGroupValue,
  SettingGroupValueContent,
  SettingGroupValueTitle,
} from '@tryghost/shade/patterns';
import { getSettingValues } from '@tryghost/admin-x-framework/api/settings';
import { withErrorBoundary } from '@/settings/components/with-error-boundary';

const CloudflareEmail: React.FC<{ keywords: string[] }> = ({ keywords }) => {
  const {
    localSettings,
    isEditing,
    saveState,
    handleSave,
    handleCancel,
    updateSetting,
    handleEditingChange,
  } = useSettingGroup();

  const [accountId, apiToken, zoneId, sendingDomain] = getSettingValues(localSettings, [
    'cloudflare_account_id',
    'cloudflare_api_token',
    'cloudflare_zone_id',
    'cloudflare_sending_domain',
  ]) as string[];

  const isConfigured = Boolean(accountId && apiToken && sendingDomain);

  const values = (
    <SettingGroupContent>
      <SettingGroupValue>
        {!isConfigured && <SettingGroupValueTitle>Status</SettingGroupValueTitle>}
        <SettingGroupValueContent className={!isConfigured ? 'mt-1' : undefined}>
          {isConfigured ? (
            <Inline align="center" gap="sm">
              <LucideIcon.Check className="size-4 text-state-success" />
              Cloudflare Email is set up
            </Inline>
          ) : (
            'Cloudflare Email is not set up'
          )}
        </SettingGroupValueContent>
      </SettingGroupValue>
    </SettingGroupContent>
  );

  const inputs = (
    <SettingGroupContent>
      <div className="grid gap-6">
        <Field>
          <FieldLabel htmlFor="cloudflare-account-id">Account ID</FieldLabel>
          <Input
            id="cloudflare-account-id"
            value={accountId ?? ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              updateSetting('cloudflare_account_id', event.target.value);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cloudflare-zone-id">Zone ID</FieldLabel>
          <Input
            id="cloudflare-zone-id"
            value={zoneId ?? ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              updateSetting('cloudflare_zone_id', event.target.value);
            }}
          />
          <FieldDescription>Used to poll delivery, bounce, and complaint events.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="cloudflare-sending-domain">Sending domain</FieldLabel>
          <Input
            id="cloudflare-sending-domain"
            value={sendingDomain ?? ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              updateSetting('cloudflare_sending_domain', event.target.value);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cloudflare-api-token">API token</FieldLabel>
          <Input
            id="cloudflare-api-token"
            type="password"
            value={apiToken ?? ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              updateSetting('cloudflare_api_token', event.target.value);
            }}
          />
          <FieldDescription>
            Token with Email Sending Edit. Find tokens in the Cloudflare dashboard.
          </FieldDescription>
        </Field>
      </div>
    </SettingGroupContent>
  );

  const groupDescription = (
    <>
      Cloudflare Email Service sends newsletters, automations, and system email.{' '}
      <a
        className="text-green hover:text-green-400"
        href="https://developers.cloudflare.com/email-service/"
        rel="noopener noreferrer"
        target="_blank"
      >
        Email Service docs
      </a>
    </>
  );

  return (
    <TopLevelGroup
      description={groupDescription}
      isEditing={isEditing}
      keywords={keywords}
      navid="mailgun"
      saveState={saveState}
      testId="mailgun"
      title="Cloudflare Email"
      onCancel={handleCancel}
      onEditingChange={handleEditingChange}
      onSave={() => {
        void handleSave();
      }}
    >
      {isEditing ? inputs : values}
    </TopLevelGroup>
  );
};

export default withErrorBoundary(CloudflareEmail, 'Cloudflare Email');
