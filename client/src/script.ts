import { debounce, findLast, getInjectConfig } from './util.ts';
import { slidingWindows } from 'https://deno.land/std@0.217.0/collections/sliding_windows.ts';
// @deno-types="https://raw.githubusercontent.com/patrick-steele-idem/morphdom/master/index.d.ts"
import morphdom from 'https://esm.sh/morphdom@2.7.2?no-dts';
import mermaid from './mermaid.ts';

const window = globalThis;
// const _log = Reflect.get(window, '_log');

addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const markdownBody = document.getElementById('peek-markdown-body') as HTMLDivElement;
  const base = document.getElementById('peek-base') as HTMLBaseElement;
  const peek = getInjectConfig();
  let source: { lcount: number } | undefined;
  let blocks: HTMLElement[][] | undefined;
  let scroll: { line: number } | undefined;
  let documentId: number | undefined;
  let receivedServerState = false;
  let suppressBrowserScroll = false;
  let suppressBrowserScrollTimer: number | undefined;
  let browserScrollTimer: number | undefined;
  let lastBrowserLine: number | undefined;
  const pendingBrowserLines = new Map<number, number>();

  const zoom = {
    level: 100,
    zoomMin: 50,
    zoomMax: 250,
    zoomStep: 10,
    zoomLabel: document.getElementById('peek-zoom-label') as HTMLDivElement,
    init() {
      this.level = Number(localStorage.getItem('zoom-level')) || this.level;
      this.update(this.level === 100);
    },
    up() {
      this.level = Math.min(this.level + this.zoomStep, this.zoomMax);
      this.update();
    },
    down() {
      this.level = Math.max(this.level - this.zoomStep, this.zoomMin);
      this.update();
    },
    reset() {
      this.level = 100;
      this.update();
    },
    update(silent?: boolean) {
      localStorage.setItem('zoom-level', String(this.level));
      markdownBody.style.setProperty('font-size', `${this.level}%`);
      if (silent) return;
      this.zoomLabel.textContent = `${this.level}%`;
      this.zoomLabel.animate([
        { opacity: 1 },
        { opacity: 1, offset: 0.75 },
        { opacity: 0 },
      ], { duration: 1000 });
    },
  };

  if (peek.theme) body.setAttribute('data-theme', peek.theme);
  if (peek.ctx === 'webview') zoom.init();

  // hooks that useful_web may set
  let usefulWebCloseAllPanels: (() => void) | undefined;
  let usefulWebOnPreviewDone: (() => void) | undefined;

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const ctrl: Record<string, () => void> = {
      '=': zoom.up.bind(zoom),
      '-': zoom.down.bind(zoom),
      '0': zoom.reset.bind(zoom),
    };
    const plain: Record<string, () => void> = {
      'j': () => {
        window.scrollBy({ top: 50 });
      },
      'k': () => {
        window.scrollBy({ top: -50 });
      },
      'd': () => {
        window.scrollBy({ top: window.innerHeight / 2 });
      },
      'u': () => {
        window.scrollBy({ top: -window.innerHeight / 2 });
      },
      'g': () => {
        window.scrollTo({ top: 0 });
      },
      'G': () => {
        window.scrollTo({ top: document.body.scrollHeight });
      },
      'Escape': () => usefulWebCloseAllPanels?.(),
    };
    const action = event.ctrlKey && peek.ctx === 'webview' ? ctrl[event.key] : plain[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  });

  onload = () => {
    const item = sessionStorage.getItem('session');
    if (item && !receivedServerState) {
      const session = JSON.parse(item);
      onDocument({ documentId: session.documentId });
      base.href = session.base;
      onPreview({ html: session.html, lcount: session.lcount });
      onScroll({ line: session.line });
    }
  };

  onbeforeunload = () => {
    sessionStorage.setItem(
      'session',
      JSON.stringify({
        base: base.href,
        html: markdownBody.innerHTML,
        lcount: source?.lcount,
        line: scroll?.line,
        documentId,
      }),
    );
  };

  const decoder = new TextDecoder();
  const socket = new WebSocket(`ws://${peek.serverUrl}/`);

  socket.binaryType = 'arraybuffer';

  socket.onclose = (event) => {
    if (!event.wasClean) {
      close();
      location.reload();
    }
  };

  // ── useful_web extensions ────────────────────────────────────────────
  // All sidebar / file-tree / navigation code lives here.
  // When useful_web=false this block is never entered — zero overhead.
  interface FileEntry {
    name: string;
    path: string;
    isDir: boolean;
  }

  interface ViewerTab {
    id: number;
    path: string;
    label: string;
    active: boolean;
  }

  let usefulWebOnBase: ((basePath: string) => void) | undefined;
  let usefulWebOnDirlist: ((data: { path: string; entries: FileEntry[] }) => void) | undefined;
  let usefulWebOnTabs: ((data: { tabs: ViewerTab[] }) => void) | undefined;

  if (peek.usefulWeb) {
    const pendingDirRequests = new Map<string, { container: HTMLElement; depth: number }>();
    let rootDirPath = '';

    // sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'peek-sidebar';

    const tocBtn = document.createElement('button');
    tocBtn.id = 'peek-btn-toc';
    tocBtn.className = 'peek-sidebar-btn';
    tocBtn.title = 'Table of Contents';
    tocBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

    const filesBtn = document.createElement('button');
    filesBtn.id = 'peek-btn-files';
    filesBtn.className = 'peek-sidebar-btn';
    filesBtn.title = 'File Explorer';
    filesBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

    sidebar.append(tocBtn, filesBtn);

    function createPanel(title: string, id: string): HTMLElement {
      const panel = document.createElement('div');
      panel.id = id;
      panel.className = 'peek-side-panel';
      panel.innerHTML =
        `<div class="peek-panel-header"><span>${title}</span><button class="peek-panel-close">✕</button></div><div class="peek-panel-body"></div>`;
      panel.querySelector('.peek-panel-close')!.addEventListener('click', () => closeAllPanels());
      return panel;
    }

    const tocPanel = createPanel('Table of Contents', 'peek-toc-panel');
    const tocList = tocPanel.querySelector('.peek-panel-body') as HTMLElement;
    const filesPanel = createPanel('Files', 'peek-files-panel');
    const filesTree = filesPanel.querySelector('.peek-panel-body') as HTMLElement;

    const viewerTabs = document.createElement('div');
    viewerTabs.id = 'peek-viewer-tabs';
    viewerTabs.setAttribute('role', 'tablist');
    viewerTabs.setAttribute('aria-label', 'Open Markdown files');
    document.body.insertBefore(viewerTabs, markdownBody);

    const fileActions = document.createElement('div');
    fileActions.id = 'peek-file-actions';
    fileActions.setAttribute('role', 'dialog');
    fileActions.setAttribute('aria-label', 'Open Markdown file');

    const openHereBtn = document.createElement('button');
    openHereBtn.type = 'button';
    openHereBtn.className = 'peek-file-action';
    openHereBtn.textContent = '>';
    openHereBtn.title = 'Open here';
    openHereBtn.setAttribute('aria-label', 'Open here');

    const openTabBtn = document.createElement('button');
    openTabBtn.type = 'button';
    openTabBtn.className = 'peek-file-action';
    openTabBtn.textContent = '+';
    openTabBtn.title = 'Open in new tab';
    openTabBtn.setAttribute('aria-label', 'Open in new tab');

    fileActions.append(openHereBtn, openTabBtn);

    let selectedFile: FileEntry | undefined;
    let selectedTreeItem: HTMLElement | undefined;

    document.body.classList.add('peek-sidebar-active');
    document.body.append(sidebar, tocPanel, filesPanel, fileActions);

    const interactiveSourceTargets = [
      'a',
      'button',
      'input',
      'select',
      'textarea',
      'option',
      'label',
      'summary',
      'audio',
      'video',
      '[role="button"]',
      '[role="link"]',
      '[contenteditable]:not([contenteditable="false"])',
      '[onclick]',
    ].join(',');

    function getSourceLine(target: Element) {
      if (!source) return;

      for (
        let element: Element | null = target;
        element && element !== markdownBody;
        element = element.parentElement
      ) {
        for (const attribute of ['data-source-line', 'data-line-begin']) {
          const line = Number(element.getAttribute(attribute));
          if (Number.isInteger(line) && line >= 1 && line <= source.lcount) return line;
        }
      }
    }

    markdownBody.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        documentId === undefined ||
        socket.readyState !== WebSocket.OPEN ||
        !window.getSelection()?.isCollapsed ||
        !(event.target instanceof Element) ||
        event.target.closest(interactiveSourceTargets)
      ) {
        return;
      }

      const line = getSourceLine(event.target);
      if (line === undefined) return;

      pendingBrowserLines.set(line, performance.now());
      socket.send(JSON.stringify({ action: 'source', line, documentId }));
    });

    function closeFileActions() {
      fileActions.classList.remove('open');
      fileActions.removeAttribute('data-path');
      selectedTreeItem?.classList.remove('peek-tree-selected');
      selectedFile = undefined;
      selectedTreeItem = undefined;
    }

    function showFileActions(entry: FileEntry, item: HTMLElement) {
      if (selectedFile?.path === entry.path && fileActions.classList.contains('open')) {
        closeFileActions();
        return;
      }

      closeFileActions();
      selectedFile = entry;
      selectedTreeItem = item;
      selectedTreeItem.classList.add('peek-tree-selected');
      fileActions.dataset.path = entry.path;
      fileActions.classList.add('open');

      const itemRect = item.getBoundingClientRect();
      const actionsRect = fileActions.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, itemRect.right - actionsRect.width),
        window.innerWidth - actionsRect.width - 8,
      );
      const top = itemRect.bottom + actionsRect.height + 4 <= window.innerHeight
        ? itemRect.bottom + 4
        : itemRect.top - actionsRect.height - 4;

      fileActions.style.left = `${left}px`;
      fileActions.style.top = `${Math.max(8, top)}px`;
      openHereBtn.focus();
    }

    function openSelectedFile(tab: boolean) {
      if (!selectedFile) return;
      socket.send(JSON.stringify({ action: 'openfile', path: selectedFile.path, tab }));
      closeFileActions();
    }

    openHereBtn.addEventListener('click', () => openSelectedFile(false));
    openTabBtn.addEventListener('click', () => openSelectedFile(true));
    filesTree.addEventListener('scroll', closeFileActions);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (!fileActions.contains(target) && !selectedTreeItem?.contains(target)) {
        closeFileActions();
      }
    });

    function closeAllPanels() {
      closeFileActions();
      tocPanel.classList.remove('open');
      filesPanel.classList.remove('open');
      tocBtn.classList.remove('active');
      filesBtn.classList.remove('active');
      document.body.classList.remove('peek-panel-open');
    }
    usefulWebCloseAllPanels = closeAllPanels;

    function renderViewerTabs(tabs: ViewerTab[]) {
      viewerTabs.replaceChildren();
      if (tabs.length === 0) {
        viewerTabs.classList.remove('open');
        return;
      }

      viewerTabs.classList.add('open');
      let activeButton: HTMLButtonElement | undefined;

      tabs.forEach((tab) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'peek-viewer-tab';
        button.dataset.tabId = String(tab.id);
        button.textContent = tab.label;
        button.title = tab.path;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(tab.active));
        button.addEventListener('click', () => {
          socket.send(JSON.stringify({ action: 'selecttab', tabId: tab.id }));
        });

        if (tab.active) {
          button.classList.add('active');
          activeButton = button;
        }

        viewerTabs.appendChild(button);
      });

      if (activeButton) {
        const left = activeButton.offsetLeft;
        const right = left + activeButton.offsetWidth;
        if (left < viewerTabs.scrollLeft) viewerTabs.scrollLeft = left;
        if (right > viewerTabs.scrollLeft + viewerTabs.clientWidth) {
          viewerTabs.scrollLeft = right - viewerTabs.clientWidth;
        }
      }

      if (scroll) onScroll(scroll);
    }

    function initFilesTree() {
      closeFileActions();
      filesTree.innerHTML = '';
      if (!rootDirPath) return;
      const parentPath = rootDirPath.replace(/\/[^/]+$/, '') || rootDirPath;
      if (parentPath !== rootDirPath) {
        const upItem = document.createElement('div');
        upItem.className = 'peek-tree-item peek-tree-updir';
        upItem.style.paddingLeft = '12px';
        upItem.textContent = '↑ ../';
        upItem.addEventListener('click', () => {
          rootDirPath = parentPath;
          initFilesTree();
        });
        filesTree.appendChild(upItem);
      }
      pendingDirRequests.set(rootDirPath, { container: filesTree, depth: 0 });
      socket.send(JSON.stringify({ action: 'listdir', path: rootDirPath }));
    }

    function buildToc() {
      tocList.innerHTML = '';
      markdownBody.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
        const item = document.createElement('div');
        item.className = 'peek-toc-item';
        item.dataset.level = h.tagName[1];
        item.textContent = h.textContent ?? '';
        item.addEventListener('click', () => h.scrollIntoView({ behavior: 'smooth' }));
        tocList.appendChild(item);
      });
    }

    function renderFileTree(container: HTMLElement, entries: FileEntry[], depth: number) {
      entries.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'peek-tree-item';
        item.dataset.path = entry.path;
        item.style.paddingLeft = `${12 + depth * 12}px`;
        item.textContent = (entry.isDir ? '▶ ' : '  ') + entry.name;

        if (entry.isDir) {
          item.classList.add('peek-tree-dir');
          const children = document.createElement('div');
          children.className = 'peek-tree-children';
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = item.classList.toggle('open');
            item.textContent = (isOpen ? '▼ ' : '▶ ') + entry.name;
            item.style.paddingLeft = `${12 + depth * 12}px`;
            if (isOpen && children.children.length === 0) {
              pendingDirRequests.set(entry.path, { container: children, depth: depth + 1 });
              socket.send(JSON.stringify({ action: 'listdir', path: entry.path }));
            }
            children.style.display = isOpen ? 'block' : 'none';
          });
          container.append(item, children);
        } else if (/\.mdx?$|\.markdown$/i.test(entry.name)) {
          item.title = 'Choose where to open';
          item.setAttribute('role', 'button');
          item.tabIndex = 0;
          item.addEventListener('click', () => {
            showFileActions(entry, item);
          });
          item.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            showFileActions(entry, item);
          });
          container.appendChild(item);
        } else {
          item.classList.add('peek-tree-nonmd');
          container.appendChild(item);
        }
      });
    }

    tocBtn.addEventListener('click', () => {
      const opening = !tocPanel.classList.contains('open');
      closeAllPanels();
      if (opening) {
        tocPanel.classList.add('open');
        tocBtn.classList.add('active');
        document.body.classList.add('peek-panel-open');
        buildToc();
      }
    });

    filesBtn.addEventListener('click', () => {
      const opening = !filesPanel.classList.contains('open');
      closeAllPanels();
      if (opening) {
        filesPanel.classList.add('open');
        filesBtn.classList.add('active');
        document.body.classList.add('peek-panel-open');
        if (filesTree.children.length === 0 && rootDirPath) {
          initFilesTree();
        }
      }
    });

    // handlers exposed to the message loop below
    usefulWebOnBase = (basePath: string) => {
      rootDirPath = basePath.replace(/\/$/, '');
      if (filesPanel.classList.contains('open') && rootDirPath) {
        initFilesTree();
      }
    };

    usefulWebOnDirlist = (data) => {
      const entry = pendingDirRequests.get(data.path);
      if (entry) {
        renderFileTree(entry.container, data.entries, entry.depth);
        pendingDirRequests.delete(data.path);
      }
    };

    usefulWebOnTabs = (data) => {
      renderViewerTabs(Array.isArray(data.tabs) ? data.tabs : []);
    };

    usefulWebOnPreviewDone = () => {
      if (tocPanel.classList.contains('open')) buildToc();
    };
  }
  // ── end useful_web ────────────────────────────────────────────────────

  socket.onmessage = (event) => {
    const data = JSON.parse(decoder.decode(event.data));
    if (['show', 'scroll', 'base', 'document', 'tabs'].includes(data.action)) {
      receivedServerState = true;
    }

    switch (data.action) {
      case 'show':
        onPreview(data);
        break;
      case 'scroll':
        onScroll(data);
        break;
      case 'document':
        onDocument(data);
        break;
      case 'tabs':
        usefulWebOnTabs?.(data);
        break;
      case 'base':
        base.href = data.base;
        usefulWebOnBase?.(data.base);
        break;
      case 'dirlist':
        usefulWebOnDirlist?.(data);
        break;
      default:
        break;
    }
  };

  const onPreview = (() => {
    mermaid.init();

    const renderMermaid = debounce(
      (() => {
        const parser = new DOMParser();

        async function render(el: Element) {
          const svg = await mermaid.render(
            `${el.id}-svg`,
            el.getAttribute('data-graph-definition')!,
            el,
          );

          if (svg) {
            const svgElement = parser.parseFromString(svg, 'text/html').body;
            el.appendChild(svgElement);
            el.parentElement?.style.setProperty(
              'height',
              window.getComputedStyle(svgElement).getPropertyValue('height'),
            );
          }
        }

        return () => {
          Array.from(markdownBody.querySelectorAll('div[data-graph="mermaid"]'))
            .filter((el) => !el.querySelector('svg'))
            .forEach(render);
        };
      })(),
      200,
    );

    const morphdomOptions: Parameters<typeof morphdom>[2] = {
      childrenOnly: true,
      getNodeKey: (node) => {
        if (node instanceof HTMLElement && node.getAttribute('data-graph') === 'mermaid') {
          return node.id;
        }
        return null;
      },
      onNodeAdded: (node) => {
        if (node instanceof HTMLElement && node.getAttribute('data-graph') === 'mermaid') {
          renderMermaid();
        }
        return node;
      },
      onBeforeElUpdated: (fromEl: HTMLElement, toEl: HTMLElement) => {
        if (fromEl.hasAttribute('open')) {
          toEl.setAttribute('open', 'true');
        } else if (
          fromEl.classList.contains('peek-mermaid-container') &&
          toEl.classList.contains('peek-mermaid-container')
        ) {
          toEl.style.height = fromEl.style.height;
        }
        return !fromEl.isEqualNode(toEl);
      },
      onBeforeElChildrenUpdated(_, toEl) {
        return toEl.getAttribute('data-graph') !== 'mermaid';
      },
    };

    function updateBlocks() {
      blocks = slidingWindows(Array.from(markdownBody.querySelectorAll('[data-line-begin]')), 2, {
        step: 1,
        partial: true,
      });
    }

    const mutationObserver = new MutationObserver(updateBlocks);

    const resizeObserver = new ResizeObserver(() => {
      if (scroll) onScroll(scroll);
    });

    mutationObserver.observe(markdownBody, { childList: true });
    resizeObserver.observe(markdownBody);

    return (data: { html: string; lcount: number }) => {
      source = { lcount: data.lcount };
      morphdom(markdownBody, `<main>${data.html}</main>`, morphdomOptions);
      updateBlocks();
      usefulWebOnPreviewDone?.();
    };
  })();

  function getOffset(elem: HTMLElement): number {
    let current: HTMLElement | null = elem;
    let top = 0;

    while (top === 0 && current) {
      top = current.getBoundingClientRect().top;
      current = current.parentElement;
    }

    return top + window.scrollY;
  }

  function onDocument(data: { documentId: number }) {
    if (!Number.isInteger(data.documentId) || data.documentId < 1) return;

    documentId = data.documentId;
    source = undefined;
    blocks = undefined;
    scroll = undefined;
    lastBrowserLine = undefined;
    pendingBrowserLines.clear();
    clearTimeout(browserScrollTimer);
    browserScrollTimer = undefined;
    clearTimeout(suppressBrowserScrollTimer);
    suppressBrowserScroll = true;
    suppressBrowserScrollTimer = setTimeout(() => {
      suppressBrowserScroll = false;
    }, 250);
  }

  function getBlockOnLine(line: number) {
    return findLast(blocks, (block) => line >= Number(block[0].dataset.lineBegin));
  }

  function getLineAtOffset(offset: number): number | undefined {
    if (!blocks || !blocks[0] || !source) return;

    const block = findLast(blocks, (item) => offset >= getOffset(item[0])) || blocks[0];
    const target = block[0];
    const next = block[1];
    const offsetBegin = getOffset(target);
    const offsetEnd = next ? getOffset(next) : offsetBegin + target.getBoundingClientRect().height;
    const lineBegin = Number(target.dataset.lineBegin);
    const lineEnd = next ? Number(next.dataset.lineBegin) : source.lcount + 1;
    const pixPerLine = (offsetEnd - offsetBegin) / (lineEnd - lineBegin);
    const line = pixPerLine > 0
      ? lineBegin + Math.floor((offset - offsetBegin) / pixPerLine)
      : lineBegin;

    return Math.max(1, Math.min(line, source.lcount));
  }

  const onScroll = (data: { line: number | string; documentId?: number }) => {
    const line = Number(data.line);
    if (!Number.isInteger(line) || line < 1) return;
    if (data.documentId !== undefined && data.documentId !== documentId) return;

    scroll = { line };

    const sentAt = pendingBrowserLines.get(line);
    if (sentAt !== undefined && performance.now() - sentAt < 1000) {
      pendingBrowserLines.delete(line);
      return;
    }

    clearTimeout(browserScrollTimer);
    browserScrollTimer = undefined;
    pendingBrowserLines.clear();
    lastBrowserLine = undefined;

    if (!blocks || !blocks[0] || !source) return;

    const block = getBlockOnLine(line) || blocks[0];
    const target = block[0];
    const next = block[1];

    const offsetBegin = getOffset(target);
    const offsetEnd = next ? getOffset(next) : offsetBegin + target.getBoundingClientRect().height;

    const lineBegin = Number(target.dataset.lineBegin);
    const lineEnd = next ? Number(next.dataset.lineBegin) : source.lcount + 1;

    const pixPerLine = (offsetEnd - offsetBegin) / (lineEnd - lineBegin);
    const scrollPix = (line - lineBegin) * pixPerLine;

    suppressBrowserScroll = true;
    window.scroll({ top: offsetBegin + scrollPix - window.innerHeight / 2 + pixPerLine / 2 });
    clearTimeout(suppressBrowserScrollTimer);
    suppressBrowserScrollTimer = setTimeout(() => {
      suppressBrowserScroll = false;
    }, 50);
  };

  function reportBrowserScroll() {
    const line = getLineAtOffset(window.scrollY + window.innerHeight / 2);
    if (
      line === undefined ||
      line === lastBrowserLine ||
      documentId === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const now = performance.now();
    for (const [pendingLine, sentAt] of pendingBrowserLines) {
      if (now - sentAt >= 1000) pendingBrowserLines.delete(pendingLine);
    }

    lastBrowserLine = line;
    scroll = { line };
    pendingBrowserLines.set(line, now);
    socket.send(JSON.stringify({ action: 'scroll', line, documentId }));
  }

  window.addEventListener('scroll', () => {
    if (!peek.syncScroll || suppressBrowserScroll || browserScrollTimer !== undefined) return;

    browserScrollTimer = setTimeout(() => {
      browserScrollTimer = undefined;
      if (!suppressBrowserScroll) reportBrowserScroll();
    }, 100);
  }, { passive: true });
});
