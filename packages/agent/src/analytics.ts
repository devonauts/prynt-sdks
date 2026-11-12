// Prynt Analytics client (docs/platform/CONTRACT.md §4): the SAME beacon, batching, consent resolution
// (GPC → false), SPA pageviews, engagement and PII-safe `track()` as Reveal (reveal.ts), sent to the shared
// collect `POST /v1/track` instead of `/v1/reveal/collect`. The server routes each event to the products the
// tenant has (Analytics, Reveal, …). Signed email-link tokens (`pid`) are a Reveal feature: off here.
import type { AnalyticsClient, AnalyticsOptions } from './index';
import { createReveal } from './reveal';

export const SHARED_COLLECT_PATH = '/v1/track';

export function createAnalytics(opts: AnalyticsOptions, defaultEndpoint: string,
                                visitorId: () => string | null, sdkVersion: string): AnalyticsClient {
  const c = createReveal({ ...opts, pid: false }, defaultEndpoint, visitorId, sdkVersion, SHARED_COLLECT_PATH);
  return { ...c, page: (url?: string): void => c.pageview(url) };
}
