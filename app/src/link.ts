import { dirname, isAbsolute, normalize, resolve } from 'https://deno.land/std@0.217.0/path/mod.ts';

export type LinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'local'; path: string; fragment?: string }
  | { kind: 'error'; message: string };

const externalSchemes = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const schemePattern = /^[a-z][a-z0-9+.-]*:/i;
const windowsPathPattern = /^[a-z]:[\\/]/i;
const unsafeCharacters = /[\u0000-\u001f\u007f]/;

function decode(value: string, label: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (unsafeCharacters.test(decoded)) throw new Error();
    return decoded;
  } catch (_) {
    throw new Error(`Invalid ${label}`);
  }
}

export function isMarkdownPath(path: string) {
  return /\.(?:md|markdown|mdx)$/i.test(path);
}

export function resolveLinkTarget(href: string, documentPath: string): LinkTarget {
  if (!href || href.length > 4096 || unsafeCharacters.test(href)) {
    return { kind: 'error', message: 'Invalid link target' };
  }

  if (href.startsWith('//')) {
    try {
      return { kind: 'external', href: new URL(`https:${href}`).href };
    } catch (_) {
      return { kind: 'error', message: 'Invalid external link' };
    }
  }

  if (!windowsPathPattern.test(href) && schemePattern.test(href)) {
    try {
      const url = new URL(href);
      if (!externalSchemes.has(url.protocol.toLowerCase())) {
        return { kind: 'error', message: `Blocked link scheme: ${url.protocol}` };
      }
      return { kind: 'external', href: url.href };
    } catch (_) {
      return { kind: 'error', message: 'Invalid external link' };
    }
  }

  const fragmentIndex = href.indexOf('#');
  const encodedPath = fragmentIndex === -1 ? href : href.slice(0, fragmentIndex);
  const encodedFragment = fragmentIndex === -1 ? undefined : href.slice(fragmentIndex + 1);

  if (encodedPath.includes('?')) {
    return { kind: 'error', message: 'Local link queries are not supported' };
  }
  if (!documentPath) {
    return { kind: 'error', message: 'Save this buffer before following local links' };
  }

  try {
    const decodedPath = decode(encodedPath, 'local path');
    const fragment = encodedFragment === undefined
      ? undefined
      : decode(encodedFragment, 'fragment');
    const path = decodedPath === ''
      ? normalize(documentPath)
      : isAbsolute(decodedPath)
      ? normalize(decodedPath)
      : resolve(dirname(documentPath), decodedPath);

    return { kind: 'local', path, fragment };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Invalid link target',
    };
  }
}
