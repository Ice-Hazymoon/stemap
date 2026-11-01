/**
 * Reads the compiled data from a page opened on file://. `fetch` is refused there, so each piece is a
 * plain script that calls `__stemap(key, json)`. A single-file export has already called it by the
 * time the app starts, so a key is either here or one script away.
 */
declare global {
  interface Window {
    __stemapData?: Record<string, string>;
    __stemap?: (key: string, json: string) => void;
  }
}

const store = (window.__stemapData ??= {});
const waiting = new Map<string, () => void>();
window.__stemap = (key, json) => { store[key] = json; waiting.get(key)?.(); };

const parsed = new Map<string, Promise<unknown>>();

export function load<T>(key: string): Promise<T> {
  const known = parsed.get(key);
  if (known) return known as Promise<T>;
  const take = () => { const v = JSON.parse(store[key]!) as T; delete store[key]; return v; };
  const p = key in store ? Promise.resolve().then(take) : new Promise<T>((done, fail) => {
    const tag = document.createElement("script");
    tag.src = `./data/${key}.js?v=${document.documentElement.dataset.build ?? ""}`;
    waiting.set(key, () => { waiting.delete(key); tag.remove(); done(take()); });
    tag.onerror = () => { waiting.delete(key); tag.remove(); parsed.delete(key); fail(new Error(`${key} is not in this page`)); };
    document.head.append(tag);
  });
  parsed.set(key, p);
  return p;
}
