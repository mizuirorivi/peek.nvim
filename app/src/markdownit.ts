import { hashCode, uniqueIdGen } from './util.ts';
import { parseArgs } from 'https://deno.land/std@0.217.0/cli/parse_args.ts';
import { default as highlight } from 'https://cdn.skypack.dev/highlight.js@11.9.0';
// @deno-types="https://esm.sh/@types/markdown-it@14.1.2/index.d.ts";
import MarkdownIt from 'https://esm.sh/markdown-it@14.0.0';
import { full as MarkdownItEmoji } from 'https://esm.sh/markdown-it-emoji@3.0.0';
import { default as MarkdownItFootnote } from 'https://esm.sh/markdown-it-footnote@4.0.0';
import { default as MarkdownItTaskLists } from 'https://esm.sh/markdown-it-task-lists@2.1.1';
import { default as MarkdownItTexmath } from 'https://esm.sh/markdown-it-texmath@1.0.0';
import Katex from 'https://esm.sh/katex@0.16.9';
import GithubSlugger from 'https://esm.sh/github-slugger@2.0.0';

const __args = parseArgs(Deno.args);

const md = new MarkdownIt('default', {
  html: true,
  typographer: true,
  linkify: true,
  langPrefix: 'language-',
  highlight: __args['syntax'] && ((code, language) => {
    if (language && highlight.getLanguage(language)) {
      try {
        return highlight.highlight(code, { language }).value;
      } catch {
        return code;
      }
    }

    return '';
  }),
}).use(MarkdownItEmoji)
  .use(MarkdownItFootnote)
  .use(MarkdownItTaskLists, { enabled: false, label: true })
  .use(MarkdownItTexmath, {
    engine: Katex,
    delimiters: ['gitlab', 'dollars'],
    katexOptions: {
      macros: { '\\R': '\\mathbb{R}' },
      strict: false,
      throwOnError: false,
    },
  });

function renderSourceAttrs(token: { attrGet(name: string): string | null }) {
  return ['data-line-begin', 'data-source-line', 'data-peek-source']
    .map((name) => [name, token.attrGet(name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .map(([name, value]) => `${name}="${md.utils.escapeHtml(value)}"`)
    .join(' ');
}

md.renderer.rules.math_block = (() => {
  const math_block = md.renderer.rules.math_block!;

  return (tokens, idx, options, env, self) => {
    return `
      <div ${renderSourceAttrs(tokens[idx])}>
        ${math_block(tokens, idx, options, env, self)}
      </div>
    `;
  };
})();

md.renderer.rules.math_block_eqno = (() => {
  const math_block_eqno = md.renderer.rules.math_block_eqno!;

  return (tokens, idx, options, env, self) => {
    return `
      <div ${renderSourceAttrs(tokens[idx])}>
        ${math_block_eqno(tokens, idx, options, env, self)}
      </div>
    `;
  };
})();

md.renderer.rules.fence = (() => {
  const fence = md.renderer.rules.fence!;
  const escapeHtml = md.utils.escapeHtml;
  const regex = new RegExp(
    /^(?<frontmatter>---[\s\S]+---)?\s*(?<content>(?<charttype>flowchart|sequenceDiagram|gantt|classDiagram|stateDiagram|pie|journey|C4Context|erDiagram|requirementDiagram|gitGraph)[\s\S]+)/,
  );

  return (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const content = token.content.trim();

    if (regex.test(content)) {
      const match = regex.exec(content);
      return `
        <div
          class="peek-mermaid-container"
          ${renderSourceAttrs(token)}
        >
          <div
            id="graph-mermaid-${env.genId(hashCode(content))}"
            data-graph="mermaid"
          >
            <pre class="peek-mermaid-definition" hidden>${
        escapeHtml(match?.groups?.content || '')
      }</pre>
            <div class="peek-loader"></div>
          </div>
        </div>
      `;
    }

    return fence(tokens, idx, options, env, self);
  };
})();

export function render(markdown: string, sourceToken = crypto.randomUUID()) {
  const tokens = md.parse(markdown, {});
  const slugger = new GithubSlugger();

  tokens.forEach((token, index) => {
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1];
      const heading = inline.children
        ?.map((child) => {
          if (child.type === 'html_inline') return '';
          if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
          return child.content;
        })
        .join('') || inline.content;
      token.attrSet('id', `peek-heading-${slugger.slug(heading)}`);
    }

    if (!token.map) return;

    const sourceLine = String(token.map[0] + 1);
    token.attrSet('data-source-line', sourceLine);
    if (token.level === 0) token.attrSet('data-line-begin', sourceLine);
    token.attrSet('data-peek-source', sourceToken);
  });

  return md.renderer.render(tokens, md.options, { genId: uniqueIdGen() });
}
