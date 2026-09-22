/**
 * The public compliance surface for discomplemented.com.
 *
 * It renders what is PROVEN about this system and, with equal weight, what is
 * not. A compliance page that only shows green is marketing; the interesting
 * number here is how much was measured, not how much passed.
 *
 * Design notes, because they were decisions and not defaults:
 *
 *   - Gate counts are NOT charted. Thirty-two gates report in thirty-two
 *     different units — rows, trees, mutants, words, paths — and putting
 *     incomparable units on one axis is the classic way to draw something that
 *     looks quantitative and means nothing. They are a table.
 *   - Mutation outcomes ARE charted, as one part-to-whole bar, because killed /
 *     survived / not-tested share a denominator and their proportions are the
 *     point. Three categorical hues, validated all-pairs in both modes.
 *   - Status colour is reserved for the verdict badge and always ships with a
 *     word, never colour alone.
 *   - "Not tested" is drawn as its own segment rather than folded into either
 *     neighbour. A mutant nobody ran is not a mutant that survived and not one
 *     that was killed, and the whole system exists to stop those three reading
 *     as one number.
 */
import { useEffect, useState } from 'react';

interface Gate {
  gate: string;
  ok: boolean;
  skipped: boolean;
  count: number;
  unit: string;
  detail?: string;
}
interface Round {
  id: string;
  vendor: string;
  verdict: string;
}
interface Check {
  name: string;
  ok: boolean;
  examined: number;
  unit: string;
  detail: string;
}
interface Payload {
  published: {
    verify?: {
      at?: string;
      gates_run: number;
      gates_declared: number;
      failed: string[];
      skipped: string[];
      verdict: string;
    };
    gates?: Gate[];
    mutation?: {
      generated: number;
      killed: number;
      survived: number;
      not_tested: number;
      ratcheted: number;
    };
    audit_ladder?: {
      author_vendor: string;
      rounds: Round[];
      cross_vendor_rounds: number;
      total_rounds: number;
    };
  } | null;
  published_note: string;
  drift: {
    checks: Check[];
    checks_run: number;
    failed: string[];
    measured_nothing: string[];
    verdict: string;
  };
}

const CSS = `
.cmp {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --surface-2: #f2f2f0;
  --rule: #d9d9d4;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #6e6d68;
  --killed: #2a78d6;
  --survived: #eb6834;
  --untested: #1baf7a;
  --good: #0ca30c;
  --critical: #d03b3b;
  background: var(--surface-1);
  color: var(--text-primary);
  min-height: 100vh;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .cmp {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #232322; --rule: #3a3a38;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #96958d;
    --killed: #3987e5; --survived: #d95926; --untested: #199e70;
  }
}
:root[data-theme="dark"] .cmp {
  color-scheme: dark;
  --surface-1: #1a1a19; --surface-2: #232322; --rule: #3a3a38;
  --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #96958d;
  --killed: #3987e5; --survived: #d95926; --untested: #199e70;
}
.cmp-wrap { max-width: 68rem; margin: 0 auto; padding: 3rem 16px 5rem; }
.cmp h1 { font-size: clamp(1.6rem, 4vw, 2.3rem); line-height: 1.15; margin: 0 0 .4rem; letter-spacing: -0.02em; }
.cmp h2 { font-size: 1.02rem; margin: 2.6rem 0 .9rem; letter-spacing: -0.01em; }
.cmp .lede { color: var(--text-secondary); max-width: 46rem; margin: 0 0 2rem; }
.cmp .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.cmp .tile { background: var(--surface-2); border: 1px solid var(--rule); border-radius: 10px; padding: 1rem 1.1rem; }
.cmp .tile .n { font-size: 1.9rem; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; line-height: 1.1; }
.cmp .tile .k { color: var(--text-secondary); font-size: .8rem; margin-top: .25rem; }
.cmp .tile .s { color: var(--text-muted); font-size: .74rem; margin-top: .35rem; }
.cmp .badge { display: inline-flex; align-items: center; gap: .45rem; border-radius: 999px;
  padding: .3rem .8rem; font-size: .84rem; font-weight: 600; border: 1px solid currentColor; }
.cmp .bar { display: flex; width: 100%; height: 30px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--rule); }
.cmp .seg { height: 100%; }
.cmp .legend { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: .7rem; font-size: .83rem; color: var(--text-secondary); }
.cmp .legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; margin-right: .4rem; vertical-align: -1px; }
.cmp table { width: 100%; border-collapse: collapse; font-size: .86rem; }
.cmp th { text-align: left; font-weight: 600; color: var(--text-secondary); font-size: .76rem;
  text-transform: uppercase; letter-spacing: .05em; padding: .5rem .6rem; border-bottom: 1px solid var(--rule); }
.cmp td { padding: .5rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
.cmp td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.cmp .scroll { overflow-x: auto; }
.cmp .muted { color: var(--text-muted); }
.cmp .note { background: var(--surface-2); border: 1px solid var(--rule); border-left: 3px solid var(--text-muted);
  border-radius: 8px; padding: .85rem 1rem; color: var(--text-secondary); font-size: .87rem; margin: 1rem 0 0; }
`;

function Badge({ verdict }: { verdict: string }) {
  const good = verdict === 'green';
  return (
    <span
      className="badge"
      style={{ color: good ? 'var(--good)' : 'var(--critical)' }}
    >
      <span aria-hidden="true">{good ? '●' : '▲'}</span>
      {good ? 'green' : verdict.toUpperCase()}
    </span>
  );
}

function Tile({ n, k, s }: { n: React.ReactNode; k: string; s?: string }) {
  return (
    <div className="tile">
      <div className="n">{n}</div>
      <div className="k">{k}</div>
      {s ? <div className="s">{s}</div> : null}
    </div>
  );
}

export function ComplianceDashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/compliance')
      .then((r) =>
        r.ok
          ? (r.json() as Promise<Payload>)
          : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((p) => setData(p))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const pub = data?.published ?? null;
  const v = pub?.verify;
  const m = pub?.mutation;
  const ladder = pub?.audit_ladder;
  const total = m ? m.killed + m.survived + m.not_tested : 0;
  const pct = (x: number) => (total ? Math.round((x / total) * 1000) / 10 : 0);

  return (
    <div className="cmp">
      <style>{CSS}</style>
      <div className="cmp-wrap">
        <h1>Compliance</h1>
        <p className="lede">
          What is mechanically established about this system, and what is not.
          Every number below is produced by an instrument that reports its own
          denominator — a check that measured nothing cannot report the same
          green as one that measured everything.
        </p>

        {err ? (
          <div className="note">
            The compliance endpoint could not be read ({err}). This is shown as
            a failure rather than an empty page: an unreachable check is not a
            passing one.
          </div>
        ) : !data ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="tiles">
              <Tile
                n={<Badge verdict={v?.verdict ?? 'unknown'} />}
                k="Gate suite"
                s={v?.at ? `run ${v.at}` : 'no run recorded'}
              />
              <Tile
                n={v ? `${v.gates_run}/${v.gates_declared}` : '—'}
                k="Gates run / declared"
                s={
                  v && v.skipped.length
                    ? `${v.skipped.length} skipped — a skip is not a pass`
                    : 'none skipped'
                }
              />
              <Tile
                n={<Badge verdict={data.drift.verdict} />}
                k="Live self-checks"
                s={`${data.drift.checks_run} checks, ${data.drift.checks.reduce((n, c) => n + c.examined, 0)} things examined`}
              />
              <Tile
                n={
                  ladder
                    ? `${ladder.cross_vendor_rounds}/${ladder.total_rounds}`
                    : '—'
                }
                k="Cross-vendor audit rounds"
                s={
                  ladder ? `author vendor: ${ladder.author_vendor}` : undefined
                }
              />
              <Tile
                n="0"
                k="Plan candidates executed"
                s="of 684 — a carried plan is not a running one"
              />
            </div>

            {m ? (
              <>
                <h2>Mutation coverage</h2>
                <p
                  className="muted"
                  style={{ margin: '0 0 .8rem', fontSize: '.88rem' }}
                >
                  Each gate is deliberately broken and re-run. A <em>killed</em>{' '}
                  mutant is one the suite caught. <em>Not tested</em> is drawn
                  separately because a mutant whose gate skipped was never
                  evaluated at all — counting it either way would be a claim
                  nobody measured.
                </p>
                <div
                  className="bar"
                  role="img"
                  aria-label={`${m.killed} killed, ${m.survived} survived, ${m.not_tested} not tested, of ${total} mutants`}
                >
                  <div
                    className="seg"
                    style={{
                      width: `${pct(m.killed)}%`,
                      background: 'var(--killed)',
                    }}
                  />
                  <div
                    className="seg"
                    style={{
                      width: `${pct(m.survived)}%`,
                      background: 'var(--survived)',
                    }}
                  />
                  <div
                    className="seg"
                    style={{
                      width: `${pct(m.not_tested)}%`,
                      background: 'var(--untested)',
                    }}
                  />
                </div>
                <div className="legend">
                  <span>
                    <i style={{ background: 'var(--killed)' }} />
                    Killed {m.killed} ({pct(m.killed)}%)
                  </span>
                  <span>
                    <i style={{ background: 'var(--survived)' }} />
                    Survived {m.survived} ({pct(m.survived)}%)
                  </span>
                  <span>
                    <i style={{ background: 'var(--untested)' }} />
                    Not tested {m.not_tested} ({pct(m.not_tested)}%)
                  </span>
                </div>
                <div className="note">
                  {m.ratcheted} survivors carry a written reason naming the
                  condition under which that branch is not exercised. A survivor
                  without one fails the suite.
                </div>
              </>
            ) : null}

            <h2>Gates</h2>
            <p
              className="muted"
              style={{ margin: '0 0 .8rem', fontSize: '.88rem' }}
            >
              Deliberately a table, not a chart. These counts are in thirty-two
              different units — rows, trees, mutants, paths, words — and drawing
              incomparable units on one axis would look quantitative while
              meaning nothing.
            </p>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Gate</th>
                    <th>State</th>
                    <th style={{ textAlign: 'right' }}>Denominator</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {(pub?.gates ?? []).map((g) => (
                    <tr key={g.gate}>
                      <td>{g.gate}</td>
                      <td
                        style={{
                          color: g.skipped
                            ? 'var(--text-muted)'
                            : g.ok
                              ? 'var(--good)'
                              : 'var(--critical)',
                        }}
                      >
                        {g.skipped ? 'skipped' : g.ok ? 'green' : 'RED'}
                      </td>
                      <td className="num">{g.count.toLocaleString()}</td>
                      <td className="muted">{g.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2>Independent audit rounds</h2>
            <p
              className="muted"
              style={{ margin: '0 0 .8rem', fontSize: '.88rem' }}
            >
              A round from the author&rsquo;s own model family does not satisfy
              the cross-vendor requirement, so the vendor is named on every row.
              Most verdicts here are vetoes; that is the system working.
            </p>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Vendor</th>
                    <th>Verdict</th>
                    <th>Cross-vendor</th>
                  </tr>
                </thead>
                <tbody>
                  {(ladder?.rounds ?? []).map((r) => {
                    const cross = r.vendor !== ladder?.author_vendor;
                    return (
                      <tr key={r.id}>
                        <td>{r.id}</td>
                        <td className="muted">{r.vendor}</td>
                        <td>{r.verdict}</td>
                        <td className="muted">{cross ? 'yes' : 'no'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <h2>Live self-checks</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>State</th>
                    <th style={{ textAlign: 'right' }}>Examined</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.drift.checks.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td
                        style={{
                          color:
                            c.examined === 0
                              ? 'var(--critical)'
                              : c.ok
                                ? 'var(--good)'
                                : 'var(--critical)',
                        }}
                      >
                        {c.examined === 0
                          ? 'measured nothing'
                          : c.ok
                            ? 'green'
                            : 'RED'}
                      </td>
                      <td className="num">
                        {c.examined.toLocaleString()} {c.unit}
                      </td>
                      <td className="muted">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="note">{data.published_note}</div>
            <p
              className="muted"
              style={{ fontSize: '.8rem', marginTop: '2rem' }}
            >
              Raw: <code>/api/compliance</code> ·{' '}
              <code>/api/compliance/drift</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default ComplianceDashboard;
