import { parseArgs } from 'https://deno.land/std@0.217.0/cli/parse_args.ts';
import { dirname, fromFileUrl, join, normalize } from 'https://deno.land/std@0.217.0/path/mod.ts';
import { open } from 'https://deno.land/x/open@v0.0.6/index.ts';
import { readChunks } from './read.ts';
import log from './log.ts';
import { render } from './markdownit.ts';

const __args = parseArgs(Deno.args);
const usefulWeb = __args['useful-web'] === true;
const syncScroll = __args['sync-scroll'] === true;
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
const replayOrder = ['document', 'base', 'show', 'scroll'];
let activeSocket: WebSocket | undefined;
let inputTask: Promise<void> | undefined;

function sendToSocket(socket: WebSocket, message: ClientMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;

  try {
    socket.send(clientEncoder.encode(JSON.stringify(message)));
  } catch (_) {
    if (activeSocket === socket) activeSocket = undefined;
  }
}

function sendClientMessage(message: ClientMessage, remember = true) {
  if (remember) {
    if (message.action === 'document') clientState.clear();
    clientState.set(message.action, message);
  }

  if (activeSocket) sendToSocket(activeSocket, message);
}

function connectClient(socket: WebSocket) {
  activeSocket = socket;

  for (const action of replayOrder) {
    const message = clientState.get(action);
    if (message) sendToSocket(socket, message);
  }

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
  socket.addEventListener('message', (event) => {
    if (activeSocket !== socket) return;

    try {
      const msg = JSON.parse(
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data),
      );
      switch (msg.action) {
        case 'scroll': {
          const line = msg.line;
          const documentId = msg.documentId;
          if (
            syncScroll &&
            typeof line === 'number' &&
            Number.isInteger(line) &&
            line >= 1 &&
            typeof documentId === 'number' &&
            Number.isInteger(documentId) &&
            documentId >= 1
          ) {
            Deno.stdout.writeSync(
              encoder.encode(JSON.stringify({ action: 'scroll', line, documentId }) + '\n'),
            );
          }
          break;
        }
        case 'listdir':
        case 'openfile': {
          const action = msg.action === 'openfile' ? 'open' : 'listdir';
          Deno.stdout.writeSync(encoder.encode(JSON.stringify({ action, path: msg.path }) + '\n'));
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
  let documentId: number | undefined;

  const generator = readChunks(Deno.stdin);

  for await (const chunk of generator) {
    const action = decoder.decode(chunk.buffer);

    switch (action) {
      case 'show': {
        const content = decoder.decode((await generator.next()).value!);

        sendClientMessage({
          action: 'show',
          html: render(content),
          lcount: (content.match(/(?:\r?\n)/g) || []).length + 1,
        });

        break;
      }
      case 'scroll': {
        sendClientMessage({
          action,
          line: Number(decoder.decode((await generator.next()).value!)),
          documentId,
        });
        break;
      }
      case 'document': {
        documentId = Number(decoder.decode((await generator.next()).value!));
        sendClientMessage({ action, documentId });
        break;
      }
      case 'base': {
        sendClientMessage({
          action,
          base: normalize(decoder.decode((await generator.next()).value!) + '/'),
        });
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

(() => {
  const app = __args['app'] ? JSON.parse(__args['app']) : 'webview';

  if (app === 'webview') {
    const onListen: Deno.ServeOptions['onListen'] = (address) => {
      const serverUrl = getServerUrl(address);
      logger.info(`listening on ${serverUrl}`);
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
          `--serverUrl=${serverUrl}`,
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

    Deno.serve({ port: 0, onListen }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);

      socket.onopen = () => {
        connectClient(socket);
        if (usefulWeb || syncScroll) setupClientMessages(socket);
      };
      socket.onclose = () => disconnectClient(socket);

      return response;
    });

    return;
  }

  async function findFile(url: string) {
    const path = new URL(url).pathname.replace(/^\//, '') || 'index.html';

    for (const base of [Deno.mainModule, 'file:']) {
      try {
        return await Deno.open(new URL(path, base));
      } catch (_) { /**/ }
    }
  }

  const onListen: Deno.ServeOptions['onListen'] = (address) => {
    const serverUrl = getServerUrl(address);
    logger.info(`listening on ${serverUrl}`);
    const url = new URL(`http://${serverUrl}`);
    const searchParams = new URLSearchParams({
      theme: __args.theme,
      ...(usefulWeb ? { usefulWeb: '1' } : {}),
      ...(syncScroll ? { syncScroll: '1' } : {}),
    });
    url.search = searchParams.toString();

    open(url.href, { app: app !== 'browser' && app })
      .catch((e) => {
        Deno.stderr.writeSync(new TextEncoder().encode(`${[app].flat().join(' ')}: ${e.message}`));
        Deno.exit();
      });
  };

  let timeout: number;

  Deno.serve({ port: 0, onListen }, async (request) => {
    const upgrade = request.headers.get('upgrade') || '';

    if (upgrade.toLowerCase() != 'websocket') {
      const file = await findFile(request.url);
      return new Response(file?.readable || 'Not Found', { status: file ? 200 : 404 });
    }

    clearTimeout(timeout);

    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.onopen = () => {
      clearTimeout(timeout);
      connectClient(socket);
      setupClientMessages(socket);
    };

    socket.onclose = () => {
      disconnectClient(socket);
      if (!activeSocket) {
        timeout = setTimeout(() => {
          if (!activeSocket) Deno.exit();
        }, 2000);
      }
    };

    return response;
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
