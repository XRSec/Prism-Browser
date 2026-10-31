// @ts-nocheck
import type { Readable, Writable } from 'node:stream'
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface CdpTransport {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  on?(event: string, listener: (params: any, sessionId?: string) => void): () => void
  close(): void
}

const DEFAULT_PAGE_NODES = 200;
const MAX_PAGE_NODES = 300;
const MAX_SNAPSHOT_NODES = 3e3;
const MAX_PAGE_TEXT = 2e5;
const MAX_SNAPSHOT_HISTORY = 4;
const SNAPSHOT_INSPECTION_CONCURRENCY = 8;
const SNAPSHOT_SIGNATURE_EXCLUDED_FIELDS = /* @__PURE__ */ new Set(["ref", "rect", "quad", "coordinateSpace"]);
const MAX_INPUT_TEXT = 4e3;
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_NETWORK_RECORDS = 500;
const MAX_NETWORK_BODY_BYTES = 1 * 1024 * 1024;
const MAX_HAR_RECORDS = 500;
const ACTIONABLE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);
const EDITABLE_ROLES = /* @__PURE__ */ new Set(["combobox", "searchbox", "spinbutton", "textbox"]);
export class PipeCdpTransport {
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;
    readable.on("data", (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.once("close", () => this.rejectAll(new Error("浏览器控制管道已关闭")));
    readable.once("error", (error) => this.rejectAll(error));
    writable.once("error", (error) => this.rejectAll(error));
  }
  readable;
  writable;
  sequence = 0;
  buffer = Buffer.alloc(0);
  closed = false;
  pending = /* @__PURE__ */ new Map();
  eventListeners = /* @__PURE__ */ new Set();
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("浏览器控制管道不可用"));
    const id = ++this.sequence;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器操作超时：${method}`));
      }, 2e4);
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve2(value),
        reject
      });
      this.writable.write(`${JSON.stringify(payload)}\0`);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.writable.end();
    this.readable.destroy();
    this.rejectAll(new Error("浏览器控制管道已关闭"));
  }
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (; ; ) {
      const delimiter = this.buffer.indexOf(0);
      if (delimiter < 0) return;
      const text2 = this.buffer.subarray(0, delimiter).toString("utf8");
      this.buffer = this.buffer.subarray(delimiter + 1);
      if (!text2) continue;
      let message;
      try {
        message = JSON.parse(text2);
      } catch {
        this.rejectAll(new Error("浏览器控制协议返回了无效消息"));
        continue;
      }
      if (!message.id) {
        if (message.method) {
          const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
          for (const listener of this.eventListeners) listener(event);
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "浏览器操作失败"));
      else pending.resolve(message.result);
    }
  }
  rejectAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.eventListeners.clear();
  }
}
export class WebSocketCdpTransport {
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.rejectAll(new Error("浏览器控制连接已关闭")));
    socket.addEventListener("error", () => this.rejectAll(new Error("浏览器控制连接发生错误")));
  }
  socket;
  sequence = 0;
  closed = false;
  pending = /* @__PURE__ */ new Map();
  eventListeners = /* @__PURE__ */ new Set();
  static connect(url, timeoutMs = 15e3) {
    if (typeof WebSocket !== "function") return Promise.reject(new Error("当前运行环境不支持浏览器 WebSocket 控制"));
    return new Promise((resolve2, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("连接浏览器控制通道超时"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve2(new WebSocketCdpTransport(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("无法连接浏览器控制通道"));
      }, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("浏览器控制连接不可用"));
    const id = ++this.sequence;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器操作超时：${method}`));
      }, 2e4);
      this.pending.set(id, { timer, resolve: (value) => resolve2(value), reject });
      this.socket.send(JSON.stringify(payload));
    });
  }
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.rejectAll(new Error("浏览器控制连接已关闭"));
  }
  onMessage(data) {
    let message;
    try {
      const text2 = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : String(data);
      message = JSON.parse(text2);
    } catch {
      this.rejectAll(new Error("浏览器控制协议返回了无效消息"));
      return;
    }
    if (!message.id) {
      if (message.method) {
        const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
        for (const listener of this.eventListeners) listener(event);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "浏览器操作失败"));
    else pending.resolve(message.result);
  }
  rejectAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.eventListeners.clear();
  }
}
export const WINDOW_SYNC_BINDING = "__prismWindowSyncEvent";
export const WINDOW_SYNC_WORLD = "__prismWindowSyncWorldV1";
const WINDOW_SYNC_SCRIPT = `(() => {
  if (globalThis.__prismWindowSyncInstalled) return;
  Object.defineProperty(globalThis, '__prismWindowSyncInstalled', { value: true });
  const send = (payload) => { try { globalThis.${WINDOW_SYNC_BINDING}(JSON.stringify(payload)); } catch {} };
  const ratio = (value, total) => Math.max(0, Math.min(1, total > 0 ? value / total : 0));
  const selector = (node) => {
    if (!(node instanceof Element)) return '';
    if (node.id && CSS.escape) return '#' + CSS.escape(node.id);
    const stable = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'autocomplete', 'placeholder'];
    for (const attr of stable) {
      const value = node.getAttribute(attr);
      if (value && value.length < 160 && CSS.escape) return node.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(value) + '"]';
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(' > ');
  };
  addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    send({ kind: 'click', xRatio: ratio(event.clientX, innerWidth), yRatio: ratio(event.clientY, innerHeight), selector: selector(event.target), button: ['left','middle','right'][event.button] || 'left', clickCount: Math.max(1, Math.min(3, event.detail || 1)) });
  }, true);
  addEventListener('input', (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable)) return;
    const path = selector(target);
    if (!path) return;
    const value = target instanceof HTMLElement && target.isContentEditable ? target.innerText : target.value;
    send({ kind: 'input', selector: path, value: String(value).slice(0, 16000), selectionStart: Number.isInteger(target.selectionStart) ? target.selectionStart : undefined, selectionEnd: Number.isInteger(target.selectionEnd) ? target.selectionEnd : undefined, inputType: event.inputType || '' });
  }, true);
  addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.isComposing) return;
    const special = event.metaKey || event.ctrlKey || event.altKey || event.key.length > 1;
    if (!special || ['Shift','Control','Alt','Meta','CapsLock'].includes(event.key)) return;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    send({ kind: 'key', key: event.key, code: event.code, modifiers });
  }, true);
  let scrollFrame = 0;
  addEventListener('scroll', (event) => {
    const root = document.scrollingElement || document.documentElement;
    const rawTarget = event.target;
    const target = rawTarget instanceof Element && rawTarget !== document.body && rawTarget !== document.documentElement
      && rawTarget !== root ? rawTarget : null;
    if (!target) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => send({
      kind: 'scroll', selector: selector(target),
      xRatio: ratio(target.scrollLeft, target.scrollWidth - target.clientWidth),
      yRatio: ratio(target.scrollTop, target.scrollHeight - target.clientHeight)
    }));
  }, true);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send({ kind: 'activateTab' });
  }, true);
})();`;
const FOCUSED_EDITABLE_SNAPSHOT_SCRIPT = `(() => {
  let element = document.activeElement;
  while (element instanceof HTMLElement && element.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement || element instanceof HTMLElement && element.isContentEditable;
  if (!editable || element instanceof HTMLInputElement && ['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(element.type)) return null;
  const selector = (node) => {
    if (!(node instanceof Element)) return '';
    if (node.id && CSS.escape) return '#' + CSS.escape(node.id);
    const stable = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'autocomplete', 'placeholder'];
    for (const attr of stable) {
      const value = node.getAttribute(attr);
      if (value && value.length < 160 && CSS.escape) return node.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(value) + '"]';
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(' > ');
  };
  const path = selector(element);
  if (!path) return null;
  const value = element instanceof HTMLElement && element.isContentEditable ? element.innerText : element.value;
  return {
    selector: path,
    value: String(value).slice(0, 16000),
    selectionStart: Number.isInteger(element.selectionStart) ? element.selectionStart : undefined,
    selectionEnd: Number.isInteger(element.selectionEnd) ? element.selectionEnd : undefined,
    inputType: 'poll'
  };
})()`;
const PAGE_READER_FUNCTION = `function (mode, options) {
  const roots = [];
  const seen = new Set();
  let frameCount = 0;
  let crossOriginFrames = 0;
  let shadowRootCount = 0;
  const visit = (root, frameDepth, shadowDepth) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push({ root, frameDepth, shadowDepth });
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll('*')); } catch {}
    for (const element of nodes) {
      if (element.shadowRoot) { shadowRootCount += 1; visit(element.shadowRoot, frameDepth, shadowDepth + 1); }
      if (['iframe','frame'].includes(String(element.tagName || '').toLowerCase())) {
        frameCount += 1;
        try {
          if (element.contentDocument) visit(element.contentDocument, frameDepth + 1, shadowDepth);
          else crossOriginFrames += 1;
        } catch { crossOriginFrames += 1; }
      }
    }
  };
  visit(document, 0, 0);
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const cap = (value, maximum) => {
    const text = String(value || '');
    return { value: text.slice(0, maximum), length: text.length, truncated: text.length > maximum };
  };
  const all = (selector) => roots.flatMap(({ root, frameDepth, shadowDepth }) => {
    try { return Array.from(root.querySelectorAll(selector)).map((element) => ({ element, frameDepth, shadowDepth })); }
    catch { return []; }
  });
  const tableData = (table) => {
    const rows = Array.from(table.rows || []).slice(0, options.maxRows || 100).map((row) =>
      Array.from(row.cells || []).slice(0, options.maxColumns || 30).map((cell) => clean(cell.innerText || cell.textContent))
    );
    const first = rows[0] || [];
    const headerCells = table.tHead ? Array.from(table.tHead.rows[0]?.cells || []).map((cell) => clean(cell.innerText || cell.textContent)) : [];
    return {
      caption: clean(table.caption?.innerText || ''),
      headers: headerCells.length ? headerCells : first,
      rows: headerCells.length ? rows.slice(1) : rows,
      rowCount: Number(table.rows?.length || 0),
      columnCount: Math.max(0, ...rows.map((row) => row.length)),
      truncated: Number(table.rows?.length || 0) > (options.maxRows || 100)
    };
  };
  if (mode === 'text') {
    const chunks = [];
    const used = new Set();
    for (const { root } of roots) {
      const source = root.nodeType === Node.DOCUMENT_NODE ? root.body : root;
      const value = clean(source?.innerText || source?.textContent || '');
      if (value && !used.has(value)) { used.add(value); chunks.push(value); }
    }
    const result = cap(chunks.join('\\n\\n'), options.maxChars || 50000);
    return { text: result.value, length: result.length, truncated: result.truncated };
  }
  if (mode === 'table') {
    const tables = all('table');
    const selected = tables[options.index || 0];
    if (!selected) throw new Error('找不到指定的表格');
    return { index: options.index || 0, frameDepth: selected.frameDepth, shadowDepth: selected.shadowDepth, ...tableData(selected.element) };
  }
  if (mode === 'list') {
    const lists = all('ul,ol,[role="list"]');
    const selected = lists[options.index || 0];
    if (!selected) throw new Error('找不到指定的列表');
    const items = Array.from(selected.element.querySelectorAll(':scope > li, :scope > [role="listitem"]'));
    const maximum = options.maxItems || 200;
    return {
      index: options.index || 0, ordered: selected.element.tagName?.toLowerCase() === 'ol',
      frameDepth: selected.frameDepth, shadowDepth: selected.shadowDepth,
      items: items.slice(0, maximum).map((item) => clean(item.innerText || item.textContent)),
      itemCount: items.length, truncated: items.length > maximum
    };
  }
  if (mode === 'schema') {
    const count = (selector) => all(selector).length;
    return {
      title: document.title, url: location.href,
      headings: all('h1,h2,h3,h4,h5,h6').slice(0, 100).map(({ element, frameDepth, shadowDepth }) => ({
        level: Number(element.tagName.slice(1)), text: clean(element.innerText || element.textContent), frameDepth, shadowDepth
      })),
      counts: {
        links: count('a[href]'), buttons: count('button,[role="button"]'), inputs: count('input,textarea,select,[contenteditable="true"]'),
        forms: count('form'), tables: count('table'), lists: count('ul,ol,[role="list"]'), images: count('img'),
        frames: frameCount, crossOriginFrames, shadowRoots: shadowRootCount
      }
    };
  }
  if (mode === 'markdown') {
    const render = (node, depth) => {
      if (!node || depth > 80) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return Array.from(node.childNodes || []).map((child) => render(child, depth + 1)).join('');
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(node.tagName)) return '';
      if (['iframe','frame'].includes(String(node.tagName || '').toLowerCase())) {
        try { return node.contentDocument?.body ? '\\n' + render(node.contentDocument.body, depth + 1) + '\\n' : ''; } catch { return ''; }
      }
      const children = node.shadowRoot
        ? Array.from(node.shadowRoot.childNodes).map((child) => render(child, depth + 1)).join('')
        : Array.from(node.childNodes).map((child) => render(child, depth + 1)).join('');
      const text = clean(children);
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return '\\n' + '#'.repeat(Number(tag[1])) + ' ' + text + '\\n';
      if (tag === 'a') return '[' + text + '](' + String(node.href || '') + ')';
      if (tag === 'img') return '![' + clean(node.alt) + '](' + String(node.src || '') + ')';
      if (tag === 'li') return '\\n- ' + text;
      if (tag === 'br') return '\\n';
      if (tag === 'p' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'div') return text ? '\\n' + text + '\\n' : '';
      if (tag === 'th' || tag === 'td') return '| ' + text + ' ';
      if (tag === 'tr') return '\\n' + children + '|';
      return children;
    };
    const raw = render(document.body, 0).replace(/\\n{3,}/g, '\\n\\n').trim();
    const result = cap(raw, options.maxChars || 60000);
    return { markdown: result.value, length: result.length, truncated: result.truncated };
  }
  throw new Error('不支持的页面读取模式');
}`;
const ELEMENT_READER_FUNCTION = `function (mode, options) {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  if (mode === 'attribute') return { name: options.name, value: this.getAttribute ? this.getAttribute(options.name) : null };
  if (mode === 'text') {
    const raw = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement
      ? this.value : this.innerText || this.textContent || '';
    const text = String(raw);
    const maximum = options.maxChars || 50000;
    return { text: text.slice(0, maximum), length: text.length, truncated: text.length > maximum };
  }
  if (mode === 'table') {
    const table = this.matches?.('table') ? this : this.closest?.('table') || this.querySelector?.('table');
    if (!table) throw new Error('目标元素不是表格，也不包含表格');
    const rows = Array.from(table.rows || []).slice(0, options.maxRows || 100).map((row) =>
      Array.from(row.cells || []).slice(0, options.maxColumns || 30).map((cell) => clean(cell.innerText || cell.textContent))
    );
    const headerCells = table.tHead ? Array.from(table.tHead.rows[0]?.cells || []).map((cell) => clean(cell.innerText || cell.textContent)) : [];
    return { caption: clean(table.caption?.innerText || ''), headers: headerCells.length ? headerCells : rows[0] || [], rows: headerCells.length ? rows.slice(1) : rows, rowCount: Number(table.rows?.length || 0), columnCount: Math.max(0, ...rows.map((row) => row.length)), truncated: Number(table.rows?.length || 0) > (options.maxRows || 100) };
  }
  if (mode === 'list') {
    const list = this.matches?.('ul,ol,[role="list"]') ? this : this.closest?.('ul,ol,[role="list"]') || this.querySelector?.('ul,ol,[role="list"]');
    if (!list) throw new Error('目标元素不是列表，也不包含列表');
    const items = Array.from(list.querySelectorAll(':scope > li, :scope > [role="listitem"]'));
    const maximum = options.maxItems || 200;
    return { ordered: list.tagName?.toLowerCase() === 'ol', items: items.slice(0, maximum).map((item) => clean(item.innerText || item.textContent)), itemCount: items.length, truncated: items.length > maximum };
  }
  throw new Error('不支持的元素读取模式');
}`;
export class BrowserControlError extends Error {
  constructor(code, message, retryable = false, suggestedTool) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.suggestedTool = suggestedTool;
    this.name = "BrowserControlError";
  }
  code;
  retryable;
  suggestedTool;
}
function boundedText(value, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}
function redactNetworkUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|auth|key|secret|password|passwd|pwd|code|signature|session|jwt)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString().slice(0, 4096);
  } catch {
    return String(value).slice(0, 4096);
  }
}
function redactNetworkHeaders(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const [name, raw] of Object.entries(value).slice(0, 200)) {
    const key = name.slice(0, 200);
    result[key] = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i.test(key) ? "[REDACTED]" : String(raw).slice(0, 2e3);
  }
  return result;
}
function validateWebUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new Error("网址长度无效");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP 只允许打开 HTTP 或 HTTPS 网页");
  if (url.username || url.password) throw new Error("网址中不能包含账号或密码");
  return url.toString();
}
function targetKind(target) {
  if (target.type !== "page" || target.url.startsWith("devtools:")) return void 0;
  if (target.url === "about:blank" || /^https?:\/\//.test(target.url)) return "web";
  if (/^chrome-extension:\/\/[a-p]{32}\//.test(target.url)) return "extension";
  return void 0;
}
function validateTargetId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("页面目标 ID 无效");
  return value;
}
function boundedFilter(value, label) {
  if (value === void 0 || value === "") return void 0;
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}无效`);
  return value;
}
function delay(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
const INPUT_RELEASE_WAIT_MS = 2e3;
const INPUT_RELEASE_ACK_WAIT_MS = 1e3;
const MAX_FRAME_NESTING = 16;
function validQuad(value) {
  return Array.isArray(value) && value.length === 8 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}
function quadPoints(quad) {
  return [{ x: quad[0], y: quad[1] }, { x: quad[2], y: quad[3] }, { x: quad[4], y: quad[5] }, { x: quad[6], y: quad[7] }];
}
function mapFromChildFrame(point, boundary) {
  const q = boundary.content;
  const u = point.x / boundary.width;
  const v = point.y / boundary.height;
  return { x: q[0] + u * (q[2] - q[0]) + v * (q[6] - q[0]), y: q[1] + u * (q[3] - q[1]) + v * (q[7] - q[1]) };
}
function mapIntoChildFrame(point, boundary) {
  const q = boundary.content;
  const ax = q[2] - q[0], ay = q[3] - q[1], bx = q[6] - q[0], by = q[7] - q[1];
  const determinant = ax * by - ay * bx;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return void 0;
  const dx = point.x - q[0], dy = point.y - q[1];
  return { x: (dx * by - dy * bx) / determinant * boundary.width, y: (ax * dy - ay * dx) / determinant * boundary.height };
}
function mapToTopViewport(points, boundaries) {
  return boundaries.reduce((current, boundary) => current.map((point) => mapFromChildFrame(point, boundary)), points);
}
function polygonArea(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index], next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}
function clipPolygon(subject, clip) {
  const winding = Math.sign(polygonArea(clip));
  if (!winding) return [];
  let output = subject;
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const a = clip[index], b = clip[(index + 1) % clip.length];
    const side = (point) => winding * ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
    const input = output;
    output = [];
    for (let current = 0; current < input.length; current += 1) {
      const point = input[current], previous = input[(current + input.length - 1) % input.length];
      const pointSide = side(point), previousSide = side(previous);
      const crossing = () => {
        const t2 = previousSide / (previousSide - pointSide);
        return { x: previous.x + (point.x - previous.x) * t2, y: previous.y + (point.y - previous.y) * t2 };
      };
      if (pointSide >= 0) {
        if (previousSide < 0) output.push(crossing());
        output.push(point);
      } else if (previousSide >= 0) output.push(crossing());
    }
  }
  return output;
}
function insidePolygon(point, polygon) {
  const winding = Math.sign(polygonArea(polygon));
  if (!winding || polygon.length < 3) return false;
  return polygon.every((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return winding * ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) > 0;
  });
}
function polygonCentroid(polygon) {
  const area = polygonArea(polygon);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return void 0;
  let x = 0, y = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index], next = polygon[(index + 1) % polygon.length];
    const cross = current.x * next.y - next.x * current.y;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}
function pixelPointInside(point, polygon) {
  const { floor, ceil, round } = Math;
  return [
    { x: round(point.x), y: round(point.y) },
    { x: floor(point.x), y: floor(point.y) },
    { x: ceil(point.x), y: ceil(point.y) },
    { x: floor(point.x), y: ceil(point.y) },
    { x: ceil(point.x), y: floor(point.y) }
  ].find((candidate) => insidePolygon(candidate, polygon));
}
function roundedRect(rect) {
  const round = (value) => Math.round(value * 10) / 10;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}
function inputInterrupted() {
  return new BrowserControlError("INPUT_INTERRUPTED", "Input interrupted by navigation or task cancellation; read the page before retrying", false, "prism_read_page");
}
function elementNotVisible() {
  return new BrowserControlError("ELEMENT_NOT_VISIBLE", "The element is outside the visible area of its page or frame; nothing was pressed. Scroll it into view and read the page again.", false, "prism_read_page");
}
function elementObscured() {
  return new BrowserControlError("ELEMENT_OBSCURED", "Another element or frame is on top of the target at the press point; nothing was pressed. Take a screenshot or read the page again before retrying.", false, "prism_take_screenshot");
}
function mimeTypeForPath(path) {
  const types = {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip"
  };
  return types[extname(path).toLocaleLowerCase()] ?? "application/octet-stream";
}
function pathKey(path) {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}
function withinPath(path, root) {
  const candidate = pathKey(path);
  const prefix = pathKey(root);
  return candidate === prefix || candidate.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`);
}
function sensitiveUploadRoots() {
  const home = homedir();
  const roots = process.platform === "win32" ? [
    process.env.SystemRoot,
    process.env.ProgramData,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    joinHome(".ssh"),
    joinHome(".gnupg"),
    joinHome(".aws")
  ] : [
    "/System",
    "/private/etc",
    "/etc",
    "/private/var/db",
    "/var/db",
    "/Library/Keychains",
    joinHome(".ssh"),
    joinHome(".gnupg"),
    joinHome(".aws"),
    joinHome(".config/gcloud"),
    joinHome("Library/Keychains"),
    joinHome("Library/Application Support/Prism Browser")
  ];
  return roots.filter((value) => Boolean(value)).map((value) => resolve(value));
  function joinHome(value) {
    return resolve(home, value);
  }
}
async function validateUploadFiles(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_UPLOAD_FILES) {
    throw new Error(`每次必须上传 1–${MAX_UPLOAD_FILES} 个文件`);
  }
  const blockedRoots = sensitiveUploadRoots();
  const paths = [];
  const files = [];
  let total = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.length || value.length > 4096 || !isAbsolute(value) || /\u0000/.test(value)) {
      throw new Error("上传文件必须使用有效的绝对路径");
    }
    const requested = resolve(value);
    const info = await lstat(requested).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`上传目标不是普通文件：${basename(requested) || "unknown"}`);
    const canonical2 = await realpath(requested);
    if (pathKey(canonical2) !== pathKey(requested)) throw new Error(`上传路径不能包含符号链接：${basename(requested)}`);
    if (blockedRoots.some((root) => withinPath(canonical2, root))) throw new Error(`出于本机数据安全限制，不能上传该位置的文件：${basename(canonical2)}`);
    if (info.size > MAX_UPLOAD_FILE_BYTES) throw new Error(`单个上传文件不能超过 100 MB：${basename(canonical2)}`);
    total += info.size;
    if (total > MAX_UPLOAD_TOTAL_BYTES) throw new Error("单次上传文件总大小不能超过 250 MB");
    const key = pathKey(canonical2);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(canonical2);
    files.push({ name: basename(canonical2), mimeType: mimeTypeForPath(canonical2), size: info.size });
  }
  return { paths, files };
}
export class BrowserControlSession {
  constructor(cdp, ownsTransport = true) {
    this.cdp = cdp;
    this.ownsTransport = ownsTransport;
    this.removeEventListener = cdp.onEvent((event) => {
      if (event.method === "Target.attachedToTarget") {
        const parentSessionId = event.sessionId;
        const attachedSessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : "";
        const targetInfo = event.params.targetInfo;
        if (attachedSessionId && targetInfo?.type === "iframe" && parentSessionId && (parentSessionId === this.sessionId || this.childFrameSessions.has(parentSessionId))) {
          this.childFrameSessions.add(attachedSessionId);
          this.frameAttachments.set(attachedSessionId, { parentSessionId, frameId: targetInfo.targetId });
          const ready = this.enableChildFrameSession(attachedSessionId);
          this.childFrameSessionReady.set(attachedSessionId, ready);
          void ready.finally(() => this.childFrameSessionReady.delete(attachedSessionId));
        }
        return;
      }
      if (event.method === "Target.detachedFromTarget") {
        const detachedSessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : "";
        if (detachedSessionId) {
          this.childFrameSessions.delete(detachedSessionId);
          this.frameAttachments.delete(detachedSessionId);
          this.cancelInputForSession(detachedSessionId);
          this.childFrameSessionReady.delete(detachedSessionId);
        }
        return;
      }
      if (!this.sessionId || !event.sessionId || event.sessionId !== this.sessionId && !this.childFrameSessions.has(event.sessionId)) return;
      if (event.method === "Runtime.executionContextsCleared" || event.method === "Page.frameNavigated" && !event.params.frame?.parentId) {
        this.documentGeneration += 1;
        this.references.clear();
        this.cancelInputForSession(event.sessionId);
      }
      if (event.method === "Page.javascriptDialogOpening") {
        this.pendingDialog = {
          type: boundedText(event.params.type, 40),
          message: boundedText(event.params.message, 4e3),
          defaultPrompt: boundedText(event.params.defaultPrompt, 4e3)
        };
      }
      if (event.method === "Page.javascriptDialogClosed") this.pendingDialog = void 0;
      if (event.method === "Page.downloadWillBegin") {
        const guid = String(event.params.guid ?? "");
        if (guid) this.downloads.set(guid, {
          guid,
          url: redactNetworkUrl(String(event.params.url ?? "")),
          suggestedFilename: boundedText(event.params.suggestedFilename, 500),
          state: "inProgress",
          receivedBytes: 0,
          totalBytes: 0
        });
      }
      if (event.method === "Page.downloadProgress") {
        const guid = String(event.params.guid ?? "");
        const item = this.downloads.get(guid);
        if (item) {
          item.state = ["completed", "canceled"].includes(String(event.params.state)) ? String(event.params.state) : "inProgress";
          item.receivedBytes = Number(event.params.receivedBytes ?? 0);
          item.totalBytes = Number(event.params.totalBytes ?? 0);
        }
      }
      this.captureNetworkEvent(event);
    });
  }
  cdp;
  ownsTransport;
  targetId;
  sessionId;
  childFrameSessions = /* @__PURE__ */ new Set();
  frameAttachments = /* @__PURE__ */ new Map();
  activeInput;
  inputDisabled = false;
  childFrameSessionReady = /* @__PURE__ */ new Map();
  snapshotVersion = 0;
  documentGeneration = 0;
  references = /* @__PURE__ */ new Map();
  snapshots = /* @__PURE__ */ new Map();
  snapshotCursors = /* @__PURE__ */ new Map();
  networkRecords = /* @__PURE__ */ new Map();
  networkRequestIds = /* @__PURE__ */ new Map();
  inflightNetwork = /* @__PURE__ */ new Set();
  downloads = /* @__PURE__ */ new Map();
  lastNetworkActivityAt = Date.now();
  harStartedAt;
  harRecordIds = [];
  pendingDialog;
  syncTabTargets = /* @__PURE__ */ new Map();
  activeSyncTabIndex;
  removeEventListener;
  closed = false;
  fork() {
    if (this.closed) throw new BrowserControlError("CONTROL_SESSION_CLOSED", "浏览器控制会话已关闭", true);
    return new BrowserControlSession(this.cdp, false);
  }
  async startWindowSyncCapture(onAction) {
    this.syncTabTargets.clear();
    this.activeSyncTabIndex = void 0;
    let disposed = false;
    let captureReady = false;
    const targetOrder = [];
    const targetSessions = /* @__PURE__ */ new Map();
    const sessionTargets = /* @__PURE__ */ new Map();
    const installedContexts = /* @__PURE__ */ new Map();
    const installingTargets = /* @__PURE__ */ new Map();
    const lastNavigations = /* @__PURE__ */ new Map();
    const targetUrls = /* @__PURE__ */ new Map();
    const lastRootScrolls = /* @__PURE__ */ new Map();
    const lastFocusedInputs = /* @__PURE__ */ new Map();
    let scrollPolling = false;
    let inputPolling = false;
    let scrollPollTimer;
    let inputPollTimer;
    const tabIndexOf = (targetId) => targetOrder.indexOf(targetId);
    const emitNavigation = (targetId, url) => {
      const tabIndex = tabIndexOf(targetId);
      if (!captureReady || tabIndex < 0 || !/^https?:\/\//.test(url)) return;
      const now = Date.now();
      const previous = lastNavigations.get(targetId);
      if (previous?.url === url && now - previous.emittedAt < 300) return;
      lastNavigations.set(targetId, { url, emittedAt: now });
      targetUrls.set(targetId, url);
      onAction({ kind: "navigate", url, tabIndex, tabUrl: url });
    };
    const installContext = async (sessionId, contextId) => {
      const contexts = installedContexts.get(sessionId) ?? /* @__PURE__ */ new Set();
      installedContexts.set(sessionId, contexts);
      if (contexts.has(contextId) || disposed) return;
      await this.cdp.send("Runtime.addBinding", { name: WINDOW_SYNC_BINDING, executionContextId: contextId }, sessionId);
      await this.cdp.send("Runtime.evaluate", { expression: WINDOW_SYNC_SCRIPT, contextId }, sessionId);
      contexts.add(contextId);
    };
    const installTarget = (targetId) => {
      const existing = installingTargets.get(targetId);
      if (existing) return existing;
      let attachedSessionId;
      const operation = (async () => {
        if (disposed || targetSessions.has(targetId)) return;
        const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
        if (disposed) return;
        const sessionId = attached.sessionId;
        attachedSessionId = sessionId;
        targetSessions.set(targetId, sessionId);
        sessionTargets.set(sessionId, targetId);
        if (!targetOrder.includes(targetId)) targetOrder.push(targetId);
        await Promise.all([
          this.cdp.send("Page.enable", {}, sessionId),
          this.cdp.send("Runtime.enable", {}, sessionId)
        ]);
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "void 0", worldName: WINDOW_SYNC_WORLD }, sessionId);
        const frameTree = await this.cdp.send("Page.getFrameTree", {}, sessionId);
        const isolated = await this.cdp.send("Page.createIsolatedWorld", {
          frameId: frameTree.frameTree.frame.id,
          worldName: WINDOW_SYNC_WORLD,
          grantUniveralAccess: false
        }, sessionId);
        await installContext(sessionId, isolated.executionContextId);
        const bridge = await this.cdp.send("Runtime.evaluate", {
          expression: `({installed: globalThis.__prismWindowSyncInstalled === true, binding: typeof globalThis.${WINDOW_SYNC_BINDING}})`,
          contextId: isolated.executionContextId,
          returnByValue: true
        }, sessionId);
        if (!bridge.result?.value?.installed || bridge.result.value.binding !== "function") {
          throw new Error("浏览器未能建立安全的窗口同步通道");
        }
      })().catch(async (error) => {
        const sessionId = attachedSessionId ?? targetSessions.get(targetId);
        targetSessions.delete(targetId);
        if (sessionId) {
          sessionTargets.delete(sessionId);
          installedContexts.delete(sessionId);
          await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => void 0);
        }
        throw error;
      }).finally(() => installingTargets.delete(targetId));
      installingTargets.set(targetId, operation);
      return operation;
    };
    const removeEvents = this.cdp.onEvent((event) => {
      if (event.method === "Target.targetCreated") {
        const info = event.params.targetInfo;
        if (info?.type === "page" && info.targetId && !info.url.startsWith("devtools:")) {
          if (!targetOrder.includes(info.targetId)) targetOrder.push(info.targetId);
          targetUrls.set(info.targetId, info.url);
          const tabIndex = tabIndexOf(info.targetId);
          if (captureReady) onAction({
            kind: "openTab",
            url: /^https?:\/\//.test(info.url) ? info.url : "about:blank",
            tabIndex,
            tabUrl: info.url
          });
          void installTarget(info.targetId).catch(() => void 0);
        }
        return;
      }
      if (event.method === "Target.targetInfoChanged") {
        const info = event.params.targetInfo;
        if (info?.type === "page" && info.targetId) emitNavigation(info.targetId, info.url);
        return;
      }
      if (event.method === "Target.targetDestroyed") {
        const targetId = typeof event.params.targetId === "string" ? event.params.targetId : "";
        const tabIndex = targetOrder.indexOf(targetId);
        const sessionId = targetSessions.get(targetId);
        if (sessionId) {
          sessionTargets.delete(sessionId);
          installedContexts.delete(sessionId);
        }
        targetSessions.delete(targetId);
        lastNavigations.delete(targetId);
        lastRootScrolls.delete(targetId);
        lastFocusedInputs.delete(targetId);
        const tabUrl = targetUrls.get(targetId);
        targetUrls.delete(targetId);
        if (tabIndex >= 0) {
          targetOrder.splice(tabIndex, 1);
          if (captureReady) onAction({ kind: "closeTab", tabIndex, tabUrl });
        }
        return;
      }
      if (event.method === "Page.frameNavigated" && event.sessionId && sessionTargets.has(event.sessionId)) {
        const frame = event.params.frame;
        const targetId = sessionTargets.get(event.sessionId);
        if (!frame?.parentId && typeof frame?.url === "string" && targetId) {
          lastFocusedInputs.delete(targetId);
          emitNavigation(targetId, frame.url);
        }
        return;
      }
      if (event.method === "Runtime.executionContextCreated" && event.sessionId && sessionTargets.has(event.sessionId)) {
        const context = event.params.context;
        if (context?.name === WINDOW_SYNC_WORLD && Number.isInteger(context.id)) {
          void installContext(event.sessionId, Number(context.id)).catch(() => void 0);
        }
        return;
      }
      if (event.method !== "Runtime.bindingCalled" || !event.sessionId || !sessionTargets.has(event.sessionId) || event.params.name !== WINDOW_SYNC_BINDING || typeof event.params.payload !== "string") return;
      try {
        const action = JSON.parse(event.params.payload);
        const targetId = sessionTargets.get(event.sessionId);
        if (validWindowSyncAction(action) && targetId) {
          if (action.kind === "input") lastFocusedInputs.set(targetId, {
            selector: action.selector,
            value: action.value,
            selectionStart: action.selectionStart,
            selectionEnd: action.selectionEnd
          });
          onAction({
            ...action,
            tabIndex: Math.max(0, targetOrder.indexOf(targetId)),
            tabUrl: targetUrls.get(targetId)
          });
        }
      } catch {
      }
    });
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const targets = await this.cdp.send("Target.getTargets");
    const pages = targets.targetInfos.filter((target) => target.type === "page" && !target.url.startsWith("devtools:"));
    for (const page of pages) {
      if (!targetOrder.includes(page.targetId)) targetOrder.push(page.targetId);
      targetUrls.set(page.targetId, page.url);
    }
    const installed = await Promise.allSettled(pages.map((target) => installTarget(target.targetId)));
    if (!installed.some((result) => result.status === "fulfilled") || !targetSessions.size) {
      disposed = true;
      removeEvents();
      throw new Error("主控窗口没有可同步的网页标签");
    }
    const pollRootScrolls = async () => {
      if (disposed || scrollPolling) return;
      scrollPolling = true;
      try {
        await Promise.all([...targetSessions.entries()].map(async ([targetId, sessionId]) => {
          const result = await this.cdp.send("Runtime.evaluate", {
            expression: `(() => { const root = document.scrollingElement || document.documentElement; const width = root.scrollWidth - root.clientWidth; const height = root.scrollHeight - root.clientHeight; return {xRatio: Math.max(0, Math.min(1, width > 0 ? root.scrollLeft / width : 0)), yRatio: Math.max(0, Math.min(1, height > 0 ? root.scrollTop / height : 0))}; })()`,
            returnByValue: true
          }, sessionId).catch(() => ({ result: { value: void 0 } }));
          const value = result.result?.value;
          if (!Number.isFinite(value?.xRatio) || !Number.isFinite(value?.yRatio)) return;
          const next = { xRatio: Number(value?.xRatio), yRatio: Number(value?.yRatio) };
          const previous = lastRootScrolls.get(targetId);
          lastRootScrolls.set(targetId, next);
          if (!previous || Math.abs(previous.xRatio - next.xRatio) < 1e-4 && Math.abs(previous.yRatio - next.yRatio) < 1e-4) return;
          const tabIndex = tabIndexOf(targetId);
          if (tabIndex >= 0) onAction({ kind: "scroll", ...next, tabIndex, tabUrl: targetUrls.get(targetId) });
        }));
      } finally {
        scrollPolling = false;
      }
    };
    const pollFocusedInputs = async () => {
      if (disposed || inputPolling) return;
      inputPolling = true;
      try {
        await Promise.all([...targetSessions.entries()].map(async ([targetId, sessionId]) => {
          const result = await this.cdp.send("Runtime.evaluate", {
            expression: FOCUSED_EDITABLE_SNAPSHOT_SCRIPT,
            returnByValue: true
          }, sessionId).catch(() => ({ result: { value: null } }));
          const value = result.result?.value;
          if (!value || typeof value.selector !== "string" || typeof value.value !== "string") {
            lastFocusedInputs.delete(targetId);
            return;
          }
          const next = {
            selector: value.selector,
            value: value.value,
            selectionStart: Number.isInteger(value.selectionStart) ? Number(value.selectionStart) : void 0,
            selectionEnd: Number.isInteger(value.selectionEnd) ? Number(value.selectionEnd) : void 0
          };
          const previous = lastFocusedInputs.get(targetId);
          lastFocusedInputs.set(targetId, next);
          if (!captureReady || previous && previous.selector === next.selector && previous.value === next.value && previous.selectionStart === next.selectionStart && previous.selectionEnd === next.selectionEnd) return;
          const tabIndex = tabIndexOf(targetId);
          if (tabIndex >= 0) onAction({
            kind: "input",
            ...next,
            inputType: value.inputType ?? "poll",
            tabIndex,
            tabUrl: targetUrls.get(targetId)
          });
        }));
      } finally {
        inputPolling = false;
      }
    };
    await pollRootScrolls();
    await pollFocusedInputs();
    captureReady = true;
    scrollPollTimer = setInterval(() => {
      void pollRootScrolls();
    }, 50);
    inputPollTimer = setInterval(() => {
      void pollFocusedInputs();
    }, 40);
    return () => {
      disposed = true;
      if (scrollPollTimer) clearInterval(scrollPollTimer);
      if (inputPollTimer) clearInterval(inputPollTimer);
      removeEvents();
      void this.cdp.send("Target.setDiscoverTargets", { discover: false }).catch(() => void 0);
      for (const sessionId of sessionTargets.keys()) {
        void this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => void 0);
      }
    };
  }
  async applyWindowSyncAction(action) {
    if (action.kind === "openTab") {
      const created = await this.cdp.send("Target.createTarget", { url: action.url === "about:blank" ? action.url : validateWebUrl(action.url) });
      if (Number.isInteger(action.tabIndex)) this.syncTabTargets.set(Number(action.tabIndex), created.targetId);
      await this.attach(created.targetId);
      this.activeSyncTabIndex = Number.isInteger(action.tabIndex) ? Number(action.tabIndex) : void 0;
      return;
    }
    await this.ensureActionPage(action.tabIndex, action.tabUrl);
    if (action.kind === "activateTab") {
      await this.cdp.send("Page.bringToFront", {}, this.sessionId);
      this.activeSyncTabIndex = Number.isInteger(action.tabIndex) ? Number(action.tabIndex) : void 0;
      return;
    }
    if (action.kind !== "closeTab" && Number.isInteger(action.tabIndex) && this.activeSyncTabIndex !== Number(action.tabIndex)) {
      await this.cdp.send("Page.bringToFront", {}, this.sessionId);
      this.activeSyncTabIndex = Number(action.tabIndex);
    }
    if (action.kind === "navigate") {
      await this.cdp.send("Page.navigate", { url: validateWebUrl(action.url) }, this.sessionId);
      return;
    }
    if (action.kind === "closeTab") {
      if (!this.targetId) throw new Error("受控窗口没有可关闭的网页标签");
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
      if (Number.isInteger(action.tabIndex)) {
        const closedIndex = Number(action.tabIndex);
        const shifted = /* @__PURE__ */ new Map();
        for (const [index, targetId] of this.syncTabTargets) {
          if (index < closedIndex) shifted.set(index, targetId);
          else if (index > closedIndex) shifted.set(index - 1, targetId);
        }
        this.syncTabTargets.clear();
        for (const [index, targetId] of shifted) this.syncTabTargets.set(index, targetId);
        if (this.activeSyncTabIndex === closedIndex) this.activeSyncTabIndex = void 0;
        else if (this.activeSyncTabIndex !== void 0 && this.activeSyncTabIndex > closedIndex) this.activeSyncTabIndex -= 1;
      }
      this.targetId = void 0;
      this.sessionId = void 0;
      return;
    }
    if (action.kind === "click") {
      const viewport = await this.viewportSize();
      let x = Math.max(0, Math.min(viewport.width - 1, action.xRatio * viewport.width));
      let y = Math.max(0, Math.min(viewport.height - 1, action.yRatio * viewport.height));
      if (action.selector) {
        const point = await this.cdp.send("Runtime.evaluate", {
          expression: `(() => { const element = document.querySelector(${JSON.stringify(action.selector)}); if (!element) return null; element.scrollIntoView({block: 'center', inline: 'center'}); const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 ? {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2} : null; })()`,
          returnByValue: true
        }, this.sessionId).catch(() => ({ result: { value: null } }));
        if (Number.isFinite(point.result?.value?.x) && Number.isFinite(point.result?.value?.y)) {
          x = Number(point.result?.value?.x);
          y = Number(point.result?.value?.y);
        }
      }
      const params = { x, y, button: action.button, clickCount: action.clickCount };
      await this.cdp.send("Input.dispatchMouseEvent", { ...params, type: "mousePressed" }, this.sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { ...params, type: "mouseReleased" }, this.sessionId);
      return;
    }
    if (action.kind === "key") {
      const params = { key: action.key, code: action.code, modifiers: action.modifiers };
      await this.cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyDown" }, this.sessionId);
      await this.cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, this.sessionId);
      return;
    }
    if (action.kind === "scroll") {
      const selector = action.selector ? JSON.stringify(action.selector) : "null";
      await this.cdp.send("Runtime.evaluate", {
        expression: `(() => { const root = document.scrollingElement || document.documentElement; const target = ${selector} ? document.querySelector(${selector}) : root; if (!target) return false; target.scrollTo(${JSON.stringify(action.xRatio)} * Math.max(0, target.scrollWidth - target.clientWidth), ${JSON.stringify(action.yRatio)} * Math.max(0, target.scrollHeight - target.clientHeight)); return true; })()`
      }, this.sessionId);
      return;
    }
    const payload = JSON.stringify(action);
    const prepared = await this.cdp.send("Runtime.evaluate", {
      expression: `((action) => {
        const element = document.querySelector(action.selector);
        if (!element) return 'missing';
        element.focus();
        if (element instanceof HTMLInputElement && element.type === 'file') return 'missing';
        if (element instanceof HTMLSelectElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(element, action.value); else element.value = action.value;
          element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return 'done';
        }
        if (element instanceof HTMLElement && element.isContentEditable) {
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return 'text';
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          try { element.select(); } catch {}
          return 'text';
        }
        return 'missing';
      })(${payload})`,
      returnByValue: true
    }, this.sessionId);
    if (prepared.result?.value === "missing" || !prepared.result?.value) throw new Error("受控窗口没有找到对应的输入框");
    if (prepared.result.value === "done") return;
    if (action.value) {
      await this.cdp.send("Input.insertText", { text: action.value }, this.sessionId);
    } else {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" }, this.sessionId);
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" }, this.sessionId);
    }
    if (Number.isInteger(action.selectionStart) && Number.isInteger(action.selectionEnd)) {
      await this.cdp.send("Runtime.evaluate", {
        expression: `(() => { const element = document.querySelector(${JSON.stringify(action.selector)}); if (element && 'setSelectionRange' in element) { try { element.setSelectionRange(${Number(action.selectionStart)}, ${Number(action.selectionEnd)}); } catch {} } })()`
      }, this.sessionId).catch(() => void 0);
    }
  }
  async windowBounds() {
    await this.ensurePage();
    const result = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
    return result.bounds;
  }
  async setWindowBounds(bounds) {
    await this.ensurePage();
    const result = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
    await this.cdp.send("Browser.setWindowBounds", { windowId: result.windowId, bounds: { windowState: "normal" } });
    await this.cdp.send("Browser.setWindowBounds", {
      windowId: result.windowId,
      bounds: {
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
        width: Math.max(320, Math.round(bounds.width)),
        height: Math.max(240, Math.round(bounds.height))
      }
    });
  }
  async bringToFront() {
    await this.ensurePage();
    try {
      const result = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
      await this.cdp.send("Browser.setWindowBounds", { windowId: result.windowId, bounds: { windowState: "normal" } });
    } catch {
      // ignore
    }
    await this.cdp.send("Page.bringToFront", {}, this.sessionId);
  }
  async minimize() {
    await this.ensurePage();
    const result = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
    await this.cdp.send("Browser.setWindowBounds", { windowId: result.windowId, bounds: { windowState: "minimized" } });
  }
  async pageUrls() {
    const targets = await this.cdp.send("Target.getTargets");
    return targets.targetInfos.filter((target) => target.type === "page" && (target.url === "about:blank" || /^https?:/.test(target.url))).map((target) => target.url);
  }
  async replaceTabs(urlValues) {
    const urls = urlValues.map((url) => url === "about:blank" ? url : validateWebUrl(url));
    if (!urls.length) throw new Error("主控窗口没有可以同步的网页标签");
    const oldTargets = await this.cdp.send("Target.getTargets");
    const oldPages = oldTargets.targetInfos.filter((target) => target.type === "page" && !target.url.startsWith("devtools:"));
    for (const url of urls) await this.cdp.send("Target.createTarget", { url });
    for (const target of oldPages) await this.cdp.send("Target.closeTarget", { targetId: target.targetId });
    this.targetId = void 0;
    this.sessionId = void 0;
    this.syncTabTargets.clear();
    this.activeSyncTabIndex = void 0;
    await this.ensurePage();
  }
  async closeTabs(mode) {
    const targets = await this.cdp.send("Target.getTargets");
    const pages = targets.targetInfos.filter((target) => target.type === "page" && !target.url.startsWith("devtools:"));
    if (!pages.length) return;
    let activeTargetId = this.targetId;
    for (const page of pages) {
      const attached = await this.cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      try {
        const state = await this.cdp.send("Runtime.evaluate", {
          expression: "document.visibilityState",
          returnByValue: true
        }, attached.sessionId);
        if (state.result?.value === "visible") {
          activeTargetId = page.targetId;
          break;
        }
      } finally {
        await this.cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => void 0);
      }
    }
    activeTargetId ??= pages[pages.length - 1].targetId;
    const selected = mode === "current" ? pages.filter((page) => page.targetId === activeTargetId) : mode === "others" ? pages.filter((page) => page.targetId !== activeTargetId) : pages.filter((page) => page.url === "about:blank" || page.url.startsWith("chrome://newtab"));
    for (const page of selected) await this.cdp.send("Target.closeTarget", { targetId: page.targetId });
    if (selected.some((page) => page.targetId === this.targetId)) {
      this.targetId = void 0;
      this.sessionId = void 0;
    }
  }
  async visit(urlValue, newTab) {
    const url = validateWebUrl(urlValue);
    if (newTab) {
      await this.cdp.send("Target.createTarget", { url });
      return;
    }
    await this.ensurePage();
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
  }
  async listTargets() {
    const targets = await this.cdp.send("Target.getTargets");
    return (targets.targetInfos ?? []).flatMap((target) => {
      const kind = targetKind(target);
      return kind ? [{
        targetId: target.targetId,
        kind,
        title: boundedText(target.title, 500),
        url: target.url.slice(0, 2048),
        selected: target.targetId === this.targetId
      }] : [];
    });
  }
  async selectTarget(targetIdValue) {
    const targetId = validateTargetId(targetIdValue);
    const target = (await this.listTargets()).find((item) => item.targetId === targetId);
    if (!target) throw new Error("页面目标不存在、已经关闭或不是可控制的网页/扩展页面");
    await this.attach(targetId);
    await this.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => void 0);
    this.references.clear();
    return { target: { ...target, selected: true }, ...await this.pageState() };
  }
  async waitForTarget(filterInput) {
    const kind = filterInput.kind;
    if (kind !== void 0 && kind !== "web" && kind !== "extension") throw new Error("页面目标类型无效");
    const titleContains = boundedFilter(filterInput.titleContains, "页面标题条件");
    const urlContains = boundedFilter(filterInput.urlContains, "页面地址条件");
    const timeoutMs = filterInput.timeoutMs ?? 15e3;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 6e4) throw new Error("等待时间必须为 0–60000 毫秒");
    const deadline = Date.now() + timeoutMs;
    do {
      const targets = await this.listTargets();
      const matches = targets.filter((target2) => {
        if (kind && target2.kind !== kind) return false;
        if (titleContains && !target2.title.toLocaleLowerCase().includes(titleContains.toLocaleLowerCase())) return false;
        if (urlContains && !target2.url.toLocaleLowerCase().includes(urlContains.toLocaleLowerCase())) return false;
        return true;
      });
      const target = matches.at(-1);
      if (target) return this.selectTarget(target.targetId);
      if (Date.now() >= deadline) break;
      await delay(Math.min(150, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error("等待匹配的网页或扩展窗口超时");
  }
  async open(urlValue) {
    const url = validateWebUrl(urlValue);
    const created = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    await this.attach(created.targetId);
    const navigation = await this.cdp.send("Page.navigate", { url }, this.sessionId);
    if (navigation.errorText) throw new Error(`无法打开网页：${navigation.errorText}`);
    await this.waitForDocument();
    this.references.clear();
    return this.pageStateAfterAction();
  }
  async navigate(urlValue) {
    const url = validateWebUrl(urlValue);
    await this.ensurePage();
    const previous = await this.pageState();
    const generation = this.documentGeneration;
    const navigation = await this.cdp.send("Page.navigate", { url }, this.sessionId);
    if (navigation.errorText) throw new Error(`无法打开网页：${navigation.errorText}`);
    await this.waitForDocumentGeneration(generation);
    await this.waitForDocument();
    this.references.clear();
    return this.verifiedAction(previous);
  }
  async history(direction) {
    await this.ensurePage();
    const previous = await this.pageState();
    const generation = this.documentGeneration;
    const history = await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId);
    const index = history.currentIndex + (direction === "back" ? -1 : 1);
    const entry = history.entries[index];
    if (!entry) throw new BrowserControlError("HISTORY_ENTRY_UNAVAILABLE", `当前页面无法${direction === "back" ? "后退" : "前进"}`, false);
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, this.sessionId);
    await this.waitForDocumentGeneration(generation);
    await this.waitForDocument();
    this.references.clear();
    return this.verifiedAction(previous);
  }
  async reload(ignoreCache = false) {
    await this.ensurePage();
    const previous = await this.pageState();
    const generation = this.documentGeneration;
    await this.cdp.send("Page.reload", { ignoreCache: Boolean(ignoreCache) }, this.sessionId);
    await this.waitForDocumentGeneration(generation);
    await this.waitForDocument();
    this.references.clear();
    return this.verifiedAction(previous, true);
  }
  async hover(ref) {
    const reference = this.reference(ref);
    const previous = await this.pageState();
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: reference.backendNodeId }, reference.sessionId);
    const { model } = await this.cdp.send("DOM.getBoxModel", {
      backendNodeId: reference.backendNodeId
    }, reference.sessionId);
    const quad = model.content ?? model.border;
    if (!quad || quad.length !== 8) throw new Error("目标元素当前不可悬停");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, reference.sessionId);
    await delay(80);
    return this.verifiedAction(previous, false);
  }
  async scrollElementIntoView(ref) {
    const reference = this.reference(ref);
    const previous = await this.pageState();
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: reference.backendNodeId }, reference.sessionId);
    await delay(80);
    return this.verifiedAction(previous, false);
  }
  async selectOptions(ref, valuesInput) {
    if (!Array.isArray(valuesInput) || !valuesInput.length || valuesInput.length > 100 || valuesInput.some((value) => typeof value !== "string" || value.length > 1e3)) throw new Error("下拉选项值无效");
    const reference = this.reference(ref);
    const previousState = await this.pageState();
    const resolved = await this.cdp.send("DOM.resolveNode", { backendNodeId: reference.backendNodeId }, reference.sessionId);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("无法解析下拉选择框");
    try {
      const result = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (values) {
          if (!(this instanceof HTMLSelectElement)) throw new Error('目标元素不是下拉选择框');
          if (this.disabled) throw new Error('下拉选择框已禁用');
          const previous = Array.from(this.selectedOptions).map((option) => option.value);
          const wanted = new Set(values.map(String));
          for (const option of this.options) option.selected = wanted.has(option.value);
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return { previous, selected: Array.from(this.selectedOptions).map((option) => option.value) };
        }`,
        arguments: [{ value: valuesInput }],
        returnByValue: true
      }, reference.sessionId);
      if (result.exceptionDetails || !result.result?.value) throw new Error("页面没有接受下拉选项修改");
      const previous = result.result.value.previous ?? [];
      const selected = result.result.value.selected ?? [];
      const expected = new Set(valuesInput);
      if (selected.length !== expected.size || selected.some((value) => !expected.has(value))) throw new Error("页面下拉选项与要求不一致");
      this.references.clear();
      return { ...await this.verifiedAction(previousState), previous, selected, changed: JSON.stringify(previous) !== JSON.stringify(selected) };
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, reference.sessionId).catch(() => void 0);
    }
  }
  async snapshot(options = {}) {
    const operationStarted = performance.now();
    await this.ensurePage();
    const pageSize = options.pageSize ?? DEFAULT_PAGE_NODES;
    const compact = options.compact !== false;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_NODES) {
      throw new Error(`快照每页元素数量必须为 1–${MAX_PAGE_NODES}`);
    }
    if (options.cursor) return this.snapshotPage(options.cursor, pageSize);
    const previousSnapshot = options.previousSnapshotId ? this.snapshots.get(options.previousSnapshotId) : void 0;
    const generation = this.documentGeneration;
    const cdpStarted = performance.now();
    const documentSessions = await this.documentSessions();
    const trees = await Promise.all(documentSessions.map(async (sessionId) => ({
      sessionId,
      tree: await this.cdp.send("Accessibility.getFullAXTree", {}, sessionId)
    })));
    let cdpMs = performance.now() - cdpStarted;
    this.references.clear();
    this.snapshotCursors.clear();
    this.snapshotVersion += 1;
    const entries = [];
    const inspections = [];
    const frameBoundaryCache = /* @__PURE__ */ new Map();
    let textLength = 0;
    let truncated = false;
    let absoluteIndex = 0;
    for (const { sessionId, tree } of trees) for (const node of tree.nodes ?? []) {
      const index = absoluteIndex++;
      if (node.ignored) continue;
      const role = boundedText(node.role?.value, 80).toLowerCase();
      const name = boundedText(node.name?.value);
      const actionable = ACTIONABLE_ROLES.has(role) && Number.isInteger(node.backendDOMNodeId);
      const isFrame = ["iframe", "frame"].includes(role) && Number.isInteger(node.backendDOMNodeId);
      const canReference = actionable || isFrame;
      if (!name && !canReference) continue;
      if (compact && !actionable && ["inlinetextbox", "statictext", "text"].includes(role) && [...name.trim()].length <= 1) continue;
      if (entries.length >= MAX_SNAPSHOT_NODES || textLength + name.length > MAX_PAGE_TEXT) {
        truncated = true;
        break;
      }
      const item = { role: role || "text" };
      if (name) item.name = name;
      const accessibleValue = boundedText(node.value?.value, MAX_INPUT_TEXT);
      if (accessibleValue) item.value = accessibleValue;
      const properties = new Map((node.properties ?? []).map((property) => [property.name, property.value?.value]));
      for (const property of ["checked", "disabled", "expanded", "selected"]) {
        if (properties.has(property)) item[property] = properties.get(property);
      }
      if (canReference) {
        item.actionable = actionable;
        const ref = `ref_${randomUUID().replaceAll("-", "")}`;
        item.ref = ref;
        if (sessionId !== this.sessionId) item.frameDepth = 1;
        this.references.set(ref, {
          backendNodeId: node.backendDOMNodeId,
          role,
          sessionId,
          targetId: this.targetId,
          documentGeneration: this.documentGeneration,
          snapshotVersion: this.snapshotVersion
        });
        inspections.push(async () => {
          const [geometry, described, details] = await Promise.all([
            this.elementGeometry(node.backendDOMNodeId, sessionId, frameBoundaryCache).catch(() => void 0),
            isFrame ? this.cdp.send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId }, sessionId).catch(() => void 0) : Promise.resolve(void 0),
            this.inspectElement(node.backendDOMNodeId, sessionId)
          ]);
          if (geometry) {
            item.rect = roundedRect(geometry.rect);
            item.coordinateSpace = geometry.coordinateSpace;
            if (geometry.frameId) item.frameId = geometry.frameId;
          } else item.rect = null;
          const frameId = described?.node?.contentDocument?.frameId ?? described?.node?.frameId;
          if (frameId) item.frameId = frameId;
          if (!details) return;
          if (EDITABLE_ROLES.has(role) && typeof details.value === "string") item.value = details.value;
          if (details.tagName) item.tagName = details.tagName;
          if (details.type) item.type = details.type;
          if (details.placeholder) item.placeholder = details.placeholder;
          if (details.href) item.href = details.href;
          if (details.crossOrigin !== void 0) item.crossOrigin = details.crossOrigin;
          const frameDepth = Math.max(details.frameDepth, sessionId === this.sessionId ? 0 : 1);
          if (frameDepth) item.frameDepth = frameDepth;
          if (details.shadowDepth) item.shadowDepth = details.shadowDepth;
        });
      }
      const key = Number.isInteger(node.backendDOMNodeId) ? `dom:${sessionId}:${node.backendDOMNodeId}:${role}` : `ax:${sessionId}:${index}:${role}:${name}`;
      entries.push({ key, signature: "", element: item });
      textLength += name.length;
    }
    const inspectStarted = performance.now();
    let nextInspection = 0;
    await Promise.all(Array.from({ length: Math.min(SNAPSHOT_INSPECTION_CONCURRENCY, inspections.length) }, async () => {
      while (nextInspection < inspections.length) await inspections[nextInspection++]();
    }));
    cdpMs += performance.now() - inspectStarted;
    for (const entry of entries) {
      entry.signature = JSON.stringify(entry.element, (field, value) => SNAPSHOT_SIGNATURE_EXCLUDED_FIELDS.has(field) ? void 0 : value);
    }
    const validationStarted = performance.now();
    const state = await this.pageState();
    if (generation !== this.documentGeneration) {
      this.references.clear();
      throw new BrowserControlError("STALE_SNAPSHOT", "读取期间页面已导航，请重新读取页面", true, "prism_read_page");
    }
    const validationMs = performance.now() - validationStarted;
    const snapshot = {
      id: `snapshot_${randomUUID().replaceAll("-", "")}`,
      targetId: this.targetId,
      sessionId: this.sessionId,
      documentGeneration: this.documentGeneration,
      version: this.snapshotVersion,
      state,
      entries,
      truncated,
      compact
    };
    this.snapshots.set(snapshot.id, snapshot);
    while (this.snapshots.size > MAX_SNAPSHOT_HISTORY) this.snapshots.delete(this.snapshots.keys().next().value);
    let responseEntries = entries;
    let removedRefs = [];
    let delta = false;
    if (options.previousSnapshotId) {
      const previous = previousSnapshot;
      if (previous && previous.targetId === snapshot.targetId && previous.documentGeneration === snapshot.documentGeneration) {
        const previousByKey = new Map(previous.entries.map((entry) => [entry.key, entry]));
        const currentKeys = new Set(entries.map((entry) => entry.key));
        responseEntries = entries.filter((entry) => previousByKey.get(entry.key)?.signature !== entry.signature);
        removedRefs = previous.entries.filter((entry) => !currentKeys.has(entry.key)).flatMap((entry) => typeof entry.element.ref === "string" ? [entry.element.ref] : []);
        delta = true;
      }
    }
    return this.makeSnapshotPage(snapshot, responseEntries, removedRefs, delta, 0, pageSize, {
      elapsedMs: performance.now() - operationStarted,
      timings: { cdpMs, waitMs: 0, validationMs }
    });
  }
  async readText(options = {}) {
    const maxChars = this.readLimit(options.maxChars, 5e4);
    if (options.ref) {
      const value = await this.readReferencedElement(options.ref, "text", { maxChars });
      return { ...value, scope: "element" };
    }
    const values = await this.evaluateDocumentReaders("text", { maxChars });
    const text2 = values.map((value) => value.text).filter(Boolean).join("\n\n");
    return {
      text: text2.slice(0, maxChars),
      length: values.reduce((sum, value) => sum + value.length, 0),
      truncated: text2.length > maxChars || values.some((value) => value.truncated),
      scope: "page"
    };
  }
  async readAttribute(ref, nameValue) {
    const name = typeof nameValue === "string" ? nameValue.trim() : "";
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]{0,100}$/.test(name)) throw new Error("页面属性名称无效");
    return await this.readReferencedElement(ref, "attribute", { name });
  }
  async readMarkdown(options = {}) {
    const maxChars = this.readLimit(options.maxChars, 6e4);
    const values = await this.evaluateDocumentReaders("markdown", { maxChars });
    const markdown = values.map((value) => value.markdown).filter(Boolean).join("\n\n");
    return {
      markdown: markdown.slice(0, maxChars),
      length: values.reduce((sum, value) => sum + value.length, 0),
      truncated: markdown.length > maxChars || values.some((value) => value.truncated)
    };
  }
  async readTable(options = {}) {
    const index = options.index ?? 0;
    const maxRows = options.maxRows ?? 100;
    const maxColumns = options.maxColumns ?? 30;
    if (!Number.isInteger(index) || index < 0 || index > 1e3) throw new Error("表格序号无效");
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) throw new Error("表格最大行数必须为 1–500");
    if (!Number.isInteger(maxColumns) || maxColumns < 1 || maxColumns > 100) throw new Error("表格最大列数必须为 1–100");
    const input = { index, maxRows, maxColumns };
    return options.ref ? this.readReferencedElement(options.ref, "table", input) : this.evaluatePageReader("table", input);
  }
  async readList(options = {}) {
    const index = options.index ?? 0;
    const maxItems = options.maxItems ?? 200;
    if (!Number.isInteger(index) || index < 0 || index > 1e3) throw new Error("列表序号无效");
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1e3) throw new Error("列表最大项目数必须为 1–1000");
    const input = { index, maxItems };
    return options.ref ? this.readReferencedElement(options.ref, "list", input) : this.evaluatePageReader("list", input);
  }
  async pageSchema() {
    const values = await this.evaluateDocumentReaders("schema", {});
    const root = values[0] ?? {};
    const countNames = ["links", "buttons", "inputs", "forms", "tables", "lists", "images", "frames", "crossOriginFrames", "shadowRoots"];
    return {
      title: root.title ?? "",
      url: root.url ?? "",
      headings: values.flatMap((value, index) => (value.headings ?? []).map((heading) => ({
        ...heading,
        frameDepth: Number(heading.frameDepth ?? 0) + (index === 0 ? 0 : 1)
      }))).slice(0, 100),
      counts: Object.fromEntries(countNames.map((name) => [
        name,
        values.reduce((sum, value) => sum + Number(value.counts?.[name] ?? 0), 0)
      ]))
    };
  }
  async find(queryValue, maxResultsValue = 50) {
    const query = typeof queryValue === "string" ? queryValue.trim().toLocaleLowerCase() : "";
    if (!query || query.length > 500) throw new Error("页面查找文本长度必须为 1–500");
    const maxResults = maxResultsValue ?? 50;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new Error("页面查找结果数必须为 1–200");
    const result = await this.snapshot({ pageSize: 1 });
    const snapshot = this.snapshots.get(result.snapshotId);
    const matches = snapshot.entries.filter((entry) => {
      const value = Object.values(entry.element).filter((item) => typeof item === "string").join(" ").toLocaleLowerCase();
      return value.includes(query);
    });
    return {
      query: queryValue.trim(),
      snapshotId: snapshot.id,
      documentGeneration: snapshot.documentGeneration,
      results: matches.slice(0, maxResults).map((entry) => entry.element),
      totalMatches: matches.length
    };
  }
  async waitForStable(options = {}) {
    await this.ensurePage();
    const timeoutMs = this.waitTimeout(options.timeoutMs, 3e4);
    const networkIdleMs = options.networkIdleMs ?? 500;
    const domQuietMs = options.domQuietMs ?? 500;
    if (!Number.isInteger(networkIdleMs) || networkIdleMs < 0 || networkIdleMs > 1e4 || !Number.isInteger(domQuietMs) || domQuietMs < 0 || domQuietMs > 1e4) throw new Error("页面稳定等待参数无效");
    const started = Date.now();
    do {
      const state = await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          if (!globalThis.__prismMcpStability) {
            const state = { lastMutation: performance.now() };
            new MutationObserver(() => { state.lastMutation = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            Object.defineProperty(globalThis, '__prismMcpStability', { value: state });
          }
          return { readyState: document.readyState, domQuietFor: performance.now() - globalThis.__prismMcpStability.lastMutation };
        })()`,
        returnByValue: true
      }, this.sessionId);
      const value = state.result?.value;
      if (value?.readyState === "complete" && Number(value.domQuietFor ?? 0) >= domQuietMs && this.inflightNetwork.size === 0 && Date.now() - this.lastNetworkActivityAt >= networkIdleMs) {
        return { stable: true, waitedMs: Date.now() - started, inflightRequests: 0, ...await this.pageState() };
      }
      await delay(100);
    } while (Date.now() - started <= timeoutMs);
    throw new BrowserControlError("PAGE_NOT_STABLE", "等待页面稳定超时", true, "prism_wait_for_stable");
  }
  async waitForElement(query, options = {}) {
    const timeoutMs = this.waitTimeout(options.timeoutMs, 15e3);
    const started = Date.now();
    do {
      const result = await this.find(query, 50);
      if (result.totalMatches) return { found: true, waitedMs: Date.now() - started, snapshotId: result.snapshotId, results: result.results };
      await delay(150);
    } while (Date.now() - started <= timeoutMs);
    throw new BrowserControlError("ELEMENT_WAIT_TIMEOUT", "等待页面元素超时", true, "prism_wait_for_element");
  }
  async waitForText(textValue, options = {}) {
    const text2 = typeof textValue === "string" ? textValue.trim() : "";
    if (!text2 || text2.length > 2e3) throw new Error("等待文本长度必须为 1–2000");
    const timeoutMs = this.waitTimeout(options.timeoutMs, 15e3);
    const started = Date.now();
    do {
      const page = await this.readText({ maxChars: 2e5 });
      if (page.text.toLocaleLowerCase().includes(text2.toLocaleLowerCase())) return { found: true, waitedMs: Date.now() - started, text: text2 };
      await delay(150);
    } while (Date.now() - started <= timeoutMs);
    throw new BrowserControlError("TEXT_WAIT_TIMEOUT", "等待页面文本超时", true, "prism_wait_for_text");
  }
  async waitForUrl(options) {
    const contains = boundedFilter(options.contains, "URL 包含条件");
    const equals = boundedFilter(options.equals, "URL 相等条件");
    if (!contains && !equals) throw new Error("至少需要一个 URL 等待条件");
    const timeoutMs = this.waitTimeout(options.timeoutMs, 15e3);
    const started = Date.now();
    do {
      const state = await this.pageState();
      if ((!contains || state.url.includes(contains)) && (!equals || state.url === equals)) {
        return { matched: true, waitedMs: Date.now() - started, ...state };
      }
      await delay(100);
    } while (Date.now() - started <= timeoutMs);
    throw new BrowserControlError("URL_WAIT_TIMEOUT", "等待页面地址变化超时", true, "prism_wait_for_url");
  }
  async waitForDownload(options = {}) {
    const timeoutMs = this.waitTimeout(options.timeoutMs, 6e4);
    const filenameContains = boundedFilter(options.filenameContains, "下载文件名条件")?.toLocaleLowerCase();
    const started = Date.now();
    do {
      const match = [...this.downloads.values()].reverse().find((item) => item.state === "completed" && (!filenameContains || item.suggestedFilename.toLocaleLowerCase().includes(filenameContains)));
      if (match) return { ...match, waitedMs: Date.now() - started };
      await delay(150);
    } while (Date.now() - started <= timeoutMs);
    throw new BrowserControlError("DOWNLOAD_WAIT_TIMEOUT", "等待文件下载完成超时", true, "prism_wait_for_download");
  }
  listNetworkRequests(options = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NETWORK_RECORDS) throw new Error(`网络请求数量必须为 1–${MAX_NETWORK_RECORDS}`);
    const types = options.resourceTypes?.map((value) => String(value).toLocaleLowerCase());
    const items = [...this.networkRecords.values()].filter((record) => !types?.length || types.includes(record.resourceType.toLocaleLowerCase()));
    return { requests: items.slice(-limit).map((record) => this.publicNetworkRecord(record)), total: items.length };
  }
  async networkRequest(idValue, includeBody = false) {
    const id = typeof idValue === "string" ? idValue : "";
    if (!/^net_[a-f\d]{32}$/i.test(id)) throw new Error("网络请求 ID 无效");
    const record = this.networkRecords.get(id);
    if (!record) throw new BrowserControlError("NETWORK_REQUEST_NOT_FOUND", "网络请求不存在或已从任务缓冲区清理", false, "prism_list_network_requests");
    const result = this.publicNetworkRecord(record);
    if (!includeBody) return result;
    if (!record.finishedAt || record.failed) return { ...result, bodyOmitted: "response-not-available" };
    if ((record.encodedDataLength ?? 0) > MAX_NETWORK_BODY_BYTES) return { ...result, bodyOmitted: "response-too-large" };
    if (!/^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded))/i.test(record.mimeType ?? "")) {
      return { ...result, bodyOmitted: "binary-response" };
    }
    try {
      const body = await this.cdp.send("Network.getResponseBody", {
        requestId: record.cdpRequestId
      }, record.sessionId);
      if (typeof body.body !== "string" || Buffer.byteLength(body.body, body.base64Encoded ? "base64" : "utf8") > MAX_NETWORK_BODY_BYTES) {
        return { ...result, bodyOmitted: "response-too-large" };
      }
      return { ...result, body: body.body, bodyBase64: Boolean(body.base64Encoded) };
    } catch {
      return { ...result, bodyOmitted: "response-evicted" };
    }
  }
  startHar() {
    this.harStartedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.harRecordIds = [];
    return { started: true, startedAt: this.harStartedAt };
  }
  stopHar() {
    if (!this.harStartedAt) throw new BrowserControlError("HAR_NOT_STARTED", "当前任务尚未开始 HAR 记录", false, "prism_start_har");
    const ids = [...this.harRecordIds];
    this.harStartedAt = void 0;
    this.harRecordIds = [];
    const entries = ids.flatMap((id) => {
      const record = this.networkRecords.get(id);
      if (!record) return [];
      return [{
        startedDateTime: record.startedAt,
        time: record.finishedAt ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : 0,
        request: { method: record.method, url: record.url, httpVersion: "HTTP/1.1", headers: Object.entries(record.requestHeaders).map(([name, value]) => ({ name, value })), queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: record.status ?? 0, statusText: record.statusText ?? "", httpVersion: "HTTP/1.1", headers: Object.entries(record.responseHeaders ?? {}).map(([name, value]) => ({ name, value })), cookies: [], content: { size: record.encodedDataLength ?? 0, mimeType: record.mimeType ?? "" }, redirectURL: "", headersSize: -1, bodySize: record.encodedDataLength ?? -1 },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _resourceType: record.resourceType
      }];
    });
    return { log: { version: "1.2", creator: { name: "Prism Browser", version: "0.3.10" }, pages: [], entries }, truncated: ids.length >= MAX_HAR_RECORDS };
  }
  async setOffline(offlineValue) {
    if (typeof offlineValue !== "boolean") throw new Error("离线状态无效");
    await this.ensurePage();
    await this.cdp.send("Network.emulateNetworkConditions", {
      offline: offlineValue,
      latency: 0,
      downloadThroughput: offlineValue ? 0 : -1,
      uploadThroughput: offlineValue ? 0 : -1
    }, this.sessionId);
    return { offline: offlineValue };
  }
  async screenshot() {
    await this.ensurePage();
    const metrics = await this.cdp.send("Page.getLayoutMetrics", {}, this.sessionId);
    const viewport = metrics.cssVisualViewport;
    const width = Math.max(1, Math.round(Number(viewport?.clientWidth ?? 0)));
    const height = Math.max(1, Math.round(Number(viewport?.clientHeight ?? 0)));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width > 1e4 || height > 1e4) {
      throw new Error("当前页面视口尺寸无效");
    }
    const captured = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: Number(viewport?.pageX ?? 0),
        y: Number(viewport?.pageY ?? 0),
        width,
        height,
        scale: 1
      }
    }, this.sessionId);
    if (typeof captured.data !== "string" || !captured.data.length || captured.data.length > 20 * 1024 * 1024) {
      throw new Error("浏览器截图结果无效或过大");
    }
    const state = await this.pageState();
    return {
      targetId: this.targetId,
      title: state.title,
      url: state.url,
      width,
      height,
      mimeType: "image/png",
      data: captured.data
    };
  }
  async fullPageScreenshot() {
    await this.ensurePage();
    const metrics = await this.cdp.send("Page.getLayoutMetrics", {}, this.sessionId);
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.max(1, Math.ceil(Number(size?.width ?? 0)));
    const height = Math.max(1, Math.ceil(Number(size?.height ?? 0)));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width > 16384 || height > 1e5 || width * height > 25e7) {
      throw new BrowserControlError("FULL_PAGE_TOO_LARGE", "页面尺寸过大，无法生成安全的全页面截图", false, "prism_take_screenshot");
    }
    const captured = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    }, this.sessionId);
    if (typeof captured.data !== "string" || !captured.data.length || captured.data.length > 50 * 1024 * 1024) {
      throw new Error("全页面截图结果无效或超过 50 MB");
    }
    const state = await this.pageState();
    return { targetId: this.targetId, title: state.title, url: state.url, width, height, mimeType: "image/png", data: captured.data };
  }
  /** Fresh CSS coordinates in the selected top-level viewport, including OOPIF offsets. */
  async elementRect(ref) {
    await this.ensurePage();
    const reference = this.reference(ref);
    const geometry = await this.elementGeometry(reference.backendNodeId, reference.sessionId);
    this.reference(ref);
    return { ref, ...geometry };
  }
  async clickAndHold(options) {
    const durationMs = this.inputDuration(options.durationMs, 3e3, 100);
    return this.pointerGesture(options, void 0, { ...options, durationMs }, 1);
  }
  async drag(options) {
    const durationMs = this.inputDuration(options.durationMs, 600, 100);
    const steps = options.steps ?? 20;
    if (!Number.isInteger(steps) || steps < 1 || steps > 120) throw new Error("Drag steps must be an integer from 1 to 120");
    return this.pointerGesture(options.from, options.to, { ...options, durationMs }, steps);
  }
  cancelPendingInput(disableInput = false) {
    if (disableInput) this.inputDisabled = true;
    this.activeInput?.abort.abort();
  }
  cancelInputForSession(sessionId) {
    if (sessionId && this.activeInput?.sessions.has(sessionId)) this.activeInput.abort.abort();
  }
  /**
   * Runs one press/hold/release sequence. `done` settles only after the operation's own release
   * events were sent, so release()/close() can wait for them before detaching the session.
   */
  async runInput(operation) {
    if (this.activeInput) throw new Error("Another input gesture is already active");
    let settle;
    const input = { abort: new AbortController(), sessions: /* @__PURE__ */ new Set(), done: new Promise((resolve2) => {
      settle = resolve2;
    }) };
    this.activeInput = input;
    try {
      return await operation(input);
    } finally {
      if (this.activeInput === input) this.activeInput = void 0;
      settle();
    }
  }
  assertInputActive(input) {
    if (input.abort.signal.aborted || this.closed || this.inputDisabled) throw inputInterrupted();
  }
  /**
   * Waits for the release acknowledgement. After an interruption the pressed frame may already be
   * gone (Chrome then never acknowledges the event), so the wait is bounded instead of blocking the
   * task for the whole CDP timeout; the release itself has already been sent.
   */
  async sendInputRelease(input, release2) {
    if (!input.abort.signal.aborted) {
      await release2;
      return;
    }
    let timer;
    await Promise.race([release2, new Promise((resolve2) => {
      timer = setTimeout(resolve2, INPUT_RELEASE_ACK_WAIT_MS);
    })]);
    clearTimeout(timer);
  }
  /** Cancels a held gesture or key and waits (bounded) for its release events before the session goes away. */
  async settleActiveInput() {
    const input = this.activeInput;
    if (!input) return;
    input.abort.abort();
    let timer;
    await Promise.race([input.done, new Promise((resolve2) => {
      timer = setTimeout(resolve2, INPUT_RELEASE_WAIT_MS);
    })]);
    clearTimeout(timer);
  }
  inputDuration(value, fallback, minimum = 0) {
    const duration = value ?? fallback;
    if (!Number.isInteger(duration) || duration < minimum || duration > 15e3) {
      throw new Error(`Input durationMs must be an integer from ${minimum} to 15000`);
    }
    return duration;
  }
  async inputDelay(milliseconds, signal) {
    if (signal.aborted || this.closed || this.inputDisabled) throw inputInterrupted();
    await new Promise((resolve2, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(inputInterrupted());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve2();
      }, Math.max(0, milliseconds));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  checkedPoint(point, viewport) {
    const { x, y } = point;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error("Pointer coordinates must be finite CSS pixels inside the current viewport");
    }
    return { x, y };
  }
  /**
   * Resolves a gesture endpoint. A ref is measured through trusted frame geometry, clipped to its
   * own frame, every ancestor frame and the viewport, and pressed inside the visible part only.
   */
  async resolvePointer(target, scroll, input) {
    if (!target || typeof target !== "object") throw new Error("A pointer target is required");
    if (target.ref === void 0) return { point: this.checkedPoint(target, await this.viewportSize()) };
    if (target.x !== void 0 || target.y !== void 0) throw new Error("Provide either ref or x/y, not both");
    const reference = this.reference(target.ref);
    if (scroll) {
      this.assertInputActive(input);
      await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: reference.backendNodeId }, reference.sessionId);
    }
    const [quad, boundaries, viewport] = await Promise.all([
      this.localElementQuad(reference.backendNodeId, reference.sessionId),
      this.frameBoundaries(reference.sessionId),
      this.viewportSize()
    ]);
    this.reference(target.ref);
    for (const boundary of boundaries) input.sessions.add(boundary.childSessionId);
    const corners = mapToTopViewport(quadPoints(quad), boundaries);
    let visible = corners;
    for (let index = 0; index < boundaries.length && visible.length; index += 1) {
      visible = clipPolygon(visible, mapToTopViewport(quadPoints(boundaries[index].content), boundaries.slice(index + 1)));
    }
    visible = clipPolygon(visible, [
      { x: 0, y: 0 },
      { x: viewport.width, y: 0 },
      { x: viewport.width, y: viewport.height },
      { x: 0, y: viewport.height }
    ]);
    if (visible.length < 3 || Math.abs(polygonArea(visible)) < 1) throw elementNotVisible();
    const center = { x: corners.reduce((sum, point2) => sum + point2.x, 0) / 4, y: corners.reduce((sum, point2) => sum + point2.y, 0) / 4 };
    const preferred = insidePolygon(center, visible) ? center : polygonCentroid(visible);
    const point = preferred && pixelPointInside(preferred, visible);
    if (!point) throw elementNotVisible();
    return { point: this.checkedPoint(point, viewport), reference, boundaries };
  }
  /** Hit-tests a ref endpoint from the selected page down through each frame before anything is pressed. */
  async assertPointerHit(target) {
    if (!target.reference || !target.boundaries) return;
    let sessionId = this.sessionId;
    let point = target.point;
    for (let index = target.boundaries.length - 1; index >= 0; index -= 1) {
      const boundary = target.boundaries[index];
      if (!sessionId || boundary.parentSessionId !== sessionId) throw new Error("Frame geometry is no longer available; read the page again");
      if (await this.nodeAtPoint(sessionId, point) !== boundary.ownerBackendNodeId) throw elementObscured();
      const local = mapIntoChildFrame(point, boundary);
      if (!local || local.x < 0 || local.y < 0 || local.x >= boundary.width || local.y >= boundary.height) throw elementObscured();
      point = local;
      sessionId = boundary.childSessionId;
    }
    if (sessionId !== target.reference.sessionId) throw new Error("Frame geometry is no longer available; read the page again");
    const hit = await this.nodeAtPoint(sessionId, point);
    if (hit === void 0 || hit !== target.reference.backendNodeId && !await this.subtreeContains(sessionId, target.reference.backendNodeId, hit)) throw elementObscured();
  }
  async nodeAtPoint(sessionId, point) {
    const result = await this.cdp.send("DOM.getNodeForLocation", {
      x: Math.max(0, Math.round(point.x)),
      y: Math.max(0, Math.round(point.y)),
      includeUserAgentShadowDOM: false
    }, sessionId).catch(() => void 0);
    return Number.isInteger(result?.backendNodeId) ? result.backendNodeId : void 0;
  }
  /** Shadow-including, same-process-frame-including descendant check without running page script. */
  async subtreeContains(sessionId, ancestorBackendNodeId, backendNodeId) {
    const described = await this.cdp.send("DOM.describeNode", {
      backendNodeId: ancestorBackendNodeId,
      depth: -1,
      pierce: true
    }, sessionId).catch(() => void 0);
    const pending = described?.node ? [described.node] : [];
    for (let visited = 0; pending.length && visited < 1e5; visited += 1) {
      const node = pending.pop();
      if (node.backendNodeId === backendNodeId) return true;
      for (const list of [node.children, node.shadowRoots, node.pseudoElements]) for (const child of list ?? []) pending.push(child);
      if (node.contentDocument) pending.push(node.contentDocument);
      if (node.templateContent) pending.push(node.templateContent);
    }
    return false;
  }
  async pointerGesture(from, to, options, steps) {
    const button = options.button ?? "left";
    const pointerType = options.pointerType ?? "mouse";
    if (!["left", "right", "middle"].includes(button) || !["mouse", "touch"].includes(pointerType)) throw new Error("Unsupported pointer button or type");
    if (pointerType === "touch" && button !== "left") throw new Error("Touch input does not support right or middle buttons");
    let previous;
    await this.runInput(async (input) => {
      await this.ensurePage();
      this.assertInputActive(input);
      const sessionId = this.sessionId;
      input.sessions.add(sessionId);
      previous = await this.pageState();
      const start = await this.resolvePointer(from, !to, input);
      const end = to ? await this.resolvePointer(to, false, input) : void 0;
      let point = start.point;
      let pressed = false;
      let failed = false;
      const buttons = { left: 1, right: 2, middle: 4 }[button];
      const mouse = (type, held) => this.cdp.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: type === "mouseMoved" && !held ? "none" : button,
        buttons: held ? buttons : 0,
        clickCount: type === "mouseMoved" ? 0 : 1,
        pointerType: "mouse"
      }, sessionId);
      const touch = (type) => this.cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ ...point, id: 1, radiusX: 2, radiusY: 2, force: 1 }]
      }, sessionId);
      try {
        await this.inputDelay(0, input.abort.signal);
        if (pointerType === "mouse") await mouse("mouseMoved", false);
        await this.assertPointerHit(start);
        if (end) await this.assertPointerHit(end);
        this.assertInputActive(input);
        pressed = true;
        if (pointerType === "touch") await touch("touchStart");
        else await mouse("mousePressed", true);
        const started = performance.now();
        for (let step = 1; step <= steps; step++) {
          await this.inputDelay(started + options.durationMs * step / steps - performance.now(), input.abort.signal);
          if (end) {
            point = { x: start.point.x + (end.point.x - start.point.x) * step / steps, y: start.point.y + (end.point.y - start.point.y) * step / steps };
            if (pointerType === "touch") await touch("touchMove");
            else await mouse("mouseMoved", true);
          }
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          if (pressed) {
            await this.sendInputRelease(input, pointerType === "touch" ? touch(failed || input.abort.signal.aborted ? "touchCancel" : "touchEnd") : mouse("mouseReleased", false));
          }
        } catch (error) {
          if (!failed) throw error;
        } finally {
          if (pressed) this.references.clear();
        }
      }
    });
    await delay(80);
    return { ...await this.verifiedAction(previous, true), durationMs: options.durationMs };
  }
  async localElementQuad(backendNodeId, sessionId) {
    const box = await this.cdp.send("DOM.getBoxModel", { backendNodeId }, sessionId);
    const quad = box.model?.border ?? box.model?.content;
    if (!validQuad(quad)) throw new Error("Element has no visible layout box");
    return quad;
  }
  /** Boundaries from the frame owning `sessionId` up to the selected page (empty for the page itself). */
  frameBoundaries(sessionId, cache, depth = 0) {
    if (sessionId === this.sessionId) return Promise.resolve([]);
    const cached = cache?.get(sessionId);
    if (cached) return cached;
    const measured = this.measureFrameBoundary(sessionId, cache, depth);
    cache?.set(sessionId, measured);
    return measured;
  }
  async measureFrameBoundary(sessionId, cache, depth) {
    const frame = this.frameAttachments.get(sessionId);
    if (!frame || depth >= MAX_FRAME_NESTING) throw new Error("Frame geometry is no longer available; read the page again");
    const [ancestors, owner] = await Promise.all([
      this.frameBoundaries(frame.parentSessionId, cache, depth + 1),
      this.cdp.send("DOM.getFrameOwner", { frameId: frame.frameId }, frame.parentSessionId)
    ]);
    const ownerBackendNodeId = owner?.backendNodeId;
    if (typeof ownerBackendNodeId !== "number" || !Number.isInteger(ownerBackendNodeId)) throw new Error("Frame viewport is unavailable");
    const box = await this.cdp.send("DOM.getBoxModel", {
      backendNodeId: ownerBackendNodeId
    }, frame.parentSessionId);
    const content = box.model?.content, border = box.model?.border;
    const offsetWidth = Number(box.model?.width), offsetHeight = Number(box.model?.height);
    if (!validQuad(content) || !validQuad(border) || !(offsetWidth > 0) || !(offsetHeight > 0)) throw new Error("Frame viewport is unavailable");
    if (Math.abs(content[0] + content[4] - content[2] - content[6]) > 1 || Math.abs(content[1] + content[5] - content[3] - content[7]) > 1) {
      throw new Error("Perspective-transformed frames require screenshot coordinates");
    }
    const edge = (quad, to) => Math.hypot(quad[to] - quad[0], quad[to + 1] - quad[1]);
    const width = offsetWidth * edge(content, 2) / edge(border, 2);
    const height = offsetHeight * edge(content, 6) / edge(border, 6);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Frame viewport is unavailable");
    return [{ childSessionId: sessionId, parentSessionId: frame.parentSessionId, ownerBackendNodeId, content, width, height }, ...ancestors];
  }
  async elementGeometry(backendNodeId, sessionId, cache) {
    const [local, boundaries] = await Promise.all([
      this.localElementQuad(backendNodeId, sessionId),
      this.frameBoundaries(sessionId, cache)
    ]);
    const quad = mapToTopViewport(quadPoints(local), boundaries).flatMap((point) => [point.x, point.y]);
    const frameId = this.frameAttachments.get(sessionId)?.frameId;
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
    if (!(width > 0) || !(height > 0)) throw new Error("Element has no visible layout box");
    return { rect: { x, y, width, height }, quad, coordinateSpace: "viewport", ...frameId ? { frameId } : {} };
  }
  async clickPoint(xValue, yValue) {
    await this.ensurePage();
    const viewport = await this.viewportSize();
    const x = Number(xValue);
    const y = Number(yValue);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`点击坐标必须位于当前视口 0–${Math.max(0, viewport.width - 1)} × 0–${Math.max(0, viewport.height - 1)} 内`);
    }
    const params = { x, y, button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { ...params, type: "mousePressed" }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { ...params, type: "mouseReleased" }, this.sessionId);
    this.references.clear();
    await delay(150);
    return this.pageStateAfterAction();
  }
  async scroll(deltaXValue, deltaYValue) {
    await this.ensurePage();
    const deltaX = Number(deltaXValue);
    const deltaY = Number(deltaYValue);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 1e4 || Math.abs(deltaY) > 1e4 || !deltaX && !deltaY) {
      throw new Error("滚动距离无效，单次水平或垂直距离不能超过 10000");
    }
    const viewport = await this.viewportSize();
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: viewport.width / 2,
      y: viewport.height / 2,
      deltaX,
      deltaY
    }, this.sessionId);
    await delay(100);
    return this.pageStateAfterAction();
  }
  async dispatchHeldKey(down, up, durationValue) {
    const duration = this.inputDuration(durationValue, 0);
    if (this.closed || this.inputDisabled || this.activeInput) throw new Error("Browser input is unavailable or already active");
    await this.runInput(async (input) => {
      const sessionId = this.sessionId;
      input.sessions.add(sessionId);
      let failed = false;
      try {
        await this.cdp.send("Input.dispatchKeyEvent", down, sessionId);
        if (duration) await this.inputDelay(duration, input.abort.signal);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await this.sendInputRelease(input, this.cdp.send("Input.dispatchKeyEvent", up, sessionId));
        } catch (error) {
          if (!failed) throw error;
        } finally {
          this.references.clear();
        }
      }
    });
  }
  async pressKey(keyValue, durationValue) {
    await this.ensurePage();
    const keys = {
      Enter: { key: "Enter", code: "Enter", text: "\r" },
      Tab: { key: "Tab", code: "Tab" },
      Escape: { key: "Escape", code: "Escape" },
      Space: { key: " ", code: "Space", text: " " },
      Backspace: { key: "Backspace", code: "Backspace" },
      Delete: { key: "Delete", code: "Delete" },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp" },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown" },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft" },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight" },
      Home: { key: "Home", code: "Home" },
      End: { key: "End", code: "End" },
      PageUp: { key: "PageUp", code: "PageUp" },
      PageDown: { key: "PageDown", code: "PageDown" }
    };
    const key = keys[keyValue];
    if (!key) throw new Error(`不支持的按键：${String(keyValue).slice(0, 40)}`);
    await this.dispatchHeldKey({ type: "keyDown", ...key }, { type: "keyUp", key: key.key, code: key.code }, durationValue);
    this.references.clear();
    await delay(100);
    return this.pageStateAfterAction();
  }
  async pressKeys(shortcutValue, durationValue) {
    await this.ensurePage();
    const shortcut = typeof shortcutValue === "string" ? shortcutValue.trim() : "";
    if (!shortcut || shortcut.length > 100) throw new Error("组合键无效");
    const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length || parts.length > 5) throw new Error("组合键无效");
    const aliases = { cmd: "Meta", command: "Meta", meta: "Meta", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift" };
    let modifiers = 0;
    for (const part of parts.slice(0, -1)) {
      const modifier = aliases[part.toLocaleLowerCase()];
      if (!modifier) throw new Error(`不支持的组合键修饰符：${part}`);
      if (modifier === "Alt") modifiers |= 1;
      else if (modifier === "Control") modifiers |= 2;
      else if (modifier === "Meta") modifiers |= 4;
      else if (modifier === "Shift") modifiers |= 8;
    }
    const rawKey = parts.at(-1);
    const named = {
      enter: { key: "Enter", code: "Enter" },
      tab: { key: "Tab", code: "Tab" },
      escape: { key: "Escape", code: "Escape" },
      space: { key: " ", code: "Space" },
      backspace: { key: "Backspace", code: "Backspace" },
      delete: { key: "Delete", code: "Delete" },
      arrowup: { key: "ArrowUp", code: "ArrowUp" },
      arrowdown: { key: "ArrowDown", code: "ArrowDown" },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
      arrowright: { key: "ArrowRight", code: "ArrowRight" },
      home: { key: "Home", code: "Home" },
      end: { key: "End", code: "End" },
      pageup: { key: "PageUp", code: "PageUp" },
      pagedown: { key: "PageDown", code: "PageDown" }
    };
    const lower = rawKey.toLocaleLowerCase();
    const key = named[lower] ?? (/^[a-z]$/i.test(rawKey) ? { key: modifiers & 8 ? rawKey.toLocaleUpperCase() : rawKey.toLocaleLowerCase(), code: `Key${rawKey.toLocaleUpperCase()}` } : /^\d$/.test(rawKey) ? { key: rawKey, code: `Digit${rawKey}` } : void 0);
    if (!key) throw new Error(`不支持的组合键按键：${rawKey}`);
    const previous = await this.pageState();
    const text2 = !(modifiers & 7) && key.key.length === 1 ? key.key : void 0;
    await this.dispatchHeldKey({ type: "rawKeyDown", ...key, modifiers, ...text2 ? { text: text2 } : {} }, { type: "keyUp", ...key, modifiers }, durationValue);
    this.references.clear();
    await delay(80);
    return { ...await this.verifiedAction(previous, false), shortcut };
  }
  async handleDialog(acceptValue, promptTextValue) {
    if (typeof acceptValue !== "boolean") throw new Error("对话框处理方式无效");
    if (promptTextValue !== void 0 && (typeof promptTextValue !== "string" || promptTextValue.length > 4e3)) throw new Error("对话框输入内容无效");
    await this.ensurePage();
    if (!this.pendingDialog) throw new BrowserControlError("DIALOG_NOT_OPEN", "当前页面没有待处理的 JavaScript 对话框", true, "prism_wait_for_element");
    const previous = await this.pageState().catch(() => ({ url: "", title: "", readyState: "" }));
    const dialog2 = { type: this.pendingDialog.type, message: this.pendingDialog.message };
    await this.cdp.send("Page.handleJavaScriptDialog", {
      accept: acceptValue,
      ...promptTextValue !== void 0 ? { promptText: promptTextValue } : {}
    }, this.sessionId);
    this.pendingDialog = void 0;
    return { ...await this.verifiedAction(previous, false), dialog: dialog2, accepted: acceptValue };
  }
  async click(ref) {
    const operationStarted = performance.now();
    const reference = this.reference(ref);
    const validationStarted = performance.now();
    const previousState = await this.pageState().catch(() => null);
    const previousDom = await this.accessibilitySignature(reference.sessionId);
    const previousTargets = new Set((await this.listTargets()).map((target) => target.targetId));
    const control = await this.resolveControl(reference).catch(() => null);
    let validationMs = performance.now() - validationStarted;
    const dispatchStarted = performance.now();
    const delivery = await this.dispatchElementClick({ backendNodeId: reference.backendNodeId }, reference.sessionId);
    const cdpMs = performance.now() - dispatchStarted;
    this.references.clear();
    const waitStarted = performance.now();
    await delay(180);
    let controlResult;
    if (control) {
      try {
        const current = await this.inspectControl(control.objectId, reference.sessionId);
        const expectedToggle = control.kind === "checkbox" || control.kind === "switch" || control.kind === "radio" && !control.checked;
        if (!control.disabled && expectedToggle && current.checked === control.checked) {
          throw new Error(`点击已发送，但 ${control.kind} 的选中状态没有变化，请重新读取页面或使用 prism_set_checked`);
        }
        controlResult = {
          kind: control.kind,
          previous: control.checked,
          checked: current.checked,
          changed: current.checked !== control.checked
        };
      } finally {
        await this.releaseControl(control, reference.sessionId);
      }
    }
    let state = await this.pageStateAfterAction();
    let currentDom = await this.accessibilitySignature(reference.sessionId);
    let newTargets = (await this.listTargets()).filter((target) => !previousTargets.has(target.targetId));
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline && previousState && state.url === previousState.url && state.title === previousState.title && previousDom === currentDom && newTargets.length === 0) {
      await delay(100);
      state = await this.pageStateAfterAction();
      currentDom = await this.accessibilitySignature(reference.sessionId);
      newTargets = (await this.listTargets()).filter((target) => !previousTargets.has(target.targetId));
    }
    const waitMs = performance.now() - waitStarted;
    const domChanged = previousDom !== currentDom;
    const pageChanged = !previousState || state.url !== previousState.url || state.title !== previousState.title || domChanged || newTargets.length > 0;
    const stateChanged = pageChanged || Boolean(controlResult?.changed);
    const verificationTimedOut = !stateChanged;
    return {
      performed: true,
      ...state,
      pageChanged,
      domChanged,
      newSnapshotRequired: true,
      newTargets,
      ...delivery,
      stateChanged,
      verificationTimedOut,
      elapsedMs: performance.now() - operationStarted,
      timings: { cdpMs, waitMs, validationMs },
      ...controlResult ? { control: controlResult } : {}
    };
  }
  async setChecked(ref, checkedValue) {
    if (typeof checkedValue !== "boolean") throw new Error("选中状态必须是布尔值");
    const reference = this.reference(ref);
    const previousState = await this.pageState().catch(() => null);
    const previousTargets = new Set((await this.listTargets()).map((target) => target.targetId));
    const control = await this.resolveControl(reference);
    try {
      if (control.disabled) throw new Error("目标控件已禁用，不能修改选中状态");
      if (control.kind === "radio" && !checkedValue) throw new Error("单选按钮不能直接取消，请选择同组中的另一个单选按钮");
      if (control.checked !== checkedValue) {
        await this.dispatchElementClick({ objectId: control.clickObjectId }, reference.sessionId);
        await delay(120);
        let current2 = await this.inspectControl(control.objectId, reference.sessionId);
        if (current2.checked !== checkedValue) {
          await this.cdp.send("DOM.focus", { objectId: control.objectId }, reference.sessionId).catch(() => void 0);
          await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " " }, reference.sessionId);
          await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" }, reference.sessionId);
          await delay(120);
          current2 = await this.inspectControl(control.objectId, reference.sessionId);
        }
        if (current2.checked !== checkedValue) {
          throw new Error(`控件没有变为${checkedValue ? "选中" : "未选中"}状态；页面可能拦截了点击，请重新读取页面后重试`);
        }
      }
      const state = await this.pageStateAfterAction();
      const current = await this.inspectControl(control.objectId, reference.sessionId);
      const domChanged = current.checked !== control.checked;
      const result = {
        performed: true,
        ...state,
        pageChanged: !previousState || state.url !== previousState.url || state.title !== previousState.title || domChanged,
        domChanged,
        newSnapshotRequired: true,
        newTargets: await this.newTargetsSince(previousTargets, 250),
        previous: control.checked,
        checked: current.checked,
        changed: current.checked !== control.checked,
        kind: control.kind,
        control: { kind: control.kind, previous: control.checked, checked: current.checked, changed: current.checked !== control.checked }
      };
      this.references.clear();
      return result;
    } finally {
      await this.releaseControl(control, reference.sessionId);
    }
  }
  async setInputFiles(ref, pathValues) {
    const operationStarted = performance.now();
    const reference = this.reference(ref);
    const validated = await validateUploadFiles(pathValues);
    const resolved = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: reference.backendNodeId
    }, reference.sessionId);
    const sourceId = resolved.object?.objectId;
    if (!sourceId) throw new Error("无法解析上传控件");
    let inputId;
    try {
      const candidate = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: sourceId,
        functionDeclaration: `function () {
          const fileInput = (node) => node instanceof HTMLInputElement && node.type === 'file' ? node : null;
          let input = fileInput(this);
          if (!input && this instanceof HTMLLabelElement) input = fileInput(this.control) || this.querySelector('input[type="file"]');
          if (!input && this instanceof Element) input = this.querySelector('input[type="file"]');
          let parent = this instanceof Element ? this.parentElement : null;
          for (let depth = 0; !input && parent && depth < 4; depth += 1, parent = parent.parentElement) {
            input = parent.querySelector('input[type="file"]');
          }
          if (!input) {
            const candidates = document.querySelectorAll('input[type="file"]');
            if (candidates.length === 1) input = candidates[0];
          }
          return input;
        }`
      }, reference.sessionId);
      inputId = candidate.result?.objectId;
      if (!inputId || candidate.result?.subtype === "null") {
        throw new Error("该元素没有关联的文件上传控件；请重新读取页面并选择 file input 或其上传按钮/拖放区域");
      }
      const marker = `__prismUpload_${randomUUID().replaceAll("-", "")}`;
      const prepared = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: inputId,
        functionDeclaration: `function (marker) {
          if (!(this instanceof HTMLInputElement) || this.type !== 'file') throw new Error('not_file_input');
          const readFiles = () => Array.from(this.files || [], (file) => ({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }));
          const state = { input: 0, change: 0, inputFiles: [], changeFiles: [] };
          Object.defineProperty(this, marker, { value: state, configurable: true });
          this.addEventListener('input', () => { state.input += 1; state.inputFiles = readFiles(); }, { once: true });
          this.addEventListener('change', () => { state.change += 1; state.changeFiles = readFiles(); }, { once: true });
          return { multiple: this.multiple, accept: this.accept || '' };
        }`,
        arguments: [{ value: marker }],
        returnByValue: true
      }, reference.sessionId);
      if (validated.paths.length > 1 && !prepared.result?.value?.multiple) throw new Error("该上传控件不允许一次选择多个文件");
      const cdpStarted = performance.now();
      await this.cdp.send("DOM.setFileInputFiles", { files: validated.paths, objectId: inputId }, reference.sessionId);
      let cdpMs = performance.now() - cdpStarted;
      const waitStarted = performance.now();
      await delay(120);
      const waitMs = performance.now() - waitStarted;
      const validationStarted = performance.now();
      const checked = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: inputId,
        functionDeclaration: `function (marker) {
          const state = this[marker] || { input: 0, change: 0, inputFiles: [], changeFiles: [] };
          const files = Array.from(this.files || [], (file) => ({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }));
          try { delete this[marker]; } catch {}
          return { files, inputFiles: state.inputFiles || [], changeFiles: state.changeFiles || [], input: state.input, change: state.change };
        }`,
        arguments: [{ value: marker }],
        returnByValue: true
      }, reference.sessionId);
      cdpMs += performance.now() - validationStarted;
      const matches = (files) => files.length === validated.files.length && files.every((file, index) => file.name === validated.files[index].name && file.size === validated.files[index].size);
      const currentFiles = checked.result?.value?.files ?? [];
      const changeFiles = checked.result?.value?.changeFiles ?? [];
      const inputFiles = checked.result?.value?.inputFiles ?? [];
      const verificationSource = matches(currentFiles) ? "current-input" : matches(changeFiles) ? "change-event" : matches(inputFiles) ? "input-event" : void 0;
      const acceptedFiles = verificationSource === "current-input" ? currentFiles : verificationSource === "change-event" ? changeFiles : inputFiles;
      const verified = verificationSource !== void 0;
      if (!verified) throw new Error("浏览器没有接受完整的文件列表，上传状态验证失败");
      this.references.clear();
      const stateStarted = performance.now();
      const state = await this.pageStateAfterAction();
      const validationMs = performance.now() - stateStarted;
      return {
        ...state,
        files: validated.files,
        acceptedFiles,
        inputEvent: Number(checked.result?.value?.input) > 0,
        changeEvent: Number(checked.result?.value?.change) > 0,
        verified,
        verificationSource,
        consumedByPage: verificationSource !== "current-input",
        elapsedMs: performance.now() - operationStarted,
        timings: { cdpMs, waitMs, validationMs }
      };
    } finally {
      if (inputId) await this.cdp.send("Runtime.releaseObject", { objectId: inputId }, reference.sessionId).catch(() => void 0);
      await this.cdp.send("Runtime.releaseObject", { objectId: sourceId }, reference.sessionId).catch(() => void 0);
    }
  }
  async clickAndWaitForTarget(ref, filterInput) {
    const before = new Set((await this.listTargets()).map((target) => target.targetId));
    const click = await this.click(ref);
    const kind = filterInput.kind;
    if (kind !== void 0 && kind !== "web" && kind !== "extension") throw new Error("页面目标类型无效");
    const titleContains = boundedFilter(filterInput.titleContains, "页面标题条件");
    const urlContains = boundedFilter(filterInput.urlContains, "页面地址条件");
    const timeoutMs = filterInput.timeoutMs ?? 15e3;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 6e4) throw new Error("等待时间必须为 0–60000 毫秒");
    const deadline = Date.now() + timeoutMs;
    do {
      const match = (await this.listTargets()).filter((target) => !before.has(target.targetId)).reverse().find((target) => {
        if (kind && target.kind !== kind) return false;
        if (titleContains && !target.title.toLocaleLowerCase().includes(titleContains.toLocaleLowerCase())) return false;
        if (urlContains && !target.url.toLocaleLowerCase().includes(urlContains.toLocaleLowerCase())) return false;
        return true;
      });
      if (match) return { click, ...await this.selectTarget(match.targetId) };
      if (Date.now() >= deadline) break;
      await delay(Math.min(150, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error("点击已完成，但等待新的匹配网页或扩展窗口超时");
  }
  async type(ref, text2, clear = true) {
    if (typeof text2 !== "string" || text2.length > MAX_INPUT_TEXT) throw new Error(`输入文本不能超过 ${MAX_INPUT_TEXT} 个字符`);
    const reference = this.reference(ref);
    if (!EDITABLE_ROLES.has(reference.role)) throw new Error("目标元素不支持文本输入");
    await this.cdp.send("DOM.focus", { backendNodeId: reference.backendNodeId }, reference.sessionId);
    if (clear) {
      const resolved = await this.cdp.send("DOM.resolveNode", {
        backendNodeId: reference.backendNodeId
      }, reference.sessionId);
      if (resolved.object?.objectId) {
        await this.cdp.send("Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: `function () {
            if (typeof this.select === 'function') { try { this.select(); return; } catch {} }
            if (this instanceof HTMLElement && this.isContentEditable) {
              const range = document.createRange(); range.selectNodeContents(this);
              const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
            }
          }`
        }, reference.sessionId);
      }
    }
    if (text2) await this.cdp.send("Input.insertText", { text: text2 }, reference.sessionId);
    else if (clear) {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" }, reference.sessionId);
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" }, reference.sessionId);
    }
    this.references.clear();
    return this.pageStateAfterAction();
  }
  async release() {
    if (this.closed) return;
    this.closed = true;
    await this.settleActiveInput();
    this.frameAttachments.clear();
    this.removeEventListener();
    this.references.clear();
    this.childFrameSessions.clear();
    this.childFrameSessionReady.clear();
    const sessionId = this.sessionId;
    this.sessionId = void 0;
    this.targetId = void 0;
    if (!this.ownsTransport && sessionId) {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => void 0);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const finish = () => {
      this.frameAttachments.clear();
      this.removeEventListener();
      this.references.clear();
      this.childFrameSessions.clear();
      this.childFrameSessionReady.clear();
      this.sessionId = void 0;
      this.targetId = void 0;
      if (this.ownsTransport) this.cdp.close();
    };
    if (this.activeInput) void this.settleActiveInput().then(finish, finish);
    else finish();
  }
  async ensurePage() {
    if (this.targetId && this.sessionId) {
      try {
        await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
        return;
      } catch {
        this.targetId = void 0;
        this.sessionId = void 0;
      }
    }
    const targets = await this.cdp.send("Target.getTargets");
    const pages = (targets.targetInfos ?? []).filter((target2) => targetKind(target2) !== void 0);
    const target = pages[pages.length - 1] ?? await this.cdp.send("Target.createTarget", { url: "about:blank" });
    await this.attach(target.targetId);
  }
  async ensureActionPage(tabIndex, tabUrl) {
    if (!Number.isInteger(tabIndex) || Number(tabIndex) < 0) {
      await this.ensurePage();
      return;
    }
    const targets = await this.cdp.send("Target.getTargets");
    const pages = targets.targetInfos.filter((target2) => target2.type === "page" && !target2.url.startsWith("devtools:"));
    const index = Number(tabIndex);
    const mappedTargetId = this.syncTabTargets.get(index);
    let target = mappedTargetId ? pages.find((page) => page.targetId === mappedTargetId) : void 0;
    if (!target && tabUrl) {
      const alreadyMapped = new Set(this.syncTabTargets.values());
      target = pages.find((page) => page.url === tabUrl && !alreadyMapped.has(page.targetId)) ?? pages.find((page) => page.url === tabUrl);
    }
    target ??= pages[index];
    while (!target && pages.length <= Number(tabIndex)) {
      const created = await this.cdp.send("Target.createTarget", { url: "about:blank" });
      target = { targetId: created.targetId, type: "page", title: "", url: "about:blank" };
      pages.push(target);
    }
    if (!target) throw new Error("受控窗口没有可同步的网页标签");
    this.syncTabTargets.set(index, target.targetId);
    if (target.targetId !== this.targetId || !this.sessionId) await this.attach(target.targetId);
  }
  async attach(targetId) {
    const previousSessionId = this.sessionId;
    this.childFrameSessions.clear();
    this.childFrameSessionReady.clear();
    this.frameAttachments.clear();
    const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.targetId = targetId;
    this.sessionId = attached.sessionId;
    this.documentGeneration += 1;
    this.references.clear();
    if (!this.ownsTransport && previousSessionId && previousSessionId !== attached.sessionId) {
      await this.cdp.send("Target.detachFromTarget", { sessionId: previousSessionId }).catch(() => void 0);
    }
    await Promise.all([
      this.cdp.send("Page.enable", {}, attached.sessionId),
      this.cdp.send("DOM.enable", {}, attached.sessionId),
      this.cdp.send("Accessibility.enable", {}, attached.sessionId),
      this.cdp.send("Network.enable", { maxTotalBufferSize: 5 * 1024 * 1024, maxResourceBufferSize: MAX_NETWORK_BODY_BYTES }, attached.sessionId)
    ]);
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }, attached.sessionId);
    await this.waitForChildFrameSessions();
  }
  reference(ref) {
    if (typeof ref !== "string" || !/^ref_[a-f\d]{32}$/i.test(ref)) {
      throw new BrowserControlError("INVALID_ELEMENT_REF", "页面元素引用无效", false, "prism_read_page");
    }
    const reference = this.references.get(ref);
    if (!reference || reference.targetId !== this.targetId || reference.sessionId !== this.sessionId && !this.childFrameSessions.has(reference.sessionId) || reference.documentGeneration !== this.documentGeneration || reference.snapshotVersion !== this.snapshotVersion) {
      throw new BrowserControlError("STALE_ELEMENT_REF", "页面元素引用已失效，请重新读取页面", true, "prism_read_page");
    }
    return reference;
  }
  captureNetworkEvent(event) {
    if (!event.method.startsWith("Network.")) return;
    this.lastNetworkActivityAt = Date.now();
    const cdpRequestId = String(event.params.requestId ?? "");
    if (event.method === "Network.requestWillBeSent" && cdpRequestId) {
      const request2 = event.params.request;
      const id2 = `net_${randomUUID().replaceAll("-", "")}`;
      const record2 = {
        id: id2,
        cdpRequestId,
        sessionId: event.sessionId,
        url: redactNetworkUrl(String(request2?.url ?? "")),
        method: boundedText(request2?.method, 20) || "GET",
        resourceType: boundedText(event.params.type, 80) || "Other",
        requestHeaders: redactNetworkHeaders(request2?.headers),
        startedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.networkRecords.set(id2, record2);
      this.networkRequestIds.set(cdpRequestId, id2);
      this.inflightNetwork.add(cdpRequestId);
      if (this.harStartedAt) this.harRecordIds.push(id2);
      while (this.networkRecords.size > MAX_NETWORK_RECORDS) {
        const oldest = this.networkRecords.keys().next().value;
        const removed = this.networkRecords.get(oldest);
        this.networkRecords.delete(oldest);
        if (removed && this.networkRequestIds.get(removed.cdpRequestId) === oldest) this.networkRequestIds.delete(removed.cdpRequestId);
      }
      if (this.harRecordIds.length > MAX_HAR_RECORDS) this.harRecordIds.shift();
      return;
    }
    const id = this.networkRequestIds.get(cdpRequestId);
    const record = id ? this.networkRecords.get(id) : void 0;
    if (event.method === "Network.responseReceived" && record) {
      const response = event.params.response;
      record.status = Number(response?.status ?? 0);
      record.statusText = boundedText(response?.statusText, 200);
      record.mimeType = boundedText(response?.mimeType, 200);
      record.responseHeaders = redactNetworkHeaders(response?.headers);
    } else if (event.method === "Network.loadingFinished") {
      this.inflightNetwork.delete(cdpRequestId);
      if (record) {
        record.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
        record.encodedDataLength = Math.max(0, Number(event.params.encodedDataLength ?? 0));
      }
    } else if (event.method === "Network.loadingFailed") {
      this.inflightNetwork.delete(cdpRequestId);
      if (record) {
        record.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
        record.failed = true;
        record.errorText = boundedText(event.params.errorText, 500);
      }
    }
  }
  publicNetworkRecord(record) {
    const { cdpRequestId: _cdpRequestId, sessionId: _sessionId, ...safe } = record;
    return { ...safe, requestHeaders: { ...safe.requestHeaders }, responseHeaders: safe.responseHeaders ? { ...safe.responseHeaders } : void 0 };
  }
  readLimit(value, fallback) {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < 1 || result > 2e5) throw new Error("页面读取字符数必须为 1–200000");
    return result;
  }
  async evaluatePageReader(mode, options) {
    await this.ensurePage();
    const expression = `(${PAGE_READER_FUNCTION})(${JSON.stringify(mode)}, ${JSON.stringify(options)})`;
    const result = await this.cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, this.sessionId);
    if (result.exceptionDetails) throw new Error(`页面内容读取失败：${result.exceptionDetails.text ?? "页面脚本异常"}`);
    return result.result?.value;
  }
  async evaluateDocumentReaders(mode, options) {
    const sessions = await this.documentSessions();
    const expression = `(${PAGE_READER_FUNCTION})(${JSON.stringify(mode)}, ${JSON.stringify(options)})`;
    const values = await Promise.all(sessions.map(async (sessionId) => {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId).catch(() => void 0);
      return result?.exceptionDetails ? void 0 : result?.result?.value;
    }));
    return values.filter((value) => value !== void 0);
  }
  async enableChildFrameSession(sessionId) {
    try {
      await Promise.all([
        this.cdp.send("DOM.enable", {}, sessionId),
        this.cdp.send("Accessibility.enable", {}, sessionId),
        this.cdp.send("Runtime.enable", {}, sessionId)
      ]);
      await this.cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      }, sessionId);
    } catch (error) {
      this.childFrameSessions.delete(sessionId);
      throw error;
    }
  }
  async waitForChildFrameSessions() {
    await delay(20);
    await Promise.allSettled([...this.childFrameSessionReady.values()]);
  }
  async documentSessions() {
    await this.ensurePage();
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }, this.sessionId);
    await this.waitForChildFrameSessions();
    return [this.sessionId, ...this.childFrameSessions];
  }
  async readReferencedElement(ref, mode, options) {
    const reference = this.reference(ref);
    const resolved = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: reference.backendNodeId
    }, reference.sessionId);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("无法解析页面元素");
    try {
      const result = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: ELEMENT_READER_FUNCTION,
        arguments: [{ value: mode }, { value: options }],
        returnByValue: true
      }, reference.sessionId);
      if (result.exceptionDetails) throw new Error(`页面元素读取失败：${result.exceptionDetails.text ?? "页面脚本异常"}`);
      return result.result?.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, reference.sessionId).catch(() => void 0);
    }
  }
  snapshotPage(cursorValue, pageSize) {
    if (typeof cursorValue !== "string" || !/^cursor_[a-f\d]{32}$/i.test(cursorValue)) {
      throw new BrowserControlError("INVALID_SNAPSHOT_CURSOR", "页面快照游标无效", false, "prism_read_page");
    }
    const cursor = this.snapshotCursors.get(cursorValue);
    const snapshot = cursor ? this.snapshots.get(cursor.snapshotId) : void 0;
    const firstRef = cursor?.entries.find((entry) => typeof entry.element.ref === "string")?.element.ref;
    if (!cursor || !snapshot || cursor.targetId !== this.targetId || cursor.sessionId !== this.sessionId || cursor.documentGeneration !== this.documentGeneration || cursor.version !== this.snapshotVersion || typeof firstRef === "string" && !this.references.has(firstRef)) {
      throw new BrowserControlError("STALE_SNAPSHOT_CURSOR", "页面快照游标已失效，请重新读取页面", true, "prism_read_page");
    }
    this.snapshotCursors.delete(cursorValue);
    return this.makeSnapshotPage(snapshot, cursor.entries, cursor.removedRefs, cursor.delta, cursor.offset, pageSize);
  }
  makeSnapshotPage(snapshot, entries, removedRefs, delta, offset, pageSize, operation = {
    elapsedMs: 0,
    timings: { cdpMs: 0, waitMs: 0, validationMs: 0 }
  }) {
    const end = Math.min(entries.length, offset + pageSize);
    let cursor;
    if (end < entries.length) {
      cursor = `cursor_${randomUUID().replaceAll("-", "")}`;
      this.snapshotCursors.set(cursor, {
        snapshotId: snapshot.id,
        targetId: snapshot.targetId,
        sessionId: snapshot.sessionId,
        documentGeneration: snapshot.documentGeneration,
        version: snapshot.version,
        offset: end,
        entries,
        removedRefs,
        delta
      });
    }
    return {
      schemaVersion: 2,
      ...snapshot.state,
      snapshotId: snapshot.id,
      documentGeneration: snapshot.documentGeneration,
      offset,
      totalElements: entries.length,
      elements: entries.slice(offset, end).map((entry) => entry.element),
      removedRefs: offset === 0 ? removedRefs : [],
      delta,
      truncated: snapshot.truncated,
      compact: snapshot.compact,
      ...operation,
      ...cursor ? { cursor } : {}
    };
  }
  async inspectElement(backendNodeId, sessionId) {
    let objectId;
    try {
      const resolved = await this.cdp.send("DOM.resolveNode", { backendNodeId }, sessionId);
      objectId = resolved.object?.objectId;
      if (!objectId) return void 0;
      const result = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          let value;
          if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement) value = this.value;
          else if (this instanceof HTMLElement && this.isContentEditable) value = this.innerText;
          let frameDepth = 0;
          let view = this.ownerDocument?.defaultView;
          while (view && view !== view.parent) { frameDepth += 1; try { view = view.parent; } catch { break; } }
          let shadowDepth = 0;
          let root = this.getRootNode?.();
          while (root instanceof ShadowRoot) { shadowDepth += 1; root = root.host.getRootNode(); }
          let crossOrigin;
          if (['IFRAME', 'FRAME'].includes(this.tagName)) {
            try { crossOrigin = this.contentWindow.location.origin !== this.ownerDocument.location.origin; }
            catch { crossOrigin = true; }
          }
          return {
            crossOrigin,
            value: typeof value === 'string' ? value.slice(0, ${MAX_INPUT_TEXT}) : undefined,
            tagName: this.tagName ? this.tagName.toLowerCase() : undefined,
            type: typeof this.type === 'string' ? this.type.slice(0, 80) : undefined,
            placeholder: typeof this.placeholder === 'string' ? this.placeholder.slice(0, 500) : undefined,
            href: typeof this.href === 'string' ? this.href.slice(0, 2048) : undefined,
            frameDepth, shadowDepth
          };
        }`,
        returnByValue: true
      }, sessionId);
      const value = result.result?.value;
      if (!value || typeof value !== "object") return void 0;
      return value;
    } catch {
      return void 0;
    } finally {
      if (objectId) await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => void 0);
    }
  }
  async dispatchElementClick(node, sessionId) {
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", node, sessionId);
    await this.cdp.send("DOM.focus", node, sessionId).catch(() => void 0);
    await delay(16);
    const { model } = await this.cdp.send(
      "DOM.getBoxModel",
      node,
      sessionId
    );
    const quad = model.content ?? model.border;
    if (!quad || quad.length !== 8) throw new Error("目标元素当前不可点击");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    let objectId = "objectId" in node ? node.objectId : void 0;
    let releaseObject = false;
    if (!objectId) {
      const resolved = await this.cdp.send("DOM.resolveNode", node, sessionId);
      objectId = resolved.object?.objectId;
      releaseObject = Boolean(objectId);
    }
    const marker = `__prismClick_${randomUUID().replaceAll("-", "")}`;
    if (objectId) {
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (marker, x, y) {
          const state = { pointerdown: 0, mousedown: 0, mouseup: 0, click: 0, trusted: false, hit: false };
          const hit = this.ownerDocument && this.ownerDocument.elementFromPoint(x, y);
          state.hit = Boolean(hit && (hit === this || this.contains?.(hit) || hit.contains?.(this)));
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            this.addEventListener(type, (event) => { state[type] += 1; state.trusted ||= event.isTrusted === true; }, { capture: true, once: true });
          }
          Object.defineProperty(this, marker, { value: state, configurable: true });
          return { hit: state.hit };
        }`,
        arguments: [{ value: marker }, { value: x }, { value: y }],
        returnByValue: true
      }, sessionId).catch(() => void 0);
    }
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      pointerType: "mouse"
    }, sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse"
    }, sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse"
    }, sessionId);
    await delay(40);
    let elementReceivedClick = false;
    let trustedEventReceived = false;
    if (objectId) {
      const receipt = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (marker) {
          const state = this[marker];
          try { delete this[marker]; } catch {}
          return state ? { click: state.click || 0, trusted: state.trusted === true } : { click: 0, trusted: false };
        }`,
        arguments: [{ value: marker }],
        returnByValue: true
      }, sessionId).catch(() => void 0);
      elementReceivedClick = Number(receipt?.result?.value?.click) > 0;
      trustedEventReceived = receipt?.result?.value?.trusted === true;
      if (releaseObject) await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => void 0);
    }
    return { eventSent: true, elementReceivedClick, trustedEventReceived };
  }
  async accessibilitySignature(sessionId) {
    try {
      const tree = await this.cdp.send("Accessibility.getFullAXTree", {}, sessionId);
      return JSON.stringify((tree.nodes ?? []).slice(0, MAX_SNAPSHOT_NODES).flatMap((node) => {
        if (node.ignored) return [];
        const properties = Object.fromEntries((node.properties ?? []).filter((property) => ["checked", "disabled", "expanded", "selected"].includes(property.name)).map((property) => [property.name, property.value?.value]));
        return [[node.role?.value, node.name?.value, node.value?.value, properties]];
      }));
    } catch {
      return `unavailable:${this.documentGeneration}`;
    }
  }
  async resolveControl(reference) {
    const resolved = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: reference.backendNodeId
    }, reference.sessionId);
    const sourceId = resolved.object?.objectId;
    if (!sourceId) throw new Error("无法解析页面控件");
    try {
      const candidate = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: sourceId,
        functionDeclaration: `function () {
          const roleControl = (node) => node instanceof Element && ['checkbox','radio','switch'].includes((node.getAttribute('role') || '').toLowerCase()) ? node : null;
          const nativeControl = (node) => node instanceof HTMLInputElement && ['checkbox','radio'].includes(node.type) ? node : null;
          let control = nativeControl(this) || roleControl(this);
          if (!control && this instanceof HTMLLabelElement) control = nativeControl(this.control) || roleControl(this.control);
          if (!control && this instanceof Element) control = this.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],[role="switch"]');
          return control;
        }`
      }, reference.sessionId);
      const objectId = candidate.result?.objectId;
      if (!objectId || candidate.result?.subtype === "null") throw new Error("目标元素不是 checkbox、radio 或 switch，也没有关联的可选控件");
      const state = await this.inspectControl(objectId, reference.sessionId);
      const clickCandidate = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const rect = this.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return this;
          if (this instanceof HTMLInputElement && this.labels && this.labels.length) return this.labels[0];
          return this.closest('label') || this;
        }`
      }, reference.sessionId);
      const clickObjectId = clickCandidate.result?.objectId;
      if (!clickObjectId || clickCandidate.result?.subtype === "null") {
        await this.cdp.send("Runtime.releaseObject", { objectId }, reference.sessionId).catch(() => void 0);
        throw new Error("目标控件当前没有可点击区域");
      }
      return { objectId, clickObjectId, ...state };
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: sourceId }, reference.sessionId).catch(() => void 0);
    }
  }
  async inspectControl(objectId, sessionId) {
    const result = await this.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const native = this instanceof HTMLInputElement && ['checkbox','radio'].includes(this.type);
        const role = (this.getAttribute && this.getAttribute('role') || '').toLowerCase();
        const kind = native ? this.type : role;
        if (!['checkbox','radio','switch'].includes(kind)) throw new Error('not_checkable');
        const checked = native ? this.checked : (this.getAttribute('aria-checked') || '').toLowerCase() === 'true';
        const disabled = native ? this.disabled : this.hasAttribute('disabled') || (this.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        return { kind, checked: Boolean(checked), disabled: Boolean(disabled) };
      }`,
      returnByValue: true
    }, sessionId);
    const value = result.result?.value;
    if (result.exceptionDetails || !value || !["checkbox", "radio", "switch"].includes(String(value.kind))) {
      throw new Error("无法读取控件的选中状态");
    }
    return {
      kind: value.kind,
      checked: Boolean(value.checked),
      disabled: Boolean(value.disabled)
    };
  }
  async releaseControl(control, sessionId) {
    if (control.clickObjectId !== control.objectId) {
      await this.cdp.send("Runtime.releaseObject", { objectId: control.clickObjectId }, sessionId).catch(() => void 0);
    }
    await this.cdp.send("Runtime.releaseObject", { objectId: control.objectId }, sessionId).catch(() => void 0);
  }
  async newTargetsSince(previous, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs);
    let added = [];
    do {
      added = (await this.listTargets()).filter((target) => !previous.has(target.targetId));
      if (added.length || Date.now() >= deadline) return added;
      await delay(Math.min(75, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return added;
  }
  async pageState() {
    await this.ensurePage();
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: "({url: location.href, title: document.title, readyState: document.readyState})",
      returnByValue: true
    }, this.sessionId);
    if (result.exceptionDetails) throw new Error("无法读取当前页面状态");
    return {
      url: boundedText(result.result?.value?.url, 2048),
      title: boundedText(result.result?.value?.title, 500),
      readyState: boundedText(result.result?.value?.readyState, 40) || "unknown"
    };
  }
  async pageStateAfterAction() {
    try {
      return await this.pageState();
    } catch {
      this.targetId = void 0;
      this.sessionId = void 0;
      this.references.clear();
      await this.ensurePage();
      return this.pageState();
    }
  }
  waitTimeout(value, fallback) {
    const timeout = value ?? fallback;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 12e4) throw new Error("等待时间必须为 0–120000 毫秒");
    return timeout;
  }
  async verifiedAction(previous, forceChanged = false) {
    const state = await this.pageStateAfterAction();
    const urlChanged = state.url !== previous.url;
    const pageChanged = forceChanged || urlChanged || state.title !== previous.title || state.readyState !== previous.readyState;
    return { performed: true, pageChanged, urlChanged, newSnapshotRequired: pageChanged || forceChanged, ...state };
  }
  async viewportSize() {
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: "({width: innerWidth, height: innerHeight})",
      returnByValue: true
    }, this.sessionId);
    return {
      width: Math.max(1, Number(result.result?.value?.width) || 1),
      height: Math.max(1, Number(result.result?.value?.height) || 1)
    };
  }
  async waitForDocument() {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const state = await this.pageState().catch(() => null);
      if (state?.readyState === "complete" && state.url && state.url !== "about:blank") return;
      await delay(100);
    }
    throw new Error("等待网页加载完成超时");
  }
  async waitForDocumentGeneration(previousGeneration) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (this.documentGeneration > previousGeneration) return;
      await delay(100);
    }
    throw new BrowserControlError("NAVIGATION_TIMEOUT", "等待页面导航提交超时", true, "prism_wait_for_url");
  }
}
export function validWindowSyncAction(value) {
  if (!value || typeof value !== "object") return false;
  if (value.tabIndex !== void 0 && (!Number.isInteger(value.tabIndex) || value.tabIndex < 0 || value.tabIndex > 1e3)) return false;
  if (value.tabUrl !== void 0 && (typeof value.tabUrl !== "string" || value.tabUrl.length > 2048)) return false;
  if (value.kind === "click") return Number.isFinite(value.xRatio) && value.xRatio >= 0 && value.xRatio <= 1 && Number.isFinite(value.yRatio) && value.yRatio >= 0 && value.yRatio <= 1 && (value.selector === void 0 || typeof value.selector === "string" && value.selector.length <= 2e3) && ["left", "middle", "right"].includes(value.button) && Number.isInteger(value.clickCount);
  if (value.kind === "scroll") return Number.isFinite(value.xRatio) && value.xRatio >= 0 && value.xRatio <= 1 && Number.isFinite(value.yRatio) && value.yRatio >= 0 && value.yRatio <= 1 && (value.selector === void 0 || typeof value.selector === "string" && value.selector.length <= 2e3);
  if (value.kind === "key") return typeof value.key === "string" && value.key.length <= 40 && typeof value.code === "string" && value.code.length <= 40 && Number.isInteger(value.modifiers);
  if (value.kind === "navigate") {
    try {
      return validateWebUrl(value.url).length > 0;
    } catch {
      return false;
    }
  }
  if (value.kind === "openTab") {
    if (value.url === "about:blank") return true;
    try {
      return validateWebUrl(value.url).length > 0;
    } catch {
      return false;
    }
  }
  if (value.kind === "activateTab") return true;
  if (value.kind === "closeTab") return true;
  return value.kind === "input" && typeof value.selector === "string" && value.selector.length <= 2e3 && typeof value.value === "string" && value.value.length <= 16e3;
}
