// @ts-expect-error This module lacks type definitions.
import CloudflareEmailClient from '../lib/cloudflare-email-client';
// @ts-expect-error This module lacks type definitions.
import { bindPendingProviderIds } from '../lib/cloudflare-provider-id-binder';
import type { Knex } from 'knex';

const PAGE_LIMIT = 50;

type FetchEmailEventsOptions = {
  config: { get: (key: string) => unknown };
  settings: { get: (key: string) => unknown };
  tags: string[];
  batchHandler: Function;
  knex?: Knex;
  /** Per-domain soft maximum. We stop fetching a domain after we reached the maximum AND received at least one event after begin (not equal) to prevent deadlocks. */
  maxEvents?: number;
  begin?: Date;
  end?: Date;
  events?: string[];
};

/**
 * Fetch Cloudflare Email sending events and normalize them for Ghost analytics.
 * The export name is kept so existing analytics jobs do not need a new entry point.
 */
export async function fetchMailgunEvents({
  config,
  settings,
  batchHandler,
  knex,
  maxEvents,
  begin,
  end,
}: FetchEmailEventsOptions) {
  const client = new CloudflareEmailClient({ config, settings });
  return await client.fetchEvents(
    {
      limit: PAGE_LIMIT,
      begin: begin ? begin.getTime() / 1000 : undefined,
      end: end ? end.getTime() / 1000 : undefined,
    },
    async (events: unknown[]) => {
      await bindPendingProviderIds(knex, events);
      await batchHandler(events);
    },
    { maxEvents },
  );
}
