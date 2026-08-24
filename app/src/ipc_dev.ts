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

  for await (const line of readLines(Deno.stdin)) {
    const [action, ...args] = line.split(':');

    switch (action) {
      case 'show':
        try {
          const content = decoder.decode(Deno.readFileSync(args[0]));
          documentId += 1;
          send({ action: 'document', documentId });
          send({
            action,
            html: render(content),
            lcount: (content.match(/(?:\r?\n)/g) || []).length + 1,
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
        });
        break;
      }
      case 'base': {
        send({
          action,
          base: normalize(args[0] + '/'),
        });
        break;
      }
      default:
        break;
    }
  }
}
