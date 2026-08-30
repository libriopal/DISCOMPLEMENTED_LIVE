/**
 * Floating support chat — Phase 8. Cohere-backed FluxyChat widget: mints
 * its own session via POST /api/chat/token (routes/chat.ts) and talks
 * directly to the FluxyChat Worker over WebSocket from there on. See
 * @agent_docs/live-chat.md.
 *
 * Imports from `@fluxy-chat/sdk` directly rather than `@fluxy-chat/react`:
 * every published `@fluxy-chat/sdk` version from 0.3.0 on (and both
 * `@fluxy-chat/react` releases, which only pair with those) ships a barrel
 * `dist/index.js` that statically imports dozens of sibling modules
 * missing from the npm tarball — an upstream packaging defect that breaks
 * both the Vite and Wrangler bundles outright. `@fluxy-chat/sdk@0.2.2`
 * (pinned in package.json — do not bump without re-verifying the tarball
 * is self-consistent) is the newest version that resolves cleanly, and at
 * that point in the package's history `FluxyRealtimeProvider`/`useChat`
 * still lived in the main SDK, pre-dating the `@fluxy-chat/react` split.
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  FluxyRealtimeProvider,
  useChat,
  type FluxyAuthTokenResult,
} from '@fluxy-chat/sdk';

interface ChatSession {
  workerUrl: string;
  roomId: string;
  agentHandle: string;
}

async function fetchSession(): Promise<ChatSession & FluxyAuthTokenResult> {
  const res = await fetch('/api/chat/token', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to start chat session');
  return res.json();
}

export function FluxyChatWidget() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openWidget = useCallback(() => {
    setOpen(true);
    if (session) return;
    setError(null);
    fetchSession()
      .then((s) =>
        setSession({
          workerUrl: s.workerUrl,
          roomId: s.roomId,
          agentHandle: s.agentHandle,
        })
      )
      .catch(() => setError('Support chat is unavailable right now.'));
  }, [session]);

  return (
    <div
      className="fluxy-chat-widget"
      style={{
        position: 'fixed',
        right: 'var(--space-6)',
        bottom: 'var(--space-6)',
        zIndex: 'var(--z-modal)',
      }}
    >
      {open ? (
        session ? (
          <FluxyRealtimeProvider
            workerUrl={session.workerUrl}
            authTokenProvider={fetchSession}
          >
            <ChatPanel
              roomId={session.roomId}
              agentHandle={session.agentHandle}
              onClose={() => setOpen(false)}
            />
          </FluxyRealtimeProvider>
        ) : (
          <ChatShell onClose={() => setOpen(false)}>
            <div
              style={{
                padding: 'var(--space-4)',
                color: 'var(--text-secondary)',
                fontSize: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                textAlign: 'center',
              }}
            >
              {error ? (
                <>
                  <span>{error}</span>
                  <button
                    onClick={() => {
                      setError(null);
                      setSession(null);
                      openWidget();
                    }}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid var(--border-default)',
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Try again
                  </button>
                </>
              ) : (
                <>
                  <div
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      border: '2px solid var(--border-subtle)',
                      borderTopColor: 'var(--color-accent)',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                  <span>Connecting…</span>
                  <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                </>
              )}
            </div>
          </ChatShell>
        )
      ) : (
        <button
          onClick={openWidget}
          style={{
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: 'var(--color-accent)',
            color: 'var(--neutral-0)',
            padding: '12px 20px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: 'var(--shadow-e2)',
          }}
        >
          Support
        </button>
      )}
    </div>
  );
}

function ChatShell({
  children,
  onClose,
  headerRight,
}: {
  children: ReactNode;
  onClose: () => void;
  headerRight?: ReactNode;
}) {
  return (
    <div
      style={{
        width: 340,
        height: 460,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-base)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-e3)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--border-default)',
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <span>Discomplement Support</span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {headerRight}
          <button
            onClick={onClose}
            aria-label="Close support chat"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 16,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </header>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ChatPanel({
  roomId,
  agentHandle,
  onClose,
}: {
  roomId: string;
  agentHandle: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const { messages, sendMessage, connectionStatus } = useChat({
    roomId,
    agentId: agentHandle,
  });

  return (
    <ChatShell
      onClose={onClose}
      headerRight={
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: 'var(--text-secondary)',
          }}
        >
          {connectionStatus}
        </span>
      }
    >
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            Ask about your build, pricing, or anything else — a founder support
            agent will answer.
          </div>
        )}
        {messages.map((m) => {
          const fromAgent = m.userId === agentHandle;
          return (
            <div
              key={m.clientMessageId ?? m.id}
              style={{
                alignSelf: fromAgent ? 'flex-start' : 'flex-end',
                maxWidth: '85%',
                background: fromAgent
                  ? 'var(--surface-raised)'
                  : 'var(--color-accent)',
                color: fromAgent ? 'var(--text-primary)' : 'var(--neutral-0)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                fontSize: 14,
                whiteSpace: 'pre-wrap',
              }}
            >
              {m.content}
            </div>
          );
        })}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const content = draft.trim();
          if (!content) return;
          sendMessage(content);
          setDraft('');
        }}
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          borderTop: '1px solid var(--border-default)',
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about your build…"
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-base)',
            color: 'var(--text-primary)',
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          style={{
            padding: '8px 14px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'var(--color-accent)',
            color: 'var(--neutral-0)',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Send
        </button>
      </form>
    </ChatShell>
  );
}
