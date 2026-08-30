/**
 * Standalone legal-doc page — the destination for LoginScreen's Terms of
 * Service / Privacy Policy links (and any other /legal/* link). Same
 * no-client-router pattern as ResetPasswordScreen: App.tsx path-detects
 * /legal/* ahead of the normal auth-gated view switch, since a signed-out
 * visitor must be able to read these before creating an account.
 *
 * Renders a minimal, dependency-free subset of Markdown (# / ## headers,
 * bold, numbered/bulleted lists, paragraphs) — the docs in
 * content/legal-docs.ts don't use anything beyond that.
 */
import type { CSSProperties, ReactNode } from 'react';
import { LEGAL_DOCS } from '../content/legal-docs.js';

function renderInline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function renderMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.split('\n');
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(
        <ul
          key={`list-${blocks.length}`}
          style={{
            paddingLeft: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {listItems.map((item, i) => (
            <li key={i} style={{ fontSize: 14, lineHeight: 1.6 }}>
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(
        <p key={`p-${blocks.length}`} style={{ fontSize: 14, lineHeight: 1.7 }}>
          {renderInline(paragraph.join(' '))}
        </p>
      );
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push(
        <h2 key={`h2-${blocks.length}`} style={{ fontSize: 20, paddingTop: 8 }}>
          {line.slice(3)}
        </h2>
      );
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      flushList();
      blocks.push(
        <h2 key={`h1-${blocks.length}`} style={{ fontSize: 24 }}>
          {line.slice(2)}
        </h2>
      );
      continue;
    }
    const listMatch = /^(?:-|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return blocks;
}

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 720,
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--space-8)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
  textAlign: 'left',
};

// Short aliases people (and older links) actually type. The canonical slugs
// live in content/legal-docs.ts; this only maps abbreviations onto them.
const SLUG_ALIASES: Record<string, string> = {
  aup: 'acceptable-use',
  tos: 'terms',
  'terms-of-service': 'terms',
  'privacy-policy': 'privacy',
};

export function LegalDocScreen({ slug }: { slug: string }) {
  const doc = LEGAL_DOCS[slug] ?? LEGAL_DOCS[SLUG_ALIASES[slug] ?? ''];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        gap: 'var(--space-6)',
        padding: 'var(--space-8) var(--space-6)',
      }}
    >
      <img src="/logo.png" alt="Discomplement" width={40} height={36} />
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 0.28,
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
        }}
      >
        Discomplement
      </div>

      <div style={cardStyle}>
        {doc ? (
          <>
            <h1 style={{ fontSize: 28 }}>{doc.title}</h1>
            {renderMarkdown(doc.markdown)}
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 24 }}>Document not found</h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
              We couldn't find a legal document at this address.
            </p>
          </>
        )}
        <a
          href="/"
          style={{
            color: 'var(--color-accent)',
            fontSize: 13,
            textDecoration: 'underline',
          }}
        >
          Back to Discomplement
        </a>
      </div>
    </div>
  );
}
