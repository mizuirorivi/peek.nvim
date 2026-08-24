import { getInjectConfig } from './util.ts';

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, definition: string, container: Element): Promise<{ svg: string }>;
}

const scriptUrl = new URL('mermaid.min.js', location.href).href;
let loadPromise: Promise<MermaidApi> | undefined;
let initialized = false;

function load() {
  const loaded = Reflect.get(globalThis, 'mermaid') as MermaidApi | undefined;
  if (loaded) return Promise.resolve(loaded);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      const mermaid = Reflect.get(globalThis, 'mermaid') as MermaidApi | undefined;
      if (mermaid) resolve(mermaid);
      else {
        script.remove();
        reject(new Error('Could not load Mermaid'));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Could not load Mermaid'));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    loadPromise = undefined;
    throw error;
  });

  return loadPromise;
}

async function render(id: string, definition: string, container: Element) {
  try {
    const mermaid = await load();
    if (!initialized) {
      const peek = getInjectConfig();
      mermaid.initialize({
        startOnLoad: false,
        arrowMarkerAbsolute: true,
        theme: peek?.theme === 'light' ? 'neutral' : 'dark',
        flowchart: { htmlLabels: false },
      });
      initialized = true;
    }

    return (await mermaid.render(id, definition, container)).svg;
  } catch { /**/ }
}

export default { render };
