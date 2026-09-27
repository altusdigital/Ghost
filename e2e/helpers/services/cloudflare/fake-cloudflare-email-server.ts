import express from 'express';
import { FakeServer } from '@/helpers/services/fake-server';

export interface SentMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  timestamp: Date;
}

interface MailPitAddress {
  Name: string;
  Email: string;
}

interface SendBody {
  to?: string[];
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

export class FakeCloudflareEmailServer extends FakeServer {
  private readonly _messages: SentMessage[] = [];
  private readonly mailpitUrl: string;

  constructor(options: { port?: number; mailpitUrl?: string } = {}) {
    super({ port: options.port, debugNamespace: 'e2e:fake-cloudflare-email' });
    this.mailpitUrl = options.mailpitUrl ?? 'http://localhost:8025';
  }

  get messages(): SentMessage[] {
    return [...this._messages];
  }

  clearMessages(): void {
    this._messages.length = 0;
  }

  protected setupRoutes(): void {
    this.app.use(express.json({ limit: '8mb' }));

    this.app.get('/health', (_req, res) => {
      res.status(200).json({ success: true });
    });

    this.app.post('/client/v4/accounts/:accountId/email/sending/send', (req, res) => {
      this.handleSend(req, res);
    });

    this.app.delete('/client/v4/accounts/:accountId/email/sending/suppressions', (_req, res) => {
      res.status(200).json({ success: true, result: {} });
    });

    this.app.post('/client/v4/graphql', (_req, res) => {
      res.status(200).json({
        data: {
          viewer: {
            zones: [{ emailSendingAdaptive: [] }],
          },
        },
      });
    });
  }

  private handleSend(req: express.Request, res: express.Response): void {
    const body = (req.body || {}) as SendBody;
    const to = Array.isArray(body.to) ? body.to.filter((email) => typeof email === 'string') : [];
    if (!body.from || to.length === 0) {
      res.status(400).json({
        success: false,
        errors: [{ message: 'from and to are required' }],
      });
      return;
    }

    const message: SentMessage = {
      id: `<${Date.now()}.${crypto.randomUUID()}@fake.cloudflare.test>`,
      from: body.from,
      to,
      subject: body.subject || '',
      html: body.html || '',
      text: body.text || '',
      replyTo: body.reply_to,
      headers: body.headers || {},
      timestamp: new Date(),
    };
    this._messages.push(message);
    this.forwardToMailPit(message).catch((err) => {
      this.debug('Failed to forward to MailPit:', err);
    });

    res.status(200).json({
      success: true,
      result: {
        delivered: to,
        queued: [],
        permanent_bounces: [],
      },
    });
  }

  private async forwardToMailPit(message: SentMessage): Promise<void> {
    const fromParsed = parseEmailAddress(message.from);
    const reservedHeaders = new Set(['Reply-To', 'Sender', 'From', 'To', 'Subject', 'Date']);
    const filteredHeaders: Record<string, string> = {};
    const replyToAddresses: MailPitAddress[] = [];

    if (message.replyTo) {
      replyToAddresses.push(parseEmailAddress(message.replyTo));
    }

    for (const [key, value] of Object.entries(message.headers)) {
      if (key === 'Reply-To' && value && replyToAddresses.length === 0) {
        replyToAddresses.push(parseEmailAddress(value));
      } else if (!reservedHeaders.has(key)) {
        filteredHeaders[key] = value;
      }
    }

    for (const recipientEmail of message.to) {
      const payload = {
        From: fromParsed,
        To: [{ Name: '', Email: recipientEmail }],
        Subject: message.subject,
        HTML: message.html,
        Text: message.text,
        ...(replyToAddresses.length > 0 ? { ReplyTo: replyToAddresses } : {}),
        Headers: filteredHeaders,
      };

      try {
        const response = await fetch(`${this.mailpitUrl}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const responseBody = await response.text();
          this.debug(
            `MailPit forward failed for ${recipientEmail}: ${response.status} ${responseBody}`,
          );
        }
      } catch (err) {
        this.debug(`MailPit forward error for ${recipientEmail}:`, err);
      }
    }
  }
}

function parseEmailAddress(address: string): MailPitAddress {
  const match = address.match(/^([^<]+)<([^>]+)>$/);
  if (match) {
    return { Name: match[1].trim(), Email: match[2].trim() };
  }
  return { Name: '', Email: address.trim() };
}
