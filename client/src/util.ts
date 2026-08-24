export function debounce(fn: () => void, millis: number) {
  let timer: number;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, millis);
  };
}

export function findLast<T>(array: Array<T> | undefined, predicate: (item: T) => boolean) {
  return array?.slice().reverse().find(predicate);
}

interface Config {
  theme?: string;
  serverUrl?: string;
  ctx?: string;
  usefulWeb?: boolean;
  syncScroll?: boolean;
}

export function getInjectConfig(): Config {
  const peek = Reflect.get(window, 'peek');

  if (peek) return { ctx: 'webview', ...peek };

  const params: Config = {};

  new URLSearchParams(location.search).forEach((value, key) => {
    if (key === 'usefulWeb' || key === 'syncScroll') {
      params[key] = value === '1';
    } else {
      params[key as keyof Config] = value as never;
    }
  });

  params.serverUrl = params.serverUrl || location.host;
  params.ctx = 'browser';

  return params;
}
