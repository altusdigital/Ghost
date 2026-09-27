/**
 * Cloudflare REST sends do not return a Message-ID. Ghost stores a pending id
 * and this binder replaces it with the id from the first matching delivery event.
 *
 * @param {import('knex').Knex} knex
 * @param {Array<{providerId?: string, recipientEmail?: string}>} events
 */
async function bindPendingProviderIds(knex, events) {
  if (!knex || !Array.isArray(events)) {
    return;
  }

  for (const event of events) {
    if (
      !event?.providerId ||
      !event?.recipientEmail ||
      String(event.providerId).startsWith('pending.')
    ) {
      continue;
    }

    await bindColumn(knex, {
      table: 'email_batches',
      idColumn: 'id',
      providerColumn: 'provider_message_id',
      query: knex('email_recipients as er')
        .join('email_batches as eb', 'eb.id', 'er.batch_id')
        .where('er.member_email', event.recipientEmail)
        .where('eb.provider_message_id', 'like', 'pending.%')
        .orderBy('er.id', 'desc')
        .first('eb.id as id'),
      providerId: event.providerId,
    });

    await bindColumn(knex, {
      table: 'automated_email_recipients',
      idColumn: 'id',
      providerColumn: 'provider_message_id',
      query: knex('automated_email_recipients')
        .where('member_email', event.recipientEmail)
        .where('provider_message_id', 'like', 'pending.%')
        .orderBy('created_at', 'desc')
        .first('id'),
      providerId: event.providerId,
    });

    await bindColumn(knex, {
      table: 'gift_deliveries',
      idColumn: 'id',
      providerColumn: 'email_provider_message_id',
      query: knex('gift_deliveries')
        .where('recipient_email', event.recipientEmail)
        .where('email_provider_message_id', 'like', 'pending.%')
        .orderBy('id', 'desc')
        .first('id'),
      providerId: event.providerId,
    });
  }
}

async function bindColumn(knex, { table, idColumn, providerColumn, query, providerId }) {
  const row = await query;
  if (!row?.id) {
    return;
  }
  await knex(table)
    .where(idColumn, row.id)
    .update({ [providerColumn]: providerId });
}

module.exports = {
  bindPendingProviderIds,
};
