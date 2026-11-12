/**
 * React bindings for Prynt.
 *
 *   import { PryntProvider, useVisitorData } from '@pryntid/react';
 *
 *   <PryntProvider apiKey="pk_live_...">   // endpoint defaults to https://api.pryntid.com
 *     <App />
 *   </PryntProvider>
 *
 *   const { data, isLoading, error, getData } = useVisitorData();
 *   // data.requestId → send to your server; data.visitorId, data.confidence
 */
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
// Named import (not default): under CJS interop the default import of @pryntid/js resolves to the
// whole module.exports object, which has no load().
import {
  Prynt, type PryntConfig, type PryntAgent, type IdentifyResult,
  type ProtectFormOpts, type FormGuard, type FormSignals,
} from '@pryntid/js';

// Re-export the agent's public types so apps can import everything from '@pryntid/react'.
export type {
  PryntConfig, PryntAgent, IdentifyResult, ProtectFormOpts, FormGuard, FormSignals, FormContent,
  Confidence, Decision, SmartSignal, SecurityNotice, ChallengeResult,
} from '@pryntid/js';

interface Ctx {
  agent: PryntAgent | null;
  ready: boolean;
  loadError: Error | null;
}
const PryntContext = createContext<Ctx>({ agent: null, ready: false, loadError: null });

export interface PryntProviderProps extends PryntConfig {
  children: ReactNode;
}

export function PryntProvider({ children, ...config }: PryntProviderProps): ReactElement {
  const [agent, setAgent] = useState<PryntAgent | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    // load() throws synchronously on a bad config (e.g. missing apiKey): surface it through
    // useVisitorData().error instead of crashing the render tree.
    Promise.resolve()
      .then(() => Prynt.load(config))
      .then((a) => { if (alive) { setAgent(a); setReady(true); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof Error ? e : new Error(String(e))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey, config.endpoint]);
  return <PryntContext.Provider value={{ agent, ready, loadError }}>{children}</PryntContext.Provider>;
}

export interface UseVisitorDataOptions {
  immediate?: boolean;   // identify on mount (default true)
  tag?: Record<string, unknown>;
  linkedId?: string;
}

export interface UseVisitorDataResult {
  data: IdentifyResult | null;
  isLoading: boolean;
  error: Error | null;
  /** Run identify() now. Per-call options override the hook's tag/linkedId. Resolves null on error. */
  getData: (overrides?: IdentifyOptions) => Promise<IdentifyResult | null>;
}

/** Per-call options accepted by agent.identify() / getData(). */
export type IdentifyOptions = NonNullable<Parameters<PryntAgent['identify']>[0]>;

export function useVisitorData(opts: UseVisitorDataOptions = {}): UseVisitorDataResult {
  const { agent, ready, loadError } = useContext(PryntContext);
  const [data, setData] = useState<IdentifyResult | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const immediate = opts.immediate !== false;
  const fired = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const getData = useCallback(async (overrides?: IdentifyOptions) => {
    if (!agent) return null;
    setLoading(true); setError(null);
    try {
      const { tag, linkedId } = optsRef.current;
      const r = await agent.identify({ tag, linkedId, ...overrides });
      setData(r);
      return r;
    } catch (e) {
      setError(e as Error);
      return null;
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    if (ready && immediate && !fired.current) {
      fired.current = true;
      getData();
    }
  }, [ready, immediate, getData]);

  return { data, isLoading, error: error || loadError, getData };
}

export interface UseProtectFormResult {
  /** Attach to your <form> via the ref prop: `<form ref={ref}>`. */
  ref: (el: HTMLFormElement | null) => void;
  /** Read the captured honeypot/timing signals (for manual identify() calls). */
  signals: () => FormSignals | undefined;
}

/**
 * Form Shield for React — honeypot + timing (+ optional autoGuard) on a form.
 *
 *   const { ref } = useProtectForm({ autoGuard: true, expectedScripts: ['latin'],
 *                                    onBlocked: () => setError('Blocked as spam.') });
 *   return <form ref={ref} onSubmit={handleSubmit}> … </form>;
 *
 * With `autoGuard: true` the agent intercepts submit, runs identify() and blocks bots automatically.
 * Without it, pass `signals()` as `formSignals` to your own `getData({ formSignals: signals() })`.
 */
export function useProtectForm(opts?: ProtectFormOpts): UseProtectFormResult {
  const { agent, ready } = useContext(PryntContext);
  const guardRef = useRef<FormGuard | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const attachGuard = useCallback(() => {
    if (agent && formRef.current && !guardRef.current) {
      guardRef.current = agent.protectForm(formRef.current, opts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const ref = useCallback((el: HTMLFormElement | null) => {
    formRef.current = el;
    if (el) attachGuard();
  }, [attachGuard]);

  useEffect(() => { if (ready) attachGuard(); }, [ready, attachGuard]);

  return { ref, signals: () => guardRef.current?.signals() };
}
