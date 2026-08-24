import { parseArgs } from 'https://deno.land/std@0.217.0/cli/parse_args.ts';
import {
  dirname,
  extname,
  fromFileUrl,
  join,
  normalize,
} from 'https://deno.land/std@0.217.0/path/mod.ts';
import { open as openExternal } from 'https://deno.land/x/open@v0.0.6/index.ts';
import { isMarkdownPath, resolveLinkTarget } from './link.ts';
import { readChunks } from './read.ts';
import log from './log.ts';
import { render } from './markdownit.ts';

const __args = parseArgs(Deno.args);
const usefulWeb = __args['useful-web'] === true;
const syncScroll = __args['sync-scroll'] === true;
const app = __args['app'] ? JSON.parse(__args['app']) : 'webview';
const sessionToken = typeof __args.token === 'string' && /^[a-f0-9]{32,}$/i.test(__args.token)
  ? __args.token
  : crypto.randomUUID().replaceAll('-', '');
const socketPath = '/__peek_socket__';
const localFilePrefix = `/__peek_local__/${sessionToken}/`;
const requestedPort = Number(__args.port);
const serverPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
  ? requestedPort
  : 0;
const __dirname = dirname(new URL(import.meta.url).pathname);

const DENO_ENV = Deno.env.get('DENO_ENV');

const logger = log.setupLogger();
const version = Deno.version;

logger.info(`DENO_ENV: ${DENO_ENV}`, ...Deno.args);
logger.info(`deno: ${version.deno} v8: ${version.v8} typescript: ${version.typescript}`);

interface ClientMessage {
  action: string;
  [key: string]: unknown;
}

const clientEncoder = new TextEncoder();
const clientState = new Map<string, ClientMessage>();
const replayOrder = ['document', 'tabs', 'base', 'show', 'updating', 'scroll'];
let activeSocket: WebSocket | undefined;
let inputTask: Promise<void> | undefined;
let serverAddress: string | undefined;
let currentDocument:
  | { documentId: number; documentKey: string; version: number; path: string }
  | undefined;
const documentRoots = new Map<string, string>();
const maxDocumentRoots = 16;
let pendingNavigation:
  | { documentId: number; documentKey: string; version: number; fragment: string }
  | undefined;
let pendingScroll:
  | { documentId: number; documentKey: string; version: number; line: number }
  | undefined;
const openingExternalLinks = new Set<string>();
const externalLinkOpenedAt = new Map<string, number>();
const renderCache = new Map<
  string,
  { html: string; lcount: number; sourceToken: string; size: number }
>();
const renderCacheKeys = new Map<string, string>();
const maxRenderCacheEntries = 16;
const maxRenderCacheBytes = 24 * 1024 * 1024;
let renderCacheBytes = 0;
let pendingRender:
  | { documentId: number; documentKey: string; documentVersion: number; content: string }
  | undefined;
let renderTimer: number | undefined;

function getRenderCacheKey(documentKey: string, documentVersion: number) {
  return `${documentKey.length}:${documentKey}:${documentVersion}`;
}

function getCachedRender(documentKey: string, documentVersion: number) {
  const key = getRenderCacheKey(documentKey, documentVersion);
  const cached = renderCache.get(key);
  if (!cached) return;

  renderCache.delete(key);
  renderCache.set(key, cached);
  return cached;
}

function deleteCachedRender(key: string) {
  const cached = renderCache.get(key);
  if (!cached) return;
  renderCacheBytes -= cached.size;
  renderCache.delete(key);
}

function cacheRender(
  documentKey: string,
  documentVersion: number,
  html: string,
  lcount: number,
  sourceToken: string,
) {
  const key = getRenderCacheKey(documentKey, documentVersion);
  const size = html.length * 2;
  const previousKey = renderCacheKeys.get(documentKey);
  if (previousKey && previousKey !== key) deleteCachedRender(previousKey);

  deleteCachedRender(key);
  if (size > maxRenderCacheBytes) {
    renderCacheKeys.delete(documentKey);
    return { html, lcount, sourceToken, size };
  }

  renderCache.set(key, { html, lcount, sourceToken, size });
  renderCacheKeys.set(documentKey, key);
  renderCacheBytes += size;

  while (
    renderCache.size > maxRenderCacheEntries ||
    renderCacheBytes > maxRenderCacheBytes
  ) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey === undefined) break;
    deleteCachedRender(oldestKey);
    for (const [documentKey, cacheKey] of renderCacheKeys) {
      if (cacheKey === oldestKey) renderCacheKeys.delete(documentKey);
    }
  }

  return renderCache.get(key)!;
}

function isCurrentDocument(documentId: number, documentKey: string, documentVersion?: number) {
  return currentDocument?.documentId === documentId &&
    currentDocument.documentKey === documentKey &&
    (documentVersion === undefined || currentDocument.version === documentVersion);
}

function sendRenderedDocument(
  documentId: number,
  documentKey: string,
  documentVersion: number,
  rendered: { html: string; lcount: number; sourceToken: string },
) {
  if (!isCurrentDocument(documentId, documentKey, documentVersion)) return;
  clientState.delete('updating');
  sendClientMessage({
    action: 'show',
    documentId,
    documentKey,
    version: documentVersion,
    html: rendered.html,
    lcount: rendered.lcount,
    sourceToken: rendered.sourceToken,
  });
  sendPendingScroll();
  sendPendingNavigation();
}

function scheduleDocumentRender(
  documentId: number,
  documentKey: string,
  documentVersion: number,
  content: string,
) {
  pendingRender = { documentId, documentKey, documentVersion, content };
  if (renderTimer !== undefined) return;

  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    const request = pendingRender;
    pendingRender = undefined;
    if (
      !request ||
      !isCurrentDocument(request.documentId, request.documentKey, request.documentVersion)
    ) {
      return;
    }

    const sourceToken = crypto.randomUUID();
    const html = render(request.content, sourceToken);
    const lcount = (request.content.match(/(?:\r?\n)/g) || []).length + 1;
    sendRenderedDocument(
      request.documentId,
      request.documentKey,
      request.documentVersion,
      cacheRender(request.documentKey, request.documentVersion, html, lcount, sourceToken),
    );
  }, 16);
}

function requestDocumentRender(documentId: number, documentKey: string, documentVersion: number) {
  Deno.stdout.writeSync(clientEncoder.encode(
    JSON.stringify({
      action: 'render',
      documentId,
      documentKey,
      version: documentVersion,
    }) + '\n',
  ));
}

function sendPendingNavigation() {
  if (!pendingNavigation || !activeSocket) return;
  const rendered = clientState.get('show');
  if (
    !isCurrentDocument(
      pendingNavigation.documentId,
      pendingNavigation.documentKey,
      pendingNavigation.version,
    ) ||
    rendered?.documentId !== pendingNavigation.documentId ||
    rendered.documentKey !== pendingNavigation.documentKey ||
    rendered.version !== pendingNavigation.version
  ) {
    return;
  }

  if (sendToSocket(activeSocket, { action: 'navigate', ...pendingNavigation })) {
    pendingNavigation = undefined;
  }
}

function sendPendingScroll() {
  if (!pendingScroll) return;
  const rendered = clientState.get('show');
  if (
    !isCurrentDocument(
      pendingScroll.documentId,
      pendingScroll.documentKey,
      pendingScroll.version,
    ) ||
    rendered?.documentId !== pendingScroll.documentId ||
    rendered.documentKey !== pendingScroll.documentKey ||
    rendered.version !== pendingScroll.version
  ) {
    return;
  }

  sendClientMessage({ action: 'scroll', ...pendingScroll });
  pendingScroll = undefined;
}

function sendToSocket(socket: WebSocket, message: ClientMessage) {
  if (socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(clientEncoder.encode(JSON.stringify(message)));
    return true;
  } catch (_) {
    if (activeSocket === socket) activeSocket = undefined;
    return false;
  }
}

function sendClientMessage(message: ClientMessage, remember = true) {
  if (message.action === 'base' && typeof message.path === 'string') {
    const document = currentDocument;
    const documentDirectory = currentDocument?.path
      ? normalize(dirname(currentDocument.path))
      : undefined;
    const root = message.path === documentDirectory ? message.path : undefined;
    let url = serverAddress ? `http://${serverAddress}${localFilePrefix}0/` : 'about:blank';
    if (document && root) {
      const namespace = String(document.documentId);
      documentRoots.delete(namespace);
      documentRoots.set(namespace, root);
      while (documentRoots.size > maxDocumentRoots) {
        const oldest = documentRoots.keys().next().value;
        if (oldest === undefined) break;
        documentRoots.delete(oldest);
      }
      url = serverAddress
        ? `http://${serverAddress}${localFilePrefix}${encodeURIComponent(namespace)}/`
        : 'about:blank';
    }
    message = {
      ...message,
      url,
    };
  }

  if (
    message.action === 'document' &&
    typeof message.documentId === 'number' &&
    typeof message.documentKey === 'string' &&
    typeof message.version === 'number' &&
    typeof message.path === 'string'
  ) {
    currentDocument = {
      documentId: message.documentId,
      documentKey: message.documentKey,
      version: message.version,
      path: message.path,
    };
    if (
      pendingRender &&
      !isCurrentDocument(
        pendingRender.documentId,
        pendingRender.documentKey,
        pendingRender.documentVersion,
      )
    ) {
      pendingRender = undefined;
    }
    if (
      pendingNavigation &&
      !isCurrentDocument(
        pendingNavigation.documentId,
        pendingNavigation.documentKey,
        pendingNavigation.version,
      )
    ) {
      pendingNavigation = undefined;
    }
    if (
      pendingScroll &&
      !isCurrentDocument(
        pendingScroll.documentId,
        pendingScroll.documentKey,
        pendingScroll.version,
      )
    ) {
      pendingScroll = undefined;
    }
  }

  if (remember) {
    if (message.action === 'document') {
      const tabs = clientState.get('tabs');
      clientState.clear();
      if (tabs) clientState.set('tabs', tabs);
    }
    clientState.set(message.action, message);
  }

  if (activeSocket) sendToSocket(activeSocket, message);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function sendRouteResult(
  socket: WebSocket,
  requestId: number,
  documentId: number,
  documentVersion: number,
  result: Record<string, unknown>,
) {
  if (activeSocket !== socket || !currentDocument || currentDocument.documentId !== documentId) {
    return;
  }
  if (currentDocument.version !== documentVersion) return;
  sendToSocket(socket, {
    action: 'routeResult',
    requestId,
    documentId,
    version: documentVersion,
    ...result,
  });
}

async function routeLink(socket: WebSocket, msg: Record<string, unknown>) {
  const requestId = msg.requestId;
  const documentId = msg.documentId;
  const documentVersion = msg.version;
  const href = msg.href;
  if (
    !usefulWeb ||
    !isPositiveInteger(requestId) ||
    !isPositiveInteger(documentId) ||
    !isNonNegativeInteger(documentVersion) ||
    typeof href !== 'string' ||
    !isCurrentDocument(documentId, currentDocument?.documentKey || '', documentVersion)
  ) {
    return;
  }

  const documentPath = currentDocument!.path;
  const target = resolveLinkTarget(href, documentPath);
  if (target.kind === 'error') {
    sendRouteResult(socket, requestId, documentId, documentVersion, target);
    return;
  }

  if (target.kind === 'external') {
    const lastOpenedAt = externalLinkOpenedAt.get(target.href);
    if (
      openingExternalLinks.has(target.href) ||
      (lastOpenedAt !== undefined && Date.now() - lastOpenedAt < 1500)
    ) {
      sendRouteResult(socket, requestId, documentId, documentVersion, { kind: 'opened' });
      return;
    }

    openingExternalLinks.add(target.href);
    try {
      await openExternal(target.href);
      const openedAt = Date.now();
      externalLinkOpenedAt.set(target.href, openedAt);
      setTimeout(() => {
        if (externalLinkOpenedAt.get(target.href) === openedAt) {
          externalLinkOpenedAt.delete(target.href);
        }
      }, 1500);
      sendRouteResult(socket, requestId, documentId, documentVersion, { kind: 'opened' });
    } catch (_) {
      sendRouteResult(socket, requestId, documentId, documentVersion, {
        kind: 'error',
        message: 'Could not open external link',
      });
    } finally {
      openingExternalLinks.delete(target.href);
    }
    return;
  }

  try {
    const stat = await Deno.stat(target.path);
    if (!stat.isFile) throw new Error();
  } catch (_) {
    sendRouteResult(socket, requestId, documentId, documentVersion, {
      kind: 'error',
      message: 'File not found',
    });
    return;
  }

  if (normalize(target.path) === normalize(documentPath)) {
    sendRouteResult(socket, requestId, documentId, documentVersion, {
      kind: 'fragment',
      fragment: target.fragment || '',
    });
  } else if (isMarkdownPath(target.path)) {
    sendRouteResult(socket, requestId, documentId, documentVersion, {
      kind: 'markdown',
      path: target.path,
      fragment: target.fragment,
    });
  } else {
    sendRouteResult(socket, requestId, documentId, documentVersion, {
      kind: 'error',
      message: 'Only Markdown files can be opened locally',
    });
  }
}

function connectClient(socket: WebSocket) {
  activeSocket = socket;

  for (const action of replayOrder) {
    const message = clientState.get(action);
    if (message) sendToSocket(socket, message);
  }
  sendPendingNavigation();

  inputTask ||= init();
}

function disconnectClient(socket: WebSocket) {
  if (activeSocket === socket) activeSocket = undefined;
}

function getServerUrl(address: Deno.Addr) {
  if (address.transport !== 'tcp') throw new Error(`Unsupported transport: ${address.transport}`);
  return `${address.hostname.replace('0.0.0.0', 'localhost')}:${address.port}`;
}

function setupClientMessages(socket: WebSocket) {
  const encoder = new TextEncoder();
  socket.addEventListener('message', async (event) => {
    if (activeSocket !== socket) return;

    try {
      const msg = JSON.parse(
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data),
      );
      switch (msg.action) {
        case 'route': {
          await routeLink(socket, msg);
          break;
        }
        case 'selecttab': {
          const tabId = msg.tabId;
          if (usefulWeb && isPositiveInteger(tabId)) {
            Deno.stdout.writeSync(
              encoder.encode(JSON.stringify({ action: 'selecttab', tabId }) + '\n'),
            );
          }
          break;
        }
        case 'source':
        case 'scroll': {
          const action = msg.action;
          const line = msg.line;
          const documentId = msg.documentId;
          const documentVersion = msg.version;
          if (
            (action === 'source' ? usefulWeb : syncScroll) &&
            isPositiveInteger(line) &&
            isPositiveInteger(documentId) &&
            isNonNegativeInteger(documentVersion) &&
            currentDocument?.documentId === documentId &&
            currentDocument.version === documentVersion
          ) {
            Deno.stdout.writeSync(
              encoder.encode(
                JSON.stringify({ action, line, documentId, version: documentVersion }) + '\n',
              ),
            );
          }
          break;
        }
        case 'listdir': {
          if (usefulWeb && typeof msg.path === 'string') {
            Deno.stdout.writeSync(
              encoder.encode(JSON.stringify({ action: 'listdir', path: msg.path }) + '\n'),
            );
          }
          break;
        }
        case 'openfile': {
          if (
            usefulWeb &&
            typeof msg.path === 'string' &&
            typeof msg.tab === 'boolean' &&
            isPositiveInteger(msg.documentId) &&
            isNonNegativeInteger(msg.version) &&
            currentDocument?.documentId === msg.documentId &&
            currentDocument?.version === msg.version &&
            (msg.fragment === undefined || typeof msg.fragment === 'string')
          ) {
            Deno.stdout.writeSync(encoder.encode(
              JSON.stringify({
                action: 'open',
                path: msg.path,
                tab: msg.tab,
                documentId: msg.documentId,
                version: msg.version,
                ...(typeof msg.fragment === 'string' ? { fragment: msg.fragment } : {}),
              }) + '\n',
            ));
          }
          break;
        }
      }
    } catch (_) { /**/ }
  });
}

async function init() {
  if (DENO_ENV === 'development') {
    return void (await import(join(__dirname, 'ipc_dev.ts'))).default(sendClientMessage);
  }

  const decoder = new TextDecoder();
  const generator = readChunks(Deno.stdin);

  for await (const chunk of generator) {
    const action = decoder.decode(chunk.buffer);

    switch (action) {
      case 'show': {
        const showDocumentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        const content = decoder.decode((await generator.next()).value!);
        if (
          !currentDocument ||
          currentDocument.documentId !== showDocumentId ||
          currentDocument.documentKey !== documentKey ||
          documentVersion < currentDocument.version
        ) {
          break;
        }

        const previousVersion = currentDocument.version;
        currentDocument.version = documentVersion;
        if (documentVersion > previousVersion) {
          clientState.delete('scroll');
          sendClientMessage({
            action: 'updating',
            documentId: showDocumentId,
            documentKey,
            version: documentVersion,
          }, false);
        }
        if (
          pendingNavigation?.documentId === showDocumentId &&
          pendingNavigation.documentKey === documentKey &&
          pendingNavigation.version < documentVersion
        ) {
          pendingNavigation.version = documentVersion;
        }
        const rememberedDocument = clientState.get('document');
        if (rememberedDocument) {
          clientState.set('document', { ...rememberedDocument, version: documentVersion });
        }
        const cached = getCachedRender(documentKey, documentVersion);
        if (cached) {
          sendRenderedDocument(showDocumentId, documentKey, documentVersion, cached);
          break;
        }

        scheduleDocumentRender(showDocumentId, documentKey, documentVersion, content);

        break;
      }
      case 'updating': {
        const updatingDocumentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        if (
          !currentDocument ||
          currentDocument.documentId !== updatingDocumentId ||
          currentDocument.documentKey !== documentKey ||
          documentVersion <= currentDocument.version
        ) {
          break;
        }

        currentDocument.version = documentVersion;
        clientState.delete('scroll');
        pendingScroll = undefined;
        if (
          pendingRender &&
          !isCurrentDocument(
            pendingRender.documentId,
            pendingRender.documentKey,
            pendingRender.documentVersion,
          )
        ) {
          pendingRender = undefined;
        }
        if (
          pendingNavigation?.documentId === updatingDocumentId &&
          pendingNavigation.documentKey === documentKey &&
          pendingNavigation.version < documentVersion
        ) {
          pendingNavigation.version = documentVersion;
        }
        const rememberedDocument = clientState.get('document');
        if (rememberedDocument) {
          clientState.set('document', { ...rememberedDocument, version: documentVersion });
        }
        sendClientMessage({
          action,
          documentId: updatingDocumentId,
          documentKey,
          version: documentVersion,
        });
        break;
      }
      case 'restore': {
        const restoreDocumentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        if (!isCurrentDocument(restoreDocumentId, documentKey, documentVersion)) break;

        const cached = getCachedRender(documentKey, documentVersion);
        if (cached) {
          sendRenderedDocument(restoreDocumentId, documentKey, documentVersion, cached);
        } else {
          requestDocumentRender(restoreDocumentId, documentKey, documentVersion);
        }
        break;
      }
      case 'scroll': {
        const scrollDocumentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        const line = Number(decoder.decode((await generator.next()).value!));
        if (
          isCurrentDocument(scrollDocumentId, documentKey, documentVersion) &&
          isPositiveInteger(line)
        ) {
          pendingScroll = {
            documentId: scrollDocumentId,
            documentKey,
            version: documentVersion,
            line,
          };
          sendPendingScroll();
        }
        break;
      }
      case 'document': {
        const documentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        const path = decoder.decode((await generator.next()).value!);
        sendClientMessage({ action, documentId, documentKey, version: documentVersion, path });
        break;
      }
      case 'tabs': {
        const tabs = JSON.parse(decoder.decode((await generator.next()).value!));
        sendClientMessage({ action, tabs });
        break;
      }
      case 'navigate': {
        const navigateDocumentId = Number(decoder.decode((await generator.next()).value!));
        const documentKey = decoder.decode((await generator.next()).value!);
        const documentVersion = Number(decoder.decode((await generator.next()).value!));
        const fragment = decoder.decode((await generator.next()).value!);
        if (isCurrentDocument(navigateDocumentId, documentKey, documentVersion)) {
          pendingNavigation = {
            documentId: navigateDocumentId,
            documentKey,
            version: documentVersion,
            fragment,
          };
          sendPendingNavigation();
        }
        break;
      }
      case 'base': {
        const path = normalize(decoder.decode((await generator.next()).value!));
        sendClientMessage({ action, path });
        break;
      }
      case 'dirlist': {
        const payload = JSON.parse(decoder.decode((await generator.next()).value!));
        sendClientMessage(
          { action: 'dirlist', path: payload.path, entries: payload.entries },
          false,
        );
        break;
      }
      default: {
        break;
      }
    }
  }
}

const publicDirectory = dirname(fromFileUrl(Deno.mainModule));
const pathSeparator = Deno.build.os === 'windows' ? '\\' : '/';
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function isWithin(root: string, path: string) {
  const prefix = root.endsWith(pathSeparator) ? root : root + pathSeparator;
  return path === root || path.startsWith(prefix);
}

async function openServedFile(url: URL) {
  let path: string | undefined;
  try {
    if (url.pathname.startsWith(localFilePrefix)) {
      const resourcePath = url.pathname.slice(localFilePrefix.length);
      const separator = resourcePath.indexOf('/');
      if (separator < 1) return;
      const namespace = decodeURIComponent(resourcePath.slice(0, separator));
      const root = documentRoots.get(namespace);
      if (!root) return;
      const relativePath = decodeURIComponent(resourcePath.slice(separator + 1));
      if (!relativePath || /^[\\/]|^[a-z]:/i.test(relativePath)) return;
      const localPath = normalize(join(root, relativePath));
      if (!isWithin(root, localPath)) return;
      const realRoot = normalize(await Deno.realPath(root));
      const realPath = normalize(await Deno.realPath(localPath));
      if (!isWithin(realRoot, realPath)) return;
      path = realPath;
    } else {
      const relativePath = decodeURIComponent(url.pathname).replace(/^[\\/]+/, '') ||
        'index.html';
      const staticPath = normalize(join(publicDirectory, relativePath));
      if (!isWithin(publicDirectory, staticPath)) return;
      path = staticPath;
    }

    if (!(await Deno.stat(path)).isFile) return;
    return { file: await Deno.open(path), path };
  } catch (_) { /**/ }
}

async function serveFile(request: Request) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  const url = new URL(request.url);
  const served = await openServedFile(url);
  if (!served) return new Response('Not Found', { status: 404 });

  return new Response(served.file.readable, {
    headers: {
      'cache-control': 'no-store',
      'content-type': contentTypes[extname(served.path).toLowerCase()] ||
        'application/octet-stream',
    },
  });
}

function isAuthorizedSocketRequest(request: Request) {
  const url = new URL(request.url);
  if (
    request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
    url.pathname !== socketPath ||
    url.searchParams.get('token') !== sessionToken
  ) {
    return false;
  }

  const origin = request.headers.get('origin');
  if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch (_) {
    return false;
  }
}

function openSocket(request: Request, listenForClientMessages: boolean) {
  if (!isAuthorizedSocketRequest(request)) {
    return { response: new Response('Forbidden', { status: 403 }) };
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.onopen = () => {
    if (activeSocket && activeSocket !== socket) activeSocket.close(1000, 'Replaced');
    connectClient(socket);
    if (listenForClientMessages) setupClientMessages(socket);
  };
  socket.onclose = () => disconnectClient(socket);
  return { socket, response };
}

(() => {
  if (app === 'webview') {
    const onListen: Deno.ServeOptions['onListen'] = (address) => {
      serverAddress = getServerUrl(address);
      logger.info(`listening on ${serverAddress}`);
      const webview = new Deno.Command('deno', {
        cwd: dirname(fromFileUrl(Deno.mainModule)),
        args: [
          'run',
          '--quiet',
          '--allow-read',
          '--allow-write',
          '--allow-env',
          '--allow-net',
          '--allow-ffi',
          '--unstable',
          '--no-check',
          'webview.js',
          `--url=${new URL('index.html', Deno.mainModule).href}`,
          `--theme=${__args['theme']}`,
          `--serverUrl=${serverAddress}`,
          `--token=${sessionToken}`,
          ...(usefulWeb ? ['--useful-web'] : []),
          ...(syncScroll ? ['--sync-scroll'] : []),
        ],
        stdin: 'null',
      });

      webview.output().then((status) => {
        logger.info(`webview closed, code: ${status.code}`);
        Deno.exit();
      });
    };

    Deno.serve({ hostname: '127.0.0.1', port: serverPort, onListen }, (request) => {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return openSocket(request, usefulWeb || syncScroll).response;
      }
      return serveFile(request);
    });

    return;
  }

  const onListen: Deno.ServeOptions['onListen'] = (address) => {
    serverAddress = getServerUrl(address);
    logger.info(`listening on ${serverAddress}`);
    const url = new URL(`http://${serverAddress}`);
    const searchParams = new URLSearchParams({
      theme: __args.theme,
      token: sessionToken,
      ...(usefulWeb ? { usefulWeb: '1' } : {}),
      ...(syncScroll ? { syncScroll: '1' } : {}),
    });
    url.search = searchParams.toString();

    openExternal(url.href, { app: app !== 'browser' && app })
      .catch((e) => {
        Deno.stderr.writeSync(new TextEncoder().encode(`${[app].flat().join(' ')}: ${e.message}`));
        Deno.exit();
      });
  };

  let timeout: number;

  Deno.serve({ hostname: '127.0.0.1', port: serverPort, onListen }, (request) => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return serveFile(request);
    }

    const opened = openSocket(request, true);
    if (!opened.socket) return opened.response;
    clearTimeout(timeout);
    const socket = opened.socket;
    socket.addEventListener('open', () => clearTimeout(timeout));
    socket.addEventListener('close', () => {
      if (!activeSocket) {
        timeout = setTimeout(() => {
          if (!activeSocket) Deno.exit();
        }, 2000);
      }
    });
    return opened.response;
  });
})();

const win_signals = ['SIGINT', 'SIGBREAK'] as const;
const unix_signals = ['SIGINT', 'SIGUSR2', 'SIGTERM', 'SIGPIPE', 'SIGHUP'] as const;
const signals = Deno.build.os === 'windows' ? win_signals : unix_signals;

for (const signal of signals) {
  Deno.addSignalListener(signal, () => {
    logger.info('SIGNAL:', signal);
    Deno.exit();
  });
}
