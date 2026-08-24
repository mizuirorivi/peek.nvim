import { debounce, getInjectConfig } from './util.ts';
// @deno-types="https://raw.githubusercontent.com/patrick-steele-idem/morphdom/master/index.d.ts"
import morphdom from 'https://esm.sh/morphdom@2.7.2?no-dts';
import DOMPurify from 'https://esm.sh/dompurify@3.2.6';
import mermaid from './mermaid.ts';

const window = globalThis;
// const _log = Reflect.get(window, '_log');

addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const markdownBody = document.getElementById('peek-markdown-body') as HTMLDivElement;
  const base = document.getElementById('peek-base') as HTMLBaseElement;
  const peek = getInjectConfig();
  let source: { lcount: number; token: string } | undefined;
  let blocks: HTMLElement[] = [];
  let scroll: { line: number; documentId: number; version: number } | undefined;
  let documentId: number | undefined;
  let documentKey: string | undefined;
  let documentVersion: number | undefined;
  let documentChanged = true;
  let pendingHashRestore = false;
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
  let usefulWebRestoreHash: (() => void) | undefined;

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

  const decoder = new TextDecoder();
  const socket = new WebSocket(
    `ws://${peek.serverUrl}/__peek_socket__?token=${encodeURIComponent(peek.token || '')}`,
  );

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

  interface OpenTarget {
    path: string;
    documentId: number;
    version: number;
    fragment?: string;
  }

  interface RouteResult {
    requestId: number;
    documentId: number;
    version: number;
    kind: 'error' | 'fragment' | 'markdown' | 'opened';
    message?: string;
    path?: string;
    fragment?: string;
  }

  let usefulWebOnBase: ((basePath: string) => void) | undefined;
  let usefulWebOnDirlist: ((data: { path: string; entries: FileEntry[] }) => void) | undefined;
  let usefulWebOnTabs: ((data: { tabs: ViewerTab[] }) => void) | undefined;
  let usefulWebOnRouteResult: ((data: RouteResult) => void) | undefined;
  let usefulWebOnNavigate:
    | ((data: { documentId: number; version: number; fragment: string }) => void)
    | undefined;
  let usefulWebOnDocument: (() => void) | undefined;

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

    const openActions = document.createElement('div');
    openActions.id = 'peek-file-actions';
    openActions.setAttribute('role', 'dialog');
    openActions.setAttribute('aria-label', 'Open Markdown file');

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

    openActions.append(openHereBtn, openTabBtn);

    const linkStatus = document.createElement('div');
    linkStatus.id = 'peek-link-status';
    linkStatus.setAttribute('role', 'status');
    linkStatus.setAttribute('aria-live', 'polite');

    let selectedOpenTarget: OpenTarget | undefined;
    let selectedOpenTrigger: HTMLElement | undefined;
    let linkStatusTimer: number | undefined;

    document.body.classList.add('peek-sidebar-active');
    document.body.append(sidebar, tocPanel, filesPanel, openActions, linkStatus);

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
        if (element.getAttribute('data-peek-source') !== source.token) continue;
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
        documentVersion === undefined ||
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
      socket.send(JSON.stringify({ action: 'source', line, documentId, version: documentVersion }));
    });

    let nextLinkRequestId = 0;
    const pendingLinkRequests = new Map<
      number,
      {
        trigger: HTMLAnchorElement;
        openInTab: boolean;
        documentId: number;
        version: number;
        timeout: number;
      }
    >();
    const pendingLinkTriggers = new Map<HTMLAnchorElement, number>();

    function showLinkStatus(message: string) {
      clearTimeout(linkStatusTimer);
      linkStatus.textContent = message;
      linkStatus.classList.add('open');
      linkStatusTimer = setTimeout(() => linkStatus.classList.remove('open'), 3000);
    }

    function clearLinkStatus() {
      clearTimeout(linkStatusTimer);
      linkStatus.classList.remove('open');
    }

    function scrollToFragment(fragment: string, encoded = false) {
      let targetName = fragment;
      if (encoded) {
        try {
          targetName = decodeURIComponent(fragment);
        } catch (_) {
          showLinkStatus('Invalid link fragment');
          return;
        }
      }

      if (targetName === '') {
        window.scrollTo({ top: 0 });
      } else {
        const exactId = document.getElementById(targetName);
        const headingId = document.getElementById(`peek-heading-${targetName}`);
        const byId = exactId && markdownBody.contains(exactId)
          ? exactId
          : headingId && markdownBody.contains(headingId)
          ? headingId
          : undefined;
        const byName = byId ? undefined : Array.from(markdownBody.querySelectorAll('[name]'))
          .find((element) => element.getAttribute('name') === targetName);
        const target = byId || byName;
        if (!target) {
          showLinkStatus(`Section not found: ${targetName}`);
          return;
        }
        target.scrollIntoView({ block: 'start' });
      }

      const url = new URL(location.href);
      url.hash = targetName;
      history.replaceState(null, '', url);
    }

    function openTarget(target: OpenTarget, tab: boolean) {
      if (
        documentId !== target.documentId ||
        documentVersion !== target.version ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      socket.send(JSON.stringify({
        action: 'openfile',
        path: target.path,
        tab,
        documentId: target.documentId,
        version: target.version,
        ...(target.fragment !== undefined ? { fragment: target.fragment } : {}),
      }));
    }

    function getBrowserExternalLink(href: string) {
      const value = href.startsWith('//') ? `https:${href}` : href;
      try {
        const url = new URL(value);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      } catch (_) { /**/ }
    }

    function routeLink(event: MouseEvent) {
      const isPrimary = event.type === 'click' && event.button === 0;
      const isMiddle = event.type === 'auxclick' && event.button === 1;
      if (
        (!isPrimary && !isMiddle) || event.defaultPrevented || !(event.target instanceof Element)
      ) {
        return;
      }

      const anchor = event.target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !markdownBody.contains(anchor)) return;

      const href = anchor.getAttribute('href');
      if (href === null) return;
      const browserExternal = peek.ctx === 'browser' ? getBrowserExternalLink(href) : undefined;
      if (browserExternal) {
        anchor.href = browserExternal;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      closeOpenActions();

      if (href === '' || href.startsWith('#')) {
        scrollToFragment(href.slice(1), true);
        return;
      }

      if (
        documentId === undefined ||
        documentVersion === undefined ||
        socket.readyState !== WebSocket.OPEN
      ) {
        showLinkStatus('Preview connection is unavailable');
        return;
      }
      if (pendingLinkTriggers.has(anchor)) {
        showLinkStatus('Link request is already in progress');
        return;
      }

      nextLinkRequestId += 1;
      const requestId = nextLinkRequestId;
      const timeout = setTimeout(() => {
        const request = pendingLinkRequests.get(requestId);
        if (!request) return;
        pendingLinkRequests.delete(requestId);
        pendingLinkTriggers.delete(request.trigger);
        showLinkStatus('Link request timed out');
      }, 10000);
      pendingLinkRequests.set(nextLinkRequestId, {
        trigger: anchor,
        openInTab: isMiddle || event.ctrlKey || event.metaKey || event.shiftKey,
        documentId,
        version: documentVersion,
        timeout,
      });
      pendingLinkTriggers.set(anchor, nextLinkRequestId);
      showLinkStatus('Opening link...');
      socket.send(
        JSON.stringify({
          action: 'route',
          requestId: nextLinkRequestId,
          documentId,
          version: documentVersion,
          href,
        }),
      );
    }

    markdownBody.addEventListener('click', routeLink, true);
    markdownBody.addEventListener('auxclick', routeLink, true);

    function closeOpenActions() {
      openActions.classList.remove('open');
      openActions.removeAttribute('data-path');
      selectedOpenTrigger?.classList.remove('peek-open-selected');
      selectedOpenTarget = undefined;
      selectedOpenTrigger = undefined;
    }

    function showOpenActions(target: OpenTarget, trigger: HTMLElement) {
      if (
        selectedOpenTarget?.path === target.path &&
        selectedOpenTarget.fragment === target.fragment &&
        selectedOpenTrigger === trigger &&
        openActions.classList.contains('open')
      ) {
        closeOpenActions();
        return;
      }

      closeOpenActions();
      selectedOpenTarget = target;
      selectedOpenTrigger = trigger;
      selectedOpenTrigger.classList.add('peek-open-selected');
      openActions.dataset.path = target.path;
      openActions.classList.add('open');

      const itemRect = trigger.getBoundingClientRect();
      const actionsRect = openActions.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, itemRect.right - actionsRect.width),
        window.innerWidth - actionsRect.width - 8,
      );
      const top = itemRect.bottom + actionsRect.height + 4 <= window.innerHeight
        ? itemRect.bottom + 4
        : itemRect.top - actionsRect.height - 4;

      openActions.style.left = `${left}px`;
      openActions.style.top = `${Math.max(8, top)}px`;
      openHereBtn.focus();
    }

    function openSelectedTarget(tab: boolean) {
      if (!selectedOpenTarget) return;
      openTarget(selectedOpenTarget, tab);
      closeOpenActions();
    }

    openHereBtn.addEventListener('click', () => openSelectedTarget(false));
    openTabBtn.addEventListener('click', () => openSelectedTarget(true));
    filesTree.addEventListener('scroll', closeOpenActions);
    window.addEventListener('scroll', closeOpenActions, { passive: true });
    window.addEventListener('resize', closeOpenActions);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (!openActions.contains(target) && !selectedOpenTrigger?.contains(target)) {
        closeOpenActions();
      }
    });

    function closeAllPanels() {
      closeOpenActions();
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
      closeOpenActions();
      filesTree.innerHTML = '';
      if (!rootDirPath) return;
      const parentPath = (() => {
        if (/^[\\/]+$/.test(rootDirPath) || /^[a-z]:[\\/]$/i.test(rootDirPath)) {
          return rootDirPath;
        }
        const path = rootDirPath.replace(/[\\/]+$/, '');
        const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (lastSeparator < 0) return rootDirPath;
        if (lastSeparator === 0) return path[0];
        if (lastSeparator === 2 && /^[a-z]:/i.test(path)) return path.slice(0, 3);
        return path.slice(0, lastSeparator);
      })();
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
            if (documentId !== undefined && documentVersion !== undefined) {
              showOpenActions({ path: entry.path, documentId, version: documentVersion }, item);
            }
          });
          item.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (documentId !== undefined && documentVersion !== undefined) {
              showOpenActions({ path: entry.path, documentId, version: documentVersion }, item);
            }
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
      pendingDirRequests.clear();
      filesTree.replaceChildren();
      closeOpenActions();
      rootDirPath = basePath.replace(/[\\/]$/, '');
      if (/^[a-z]:$/i.test(rootDirPath)) rootDirPath += '\\';
      if (rootDirPath === '') rootDirPath = basePath;
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

    usefulWebOnRouteResult = (data) => {
      const request = pendingLinkRequests.get(data.requestId);
      pendingLinkRequests.delete(data.requestId);
      if (request) {
        clearTimeout(request.timeout);
        pendingLinkTriggers.delete(request.trigger);
      }
      if (
        !request ||
        request.documentId !== data.documentId ||
        request.version !== data.version ||
        documentId !== data.documentId ||
        documentVersion !== data.version
      ) {
        return;
      }

      if (data.kind === 'error') {
        showLinkStatus(data.message || 'Could not open link');
      } else if (data.kind === 'fragment') {
        clearLinkStatus();
        scrollToFragment(data.fragment || '');
      } else if (data.kind === 'markdown' && data.path) {
        clearLinkStatus();
        const target = {
          path: data.path,
          fragment: data.fragment,
          documentId: data.documentId,
          version: data.version,
        };
        if (request.openInTab) {
          openTarget(target, true);
        } else if (request.trigger.isConnected) {
          showOpenActions(target, request.trigger);
        }
      } else if (data.kind === 'opened') {
        showLinkStatus('Opened external link');
      }
    };

    usefulWebOnNavigate = (data) => {
      if (data.documentId === documentId && data.version === documentVersion) {
        scrollToFragment(data.fragment);
      }
    };
    usefulWebRestoreHash = () => scrollToFragment(location.hash.slice(1), true);

    usefulWebOnDocument = () => {
      pendingLinkRequests.forEach((request) => clearTimeout(request.timeout));
      pendingLinkRequests.clear();
      pendingLinkTriggers.clear();
      closeOpenActions();
    };

    usefulWebOnPreviewDone = () => {
      if (tocPanel.classList.contains('open')) buildToc();
    };
  } else {
    const blockLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('a[href]')) return;
      event.preventDefault();
      event.stopPropagation();
    };
    markdownBody.addEventListener('click', blockLink, true);
    markdownBody.addEventListener('auxclick', blockLink, true);
  }
  // ── end useful_web ────────────────────────────────────────────────────

  socket.onmessage = (event) => {
    const data = JSON.parse(decoder.decode(event.data));

    switch (data.action) {
      case 'show':
        onPreview(data);
        break;
      case 'scroll':
        onScroll(data);
        break;
      case 'document':
        onDocument(data);
        usefulWebOnDocument?.();
        break;
      case 'updating':
        if (
          data.documentId === documentId &&
          data.documentKey === documentKey &&
          Number.isInteger(data.version) &&
          data.version > (documentVersion ?? -1)
        ) {
          documentVersion = data.version;
          source = undefined;
          blocks = [];
          resetScrollSync();
          markdownBody.inert = true;
          markdownBody.setAttribute('aria-busy', 'true');
          usefulWebOnDocument?.();
        }
        break;
      case 'tabs':
        usefulWebOnTabs?.(data);
        break;
      case 'base':
        if (typeof data.url === 'string') base.href = data.url;
        if (typeof data.path === 'string') usefulWebOnBase?.(data.path);
        break;
      case 'dirlist':
        usefulWebOnDirlist?.(data);
        break;
      case 'routeResult':
        usefulWebOnRouteResult?.(data);
        break;
      case 'navigate':
        usefulWebOnNavigate?.(data);
        break;
      default:
        break;
    }
  };

  const onPreview = (() => {
    const renderingMermaid = new WeakSet<Element>();
    const renderMermaid = debounce(
      (() => {
        const parser = new DOMParser();

        async function render(el: Element) {
          if (renderingMermaid.has(el)) return;
          renderingMermaid.add(el);
          const renderDocumentId = documentId;
          const renderDocumentKey = documentKey;
          const renderVersion = documentVersion;
          const elementId = el.id;
          const definition = el.querySelector('.peek-mermaid-definition')?.textContent || '';
          const container = document.createElement('div');
          container.style.cssText =
            'position:fixed;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none';
          document.body.appendChild(container);
          try {
            const svg = await mermaid.render(
              `${elementId}-svg`,
              definition,
              container,
            );

            const isCurrent = el.isConnected &&
              renderDocumentId === documentId &&
              renderDocumentKey === documentKey &&
              renderVersion === documentVersion &&
              elementId === el.id;
            if (svg && isCurrent) {
              const svgElement = parser.parseFromString(svg, 'image/svg+xml').documentElement;
              if (svgElement.localName === 'svg') {
                el.replaceChildren(svgElement);
                el.parentElement?.style.setProperty(
                  'height',
                  window.getComputedStyle(svgElement).getPropertyValue('height'),
                );
                return;
              }
            }

            if (isCurrent) {
              const error = document.createElement('div');
              error.className = 'peek-mermaid-error';
              error.textContent = 'Could not render diagram';
              el.replaceChildren(error);
            }
          } finally {
            container.remove();
            renderingMermaid.delete(el);
            if (
              el.isConnected &&
              (renderDocumentId !== documentId ||
                renderDocumentKey !== documentKey ||
                renderVersion !== documentVersion)
            ) {
              renderMermaid();
            }
          }
        }

        return () => {
          Array.from(markdownBody.querySelectorAll('div[data-graph="mermaid"]'))
            .filter((el) => !el.querySelector('svg') && !renderingMermaid.has(el))
            .forEach(render);
        };
      })(),
      200,
    );

    const morphdomOptions: Parameters<typeof morphdom>[2] = {
      childrenOnly: true,
      getNodeKey: (node) => {
        if (
          !documentChanged &&
          node instanceof HTMLElement &&
          node.getAttribute('data-graph') === 'mermaid'
        ) {
          return node.id;
        }
        return null;
      },
      onBeforeElUpdated: (fromEl: HTMLElement, toEl: HTMLElement) => {
        if (!documentChanged && fromEl.hasAttribute('open')) {
          toEl.setAttribute('open', 'true');
        } else if (
          !documentChanged &&
          fromEl.classList.contains('peek-mermaid-container') &&
          toEl.classList.contains('peek-mermaid-container')
        ) {
          toEl.style.height = fromEl.style.height;
        }
        return !fromEl.isEqualNode(toEl);
      },
      onBeforeElChildrenUpdated(fromEl, toEl) {
        return !(
          !documentChanged &&
          toEl.getAttribute('data-graph') === 'mermaid' &&
          (fromEl.querySelector('svg') || renderingMermaid.has(fromEl))
        );
      },
    };

    function updateBlocks() {
      let previousLine = 0;
      blocks = Array.from(markdownBody.querySelectorAll<HTMLElement>('[data-line-begin]'))
        .filter((element) => {
          if (element.getAttribute('data-peek-source') !== source?.token) return false;
          const line = Number(element.dataset.lineBegin);
          if (!Number.isInteger(line) || line <= previousLine || line > (source?.lcount || 0)) {
            return false;
          }
          previousLine = line;
          return true;
        });
    }

    let resizeFrame: number | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (!scroll || resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (scroll) onScroll(scroll);
      });
    });

    resizeObserver.observe(markdownBody);

    return (data: {
      documentId: number;
      documentKey: string;
      version: number;
      html: string;
      lcount: number;
      sourceToken: string;
    }) => {
      if (
        data.documentId !== documentId ||
        data.documentKey !== documentKey ||
        documentVersion === undefined ||
        data.version < documentVersion ||
        typeof data.sourceToken !== 'string' ||
        data.sourceToken === ''
      ) {
        return;
      }

      if (data.version > documentVersion) usefulWebOnDocument?.();
      documentVersion = data.version;
      source = { lcount: data.lcount, token: data.sourceToken };
      const html = DOMPurify.sanitize(data.html, {
        ADD_ATTR: ['data-graph', 'data-line-begin', 'data-source-line', 'data-peek-source'],
      });
      morphdom(markdownBody, `<main>${html}</main>`, morphdomOptions);
      documentChanged = false;
      markdownBody.inert = false;
      markdownBody.removeAttribute('aria-busy');
      updateBlocks();
      if (scroll) onScroll(scroll);
      renderMermaid();
      usefulWebOnPreviewDone?.();
      if (pendingHashRestore) {
        const restoreDocumentId = documentId;
        const restoreVersion = documentVersion;
        setTimeout(() => {
          if (
            pendingHashRestore &&
            restoreDocumentId === documentId &&
            restoreVersion === documentVersion
          ) {
            pendingHashRestore = false;
            usefulWebRestoreHash?.();
          }
        }, 50);
      }
    };
  })();

  function getOffset(elem: HTMLElement): number {
    return elem.getBoundingClientRect().top + window.scrollY;
  }

  function onDocument(data: { documentId: number; documentKey: string; version: number }) {
    if (
      !Number.isInteger(data.documentId) ||
      data.documentId < 1 ||
      typeof data.documentKey !== 'string' ||
      !Number.isInteger(data.version) ||
      data.version < 0
    ) {
      return;
    }

    const previousDocumentKey = documentKey;
    documentId = data.documentId;
    documentKey = data.documentKey;
    documentVersion = data.version;
    documentChanged = true;
    if (location.hash && previousDocumentKey !== undefined && previousDocumentKey !== documentKey) {
      const url = new URL(location.href);
      url.hash = '';
      history.replaceState(null, '', url);
      pendingHashRestore = false;
    } else {
      pendingHashRestore = location.hash !== '';
    }
    source = undefined;
    blocks = [];
    markdownBody.inert = true;
    markdownBody.setAttribute('aria-busy', 'true');
    resetScrollSync();
  }

  function resetScrollSync() {
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

  function getBlockIndexOnLine(line: number) {
    let low = 0;
    let high = blocks.length - 1;
    let result = 0;

    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (line >= Number(blocks[middle].dataset.lineBegin)) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return result;
  }

  function getBlockIndexAtOffset(offset: number) {
    let low = 0;
    let high = blocks.length - 1;
    let result = 0;

    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (offset >= getOffset(blocks[middle])) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return result;
  }

  function getLineAtOffset(offset: number): number | undefined {
    if (!blocks[0] || !source) return;

    const blockIndex = getBlockIndexAtOffset(offset);
    const target = blocks[blockIndex];
    const next = blocks[blockIndex + 1];
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

  const onScroll = (data: { line: number | string; documentId: number; version: number }) => {
    const line = Number(data.line);
    if (!Number.isInteger(line) || line < 1) return;
    if (data.documentId !== documentId || data.version !== documentVersion) return;
    if (pendingHashRestore) return;

    scroll = { line, documentId: data.documentId, version: data.version };

    const sentAt = pendingBrowserLines.get(line);
    if (sentAt !== undefined && performance.now() - sentAt < 1000) {
      pendingBrowserLines.delete(line);
      return;
    }

    clearTimeout(browserScrollTimer);
    browserScrollTimer = undefined;
    pendingBrowserLines.clear();
    lastBrowserLine = undefined;

    if (!blocks[0] || !source) return;

    const blockIndex = getBlockIndexOnLine(line);
    const target = blocks[blockIndex];
    const next = blocks[blockIndex + 1];

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
      documentVersion === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const now = performance.now();
    for (const [pendingLine, sentAt] of pendingBrowserLines) {
      if (now - sentAt >= 1000) pendingBrowserLines.delete(pendingLine);
    }

    lastBrowserLine = line;
    scroll = { line, documentId, version: documentVersion };
    pendingBrowserLines.set(line, now);
    socket.send(JSON.stringify({ action: 'scroll', line, documentId, version: documentVersion }));
  }

  window.addEventListener('scroll', () => {
    if (suppressBrowserScroll) return;
    if (!peek.syncScroll) {
      scroll = undefined;
      return;
    }
    if (browserScrollTimer !== undefined) return;

    browserScrollTimer = setTimeout(() => {
      browserScrollTimer = undefined;
      if (!suppressBrowserScroll) reportBrowserScroll();
    }, 100);
  }, { passive: true });
});
