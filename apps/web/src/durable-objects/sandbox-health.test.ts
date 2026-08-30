/**
 * The judgements behind the Tier 3 health check.
 *
 * These tests are the reason the check is worth having. The probe itself is
 * three lines of `fetch`; everything load-bearing is in what a given response
 * is taken to *mean*, and each case below is a failure that previously reported
 * a healthy preview.
 */
import { describe, it, expect } from 'vitest';
import {
  chooseBackendProbePath,
  isConcreteRoute,
  judgeBackendResponse,
  judgeFrontendResponse,
  summarize,
  unprobeable,
} from './sandbox-health.js';

const json = (body: string, status = 200) => ({
  path: '/api/todos',
  status,
  contentType: 'application/json; charset=utf-8',
  body,
});

describe('choosing a route to probe', () => {
  it('takes a parameter-free route', () => {
    expect(
      chooseBackendProbePath(['/api/todos/:id', '/api/todos', '/api/users'])
    ).toBe('/api/todos');
  });

  it('refuses every parameterised syntax the Designer emits', () => {
    // `:id`, `[id]` and `*` all require inventing data, and a correct server
    // answers invented data with 404 — which would report a working backend as
    // broken. Both syntaxes are checked because matchRoutePattern accepts both.
    expect(isConcreteRoute('/api/todos/:id')).toBe(false);
    expect(isConcreteRoute('/api/posts/[slug]')).toBe(false);
    expect(isConcreteRoute('/api/files/*')).toBe(false);
    expect(isConcreteRoute('/api/todos')).toBe(true);
  });

  it('returns null rather than picking something unprobeable', () => {
    expect(chooseBackendProbePath(['/api/todos/:id'])).toBeNull();
    expect(chooseBackendProbePath([])).toBeNull();
  });
});

describe('judging a backend response', () => {
  it('fails an HTML document, which arrives as HTTP 200', () => {
    // The sharpest Tier 3 failure and the reason this module exists: Vite
    // answers any unmatched path with index.html and a 200, so the request
    // that never reached the generated server looks like a success.
    const result = judgeBackendResponse({
      path: '/api/todos',
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    });
    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toMatch(/HTML document/);
  });

  it('fails an HTML body even when the header claims JSON', () => {
    // Content-Type is advisory. A dev server confused enough to serve
    // index.html for an API path is not an authority on its own headers.
    expect(
      judgeBackendResponse(json('<!DOCTYPE html>\n<html><head></head></html>'))
        .outcome
    ).toBe('unhealthy');
  });

  it('fails a declared route that 404s', () => {
    const result = judgeBackendResponse(json('Not Found', 404));
    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toMatch(/blueprint declares this route/);
  });

  it('fails a handler that threw', () => {
    expect(judgeBackendResponse(json('{}', 500)).outcome).toBe('unhealthy');
  });

  it('fails a route that claims JSON and returns something else', () => {
    const result = judgeBackendResponse(json('todo: fix this'));
    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toMatch(/does not parse as JSON/);
  });

  it('passes a real JSON payload', () => {
    const result = judgeBackendResponse(json('[{"id":1,"title":"buy milk"}]'));
    expect(result.outcome).toBe('healthy');
    expect(result.status).toBe(200);
  });

  it('passes an authenticated route answering 401', () => {
    // A generated app may guard its routes. An auth decision is proof a
    // handler ran; calling it degraded would put a red banner on a correctly
    // secured preview, and a check that cries wolf gets switched off.
    expect(
      judgeBackendResponse(json('{"error":"unauthorized"}', 401)).outcome
    ).toBe('healthy');
    expect(judgeBackendResponse(json('{}', 403)).outcome).toBe('healthy');
  });

  it('passes a non-JSON, non-HTML payload', () => {
    // Not every API route returns JSON. text/plain from a route handler is
    // still a route handler answering.
    expect(
      judgeBackendResponse({
        path: '/api/ping',
        status: 200,
        contentType: 'text/plain',
        body: 'pong',
      }).outcome
    ).toBe('healthy');
  });
});

describe('judging the frontend response', () => {
  const html = (body: string, status = 200) => ({
    path: '/',
    status,
    contentType: 'text/html',
    body,
  });

  it('passes an HTML document — the same body that fails on the API port', () => {
    expect(
      judgeFrontendResponse(html('<!doctype html><html></html>')).outcome
    ).toBe('healthy');
  });

  it('fails an empty 200', () => {
    expect(judgeFrontendResponse(html('   ')).outcome).toBe('unhealthy');
  });

  it('fails a 500 from the dev server', () => {
    expect(judgeFrontendResponse(html('<html></html>', 500)).outcome).toBe(
      'unhealthy'
    );
  });

  it('fails a body the iframe cannot render', () => {
    expect(
      judgeFrontendResponse({
        path: '/',
        status: 200,
        contentType: 'application/json',
        body: '{"error":"no index.html"}',
      }).outcome
    ).toBe('unhealthy');
  });
});

describe('rolling probes up', () => {
  const healthy = judgeFrontendResponse({
    path: '/',
    status: 200,
    contentType: 'text/html',
    body: '<html></html>',
  });
  const broken = judgeBackendResponse(json('nope', 500));

  it('is healthy only when every probe that ran passed', () => {
    expect(summarize([healthy]).healthy).toBe(true);
    expect(summarize([healthy, broken]).healthy).toBe(false);
    expect(summarize([healthy, broken]).degraded).toBe(true);
  });

  it('does not call an unprobed backend healthy', () => {
    // The whole point: "we did not check" must not render as a green banner.
    const report = summarize([
      healthy,
      unprobeable('backend', 'no declared routes'),
    ]);
    expect(report.degraded).toBe(false);
    expect(report.probes.some((p) => p.outcome === 'unprobeable')).toBe(true);
  });

  it('is not healthy when nothing ran at all', () => {
    const report = summarize([
      unprobeable('frontend', 'container not running'),
      unprobeable('backend', 'container not running'),
    ]);
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(false);
  });
});
