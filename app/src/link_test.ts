import { assertEquals } from 'https://deno.land/std@0.217.0/assert/mod.ts';
import { isMarkdownPath, resolveLinkTarget } from './link.ts';

const documentPath = '/tmp/peek docs/current.md';

Deno.test('resolves local Markdown links and fragments', () => {
  assertEquals(resolveLinkTarget('../other%20doc.md#details', documentPath), {
    kind: 'local',
    path: '/tmp/other doc.md',
    fragment: 'details',
  });
  assertEquals(resolveLinkTarget('#same-section', documentPath), {
    kind: 'local',
    path: documentPath,
    fragment: 'same-section',
  });
});

Deno.test('allows only supported external schemes', () => {
  assertEquals(resolveLinkTarget('https://example.com/a.md', documentPath), {
    kind: 'external',
    href: 'https://example.com/a.md',
  });
  assertEquals(resolveLinkTarget('//example.com/path', documentPath), {
    kind: 'external',
    href: 'https://example.com/path',
  });
  assertEquals(resolveLinkTarget('javascript:alert(1)', documentPath), {
    kind: 'error',
    message: 'Blocked link scheme: javascript:',
  });
});

Deno.test('rejects malformed and unsupported local targets', () => {
  assertEquals(resolveLinkTarget('other.md?raw=1', documentPath), {
    kind: 'error',
    message: 'Local link queries are not supported',
  });
  assertEquals(resolveLinkTarget('bad%2', documentPath), {
    kind: 'error',
    message: 'Invalid local path',
  });
  assertEquals(resolveLinkTarget('other.md', ''), {
    kind: 'error',
    message: 'Save this buffer before following local links',
  });
});

Deno.test('recognizes supported Markdown extensions', () => {
  assertEquals(isMarkdownPath('/tmp/a.md'), true);
  assertEquals(isMarkdownPath('/tmp/a.MARKDOWN'), true);
  assertEquals(isMarkdownPath('/tmp/a.mdx'), true);
  assertEquals(isMarkdownPath('/tmp/a.pdf'), false);
});
