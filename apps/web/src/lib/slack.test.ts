import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifySlack, escapeSlack } from './slack.js';
import type { Env } from '../env.js';

const env = (over: Partial<Env> = {}) =>
  ({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_ALERT_CHANNEL: 'C0TEST',
    ...over,
  }) as Env;

function stub(body: unknown, status = 200) {
  const m = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', m);
  return m;
}

afterEach(() => vi.unstubAllGlobals());

describe('a Slack failure is reported as a failure', () => {
  it('treats {ok:false} on an HTTP 200 as not sent', async () => {
    // This is THE failure mode for a Slack integration. Slack answers 200
    // with `{ok:false,error:"not_in_channel"}` when the bot was removed from
    // the channel, and a `response.ok` check calls that a success — so the
    // alerting channel stops alerting and nothing anywhere says so.
    stub({ ok: false, error: 'not_in_channel' });
    const r = await notifySlack(env(), { text: 'hi' });
    expect(r.sent).toBe(false);
    expect(r).toMatchObject({ reason: 'rejected', detail: 'not_in_channel' });
  });

  it('names which piece of configuration is missing', async () => {
    // "not configured" is not actionable; "which variable" is.
    const noToken = await notifySlack(env({ SLACK_BOT_TOKEN: undefined }), {
      text: 'x',
    });
    expect(noToken).toMatchObject({ reason: 'unconfigured' });
    expect((noToken as { detail: string }).detail).toContain('SLACK_BOT_TOKEN');

    const noChannel = await notifySlack(
      env({ SLACK_ALERT_CHANNEL: undefined }),
      { text: 'x' }
    );
    expect((noChannel as { detail: string }).detail).toContain(
      'SLACK_ALERT_CHANNEL'
    );
  });

  it('does not call Slack at all when unconfigured', async () => {
    const m = stub({ ok: true, ts: '1' });
    await notifySlack(env({ SLACK_BOT_TOKEN: undefined }), { text: 'x' });
    expect(m).not.toHaveBeenCalled();
  });

  it('reports a network fault as unreachable, distinctly from a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const r = await notifySlack(env(), { text: 'x' });
    expect(r).toMatchObject({ reason: 'unreachable' });
  });
});

describe('user text cannot control the message', () => {
  it('escapes the three characters Slack parses', async () => {
    expect(escapeSlack('a & b <c> d')).toBe('a &amp; b &lt;c&gt; d');
    // Order matters: escaping `<` first and `&` second would double-escape.
    expect(escapeSlack('&lt;')).toBe('&amp;lt;');
  });

  it('stops a support summary from broadcasting to the workspace', async () => {
    // `<!channel>` in an unescaped message pings everyone. The summary field
    // is written by an AI tool call driven by whatever the user typed, so
    // this is reachable by a user who asks support to escalate with a
    // carefully chosen sentence.
    const m = stub({ ok: true, ts: '1' });
    await notifySlack(env(), {
      text: 'escalation',
      fields: { Summary: '<!channel> everyone look' },
    });
    const body = JSON.parse(m.mock.calls[0][1].body);
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain('<!channel>');
    expect(rendered).toContain('&lt;!channel&gt;');
  });

  it('sends fallback text alongside blocks', async () => {
    // A blocks-only message renders as "This content can't be displayed" in a
    // push notification — which is the only place an on-call person sees it.
    const m = stub({ ok: true, ts: '1' });
    await notifySlack(env(), { text: 'the alert' });
    const body = JSON.parse(m.mock.calls[0][1].body);
    expect(body.text).toBe('the alert');
    expect(body.blocks).toBeTruthy();
  });
});
