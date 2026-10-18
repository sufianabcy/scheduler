import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { toast } from './toast.js';

/**
 * Loads data with `load()` and reloads when `deps` change.
 * Returns { data, error, loading, reload, setData }.
 */
export function useLoad(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const call = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await load();
      if (call === latest.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (call === latest.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  const setData = useCallback((data) => setState((s) => ({ ...s, data })), []);
  return { ...state, reload, setData };
}

/** Runs a change; shows a toast if it fails. Resolves to the result, or undefined on failure. */
export async function attempt(promise) {
  try {
    return await promise;
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    return () => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** The current hash route, e.g. '/goals/12'. */
export function useRoute() {
  const read = () => location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => {
      setRoute(read());
      scrollTo(0, 0);
    };
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return route;
}

export const go = (path) => {
  location.hash = path;
};

/** The current time, updated at the start of every minute (for clocks on screen). */
export function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return now;
}
