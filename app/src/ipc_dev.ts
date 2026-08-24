import { readLines } from 'https://deno.land/std@0.159.0/io/buffer.ts';
import { normalize } from 'https://deno.land/std@0.159.0/path/mod.ts';
import { render } from './markdownit.ts';

interface ClientMessage {
  action: string;
  [key: string]: unknown;
}

export default async function (send: (message: ClientMessage) => void) {
  const decoder = new TextDecoder();
  let documentId = 0;
  let documentVersion = 0;

  for await (const line of readLines(Deno.stdin)) {
    const [action, ...args] = line.split(':');

    switch (action) {
      case 'show':
        try {
          const content = decoder.decode(Deno.readFileSync(args[0]));
          documentId += 1;
          const documentKey = normalize(args[0]);
          documentVersion = 1;
          const sourceToken = crypto.randomUUID();
          send({
            action: 'document',
            documentId,
            documentKey,
            version: documentVersion,
            path: documentKey,
          });
          send({
            action,
            documentId,
            documentKey,
            version: documentVersion,
            html: render(content, sourceToken),
            lcount: (content.match(/(?:\r?\n)/g) || []).length + 1,
            sourceToken,
          });
        } catch (e) {
          console.error(e);
        }
        break;
      case 'scroll': {
        send({
          action,
          line: Number(args[0]),
          documentId,
          version: documentVersion,
        });
        break;
      }
      case 'base': {
        send({
          action,
          path: normalize(args[0]),
        });
        break;
      }
      default:
        break;
    }
  }
}
