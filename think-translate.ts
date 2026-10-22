// think-translate — 自动翻译助手 thinking 块(纯展示层,不改会话内容/历史)。
//
// 原理: 托管一个 headless Google Chrome, 用其内置 Translator / LanguageDetector
// API (on-device, 免费, 无 API key, 内容不出本机) 翻译 thinking 文本,
// 译文以 dim 样式渲染在 thinking 块下方。已是目标语言的块自动跳过。
//
// Chrome 通过 --remote-debugging-pipe (fd3 读/fd4 写, '\0' 分隔 JSON) 驱动,
// 不占用调试端口。Translator API 只暴露在安全上下文中, 因此扩展在 127.0.0.1
// 上内嵌一个极简 HTTP 服务作为宿主页面。首次使用需下载语言包, Chrome 要求
// 一次 user gesture, 用 CDP 派发可信点击满足。
//
// 前置: Google Chrome >= 138 (chromium 发行版构建不带内置 AI 模型)。
//
// 配置(环境变量):
//   THINK_TRANSLATE_TARGET  目标语言 BCP-47, 默认 "zh"
//   THINK_TRANSLATE_CHROME  Chrome 可执行文件路径 (默认自动探测)
//
// 命令: /think-translate           显示后端状态
//       /think-translate restart   重启 Chrome 后端

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Container, Text } from "@oh-my-pi/pi-tui";
import type { Component, Theme } from "@oh-my-pi/pi-tui";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const TARGET_LANG = (process.env.THINK_TRANSLATE_TARGET ?? "zh").trim() || "zh";
const CHROME_OVERRIDE = process.env.THINK_TRANSLATE_CHROME?.trim();
const CACHE_MAX = 500;
const EVAL_TIMEOUT_MS = 300_000; // 翻译可触发语言包下载
const STARTUP_TIMEOUT_MS = 20_000;
const CHROME_STARTUP_GRACE_MS = 180_000; // 首次语言包下载宽限

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const PROFILE_DIR = join(AGENT_DIR, "think-translate", "chrome-profile");

// CJK 表意文字快速判定: 命中则说明无需翻译(目标语言为中文时)
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

function cjkRatio(text: string): number {
  let cjk = 0;
  let letters = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    letters++;
    if (CJK_RE.test(ch)) cjk++;
  }
  return letters === 0 ? 0 : cjk / letters;
}

function findChrome(): string | null {
  if (CHROME_OVERRIDE) return existsSync(CHROME_OVERRIDE) ? CHROME_OVERRIDE : null;
  for (const name of ["google-chrome", "google-chrome-stable"]) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 清理使用本扩展 profile 的残留 chrome 进程与单例锁 (上次异常退出的遗留)。 */
function cleanupStaleChrome(): void {
  try {
    spawnSync("pkill", ["-9", "-f", `user-data-dir=${PROFILE_DIR}`], { stdio: "ignore" });
  } catch {
    /* pkill 不存在或无残留, 忽略 */
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(PROFILE_DIR, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome pipe CDP 客户端
// ---------------------------------------------------------------------------

interface CdpError {
  message: string;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
}

interface CdpResultEnvelope {
  result?: {
    targetInfos?: CdpTargetInfo[];
    sessionId?: string;
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: CdpError;
}

interface CdpResponse {
  id: number;
  envelope: CdpResultEnvelope;
}

class CdpPipe {
  #proc: ChildProcess;
  #pipeIn: NodeJS.WritableStream;
  #buf = "";
  #nextId = 0;
  #pending = new Map<number, (msg: CdpResponse) => void>();
  #sessionId: string | null = null;
  #closed = false;

  private constructor(proc: ChildProcess) {
    this.#proc = proc;
    this.#pipeIn = proc.stdio[3] as NodeJS.WritableStream;
    (proc.stdio[4] as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
      this.#buf += chunk.toString("utf8");
      let i: number;
      while ((i = this.#buf.indexOf("\0")) >= 0) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        if (!line.trim()) continue;
        let parsed: { id?: number } & CdpResultEnvelope;
        try {
          parsed = JSON.parse(line) as { id?: number } & CdpResultEnvelope;
        } catch {
          continue;
        }
        if (parsed.id === undefined) continue;
        const resolve = this.#pending.get(parsed.id);
        if (resolve) {
          this.#pending.delete(parsed.id);
          resolve({ id: parsed.id, envelope: parsed });
        }
      }
    });
    proc.on("exit", () => {
      this.#closed = true;
      const envelope: CdpResultEnvelope = { error: { message: "chrome exited" } };
      for (const resolve of this.#pending.values()) resolve({ id: -1, envelope });
      this.#pending.clear();
    });
  }

  get pid(): number {
    return this.#proc.pid ?? 0;
  }

  static async launch(chromePath: string, url: string): Promise<CdpPipe> {
    mkdirSync(PROFILE_DIR, { recursive: true });
    cleanupStaleChrome();
    const proc = spawn(
      chromePath,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--remote-debugging-pipe",
        `--user-data-dir=${PROFILE_DIR}`,
        url,
      ],
      // detached: 独立进程组; chrome 主进程可能由子进程接管, 杀整组才能清干净。
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true },
    );
    const client = new CdpPipe(proc);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let sessionId: string | null = null;
    while (Date.now() < deadline) {
      const targets = await client.#request("Target.getTargets", undefined, 3_000);
      const page = targets.result?.targetInfos?.find((t) => t.type === "page");
      if (page) {
        const attached = await client.#request(
          "Target.attachToTarget",
          { targetId: page.targetId, flatten: true },
          3_000,
        );
        sessionId = attached.result?.sessionId ?? null;
        if (sessionId) break;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    }
    if (!sessionId) {
      proc.kill("SIGKILL");
      throw new Error("chrome pipe CDP attach timeout");
    }
    client.#sessionId = sessionId;
    return client;
  }

  #request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<CdpResultEnvelope> {
    if (this.#closed) return Promise.resolve({ error: { message: "cdp closed" } });
    const id = ++this.#nextId;
    const { promise, resolve } = Promise.withResolvers<CdpResultEnvelope>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      resolve({ error: { message: `cdp timeout: ${method}` } });
    }, timeoutMs);
    this.#pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg.envelope);
    });
    const msg: Record<string, unknown> = { id, method, params };
    if (this.#sessionId) msg.sessionId = this.#sessionId;
    this.#pipeIn.write(JSON.stringify(msg) + "\0");
    return promise;
  }

  async evaluate<T>(expression: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<T> {
    // userGesture: 模型未下载时 Chrome 要求 user activation 才允许 create();
    // CDP 点击授予的 activation 可能因时机过早失效, 该标记提供可靠兜底。
    const envelope = await this.#request(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (envelope.error) throw new Error(envelope.error.message);
    const exc = envelope.result?.exceptionDetails;
    if (exc) {
      throw new Error(String(exc.exception?.description ?? exc.text ?? "evaluate exception"));
    }
    return envelope.result?.result?.value as T;
  }

  async click(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.#request("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, 30_000);
    }
  }

  kill(): void {
    this.#closed = true;
    try {
      // 负 pid 杀整个进程组 (含 chrome zygote/子进程), 避免孤儿占 profile 锁。
      process.kill(-this.#proc.pid!, "SIGKILL");
    } catch {
      try {
        this.#proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    try {
      this.#pipeIn.end();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 翻译服务 (module 级单例, 父子会话共享)
// ---------------------------------------------------------------------------

interface TranslateResult {
  kind: "translated" | "skip";
  text?: string;
  source?: string;
}

interface DetectorOutcome {
  ok: boolean;
  language?: string;
  confidence?: number;
  error?: string;
}

interface TranslatorOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

class TranslateService {
  #chrome: CdpPipe | null = null;
  #server: Server | null = null;
  #starting: Promise<boolean> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #cache = new Map<string, TranslateResult>();
  #inflight = new Map<string, Promise<TranslateResult>>();
  #views = new Map<string, Set<TranslateView>>();
  #refs = 0;
  #lastError: string | null = null;
  #chromePid = 0;
  #ready = false;

  acquire(): void {
    this.#refs++;
  }

  release(): void {
    this.#refs = Math.max(0, this.#refs - 1);
    if (this.#refs === 0) this.shutdown();
  }

  status(): string {
    if (this.#ready && this.#chrome) {
      return `think-translate: Chrome (pid ${this.#chromePid}) 就绪, 缓存 ${this.#cache.size} 条, 目标语言 ${TARGET_LANG}`;
    }
    return `think-translate: 后端未就绪${this.#lastError ? ` (上次错误: ${this.#lastError})` : ""}, 缓存 ${this.#cache.size} 条`;
  }

  /** 同步查缓存; 未命中返回 null。 */
  peek(key: string): TranslateResult | null {
    return this.#cache.get(key) ?? null;
  }

  /** 幂等启动; 返回是否就绪。永不 reject。 */
  start(): Promise<boolean> {
    this.#starting ??= this.#doStart().catch((err: unknown) => {
      this.#lastError = err instanceof Error ? err.message : String(err);
      return false;
    });
    return this.#starting;
  }

  async #doStart(): Promise<boolean> {
    const chromePath = findChrome();
    if (!chromePath) {
      this.#lastError = "未找到 Google Chrome (需要 >= 138, 可设 THINK_TRANSLATE_CHROME)";
      return false;
    }

    // 内嵌宿主页面 (Translator API 只在安全上下文暴露)
    this.#server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>think-translate</title><body>");
    });
    const port = await new Promise<number>((resolve, reject) => {
      const server = this.#server;
      if (!server) {
        reject(new Error("server missing"));
        return;
      }
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no server address"));
        }
      });
    });

    this.#chrome = await CdpPipe.launch(chromePath, `http://127.0.0.1:${port}/`);
    this.#chromePid = this.#chrome.pid;
    await this.waitPageReady();

    // 授予 user activation (模型未下载时 create() 要求手势)
    await this.#chrome.click(20, 20);
    await this.#chrome.evaluate<void>("window.__tt = { translators: {}, detector: null }");

    // 预创建检测器 (模型小, 秒级)
    const det = await this.#chrome.evaluate<DetectorOutcome>(
      `(async () => {
        const avail = await LanguageDetector.availability();
        if (avail !== "available" && avail !== "downloadable") return { ok: false, error: "LanguageDetector availability: " + avail };
        if (!window.__tt.detector) window.__tt.detector = await LanguageDetector.create();
        return { ok: true };
      })()`,
    );
    if (!det.ok) this.#lastError = `LanguageDetector: ${det.error}`;

    // 预热 en→target 翻译器 (触发语言包下载, 之后翻译即时)
    const warm = await this.#chrome.evaluate<TranslatorOutcome>(
      `(async () => {
        const opts = { sourceLanguage: "en", targetLanguage: ${JSON.stringify(TARGET_LANG)} };
        const t0 = Date.now();
        let avail = await Translator.availability(opts);
        while (avail === "downloading" && Date.now() - t0 < ${CHROME_STARTUP_GRACE_MS}) {
          await new Promise((r) => setTimeout(r, 2000));
          avail = await Translator.availability(opts);
        }
        if (avail !== "available" && avail !== "downloadable") return { ok: false, error: "Translator availability: " + avail };
        const key = "en->" + ${JSON.stringify(TARGET_LANG)};
        if (!window.__tt.translators[key]) window.__tt.translators[key] = await Translator.create(opts);
        return { ok: true };
      })()`,
    );
    if (!warm.ok) {
      this.#lastError = `Translator: ${warm.error}`;
      return false;
    }
    this.#ready = true;
    return true;
  }

  private async waitPageReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const href = await this.#chrome!.evaluate<string>("location.href", 5_000);
        if (href.startsWith("http://127.0.0.1:")) return;
      } catch {
        /* chrome 尚未就绪 */
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    }
    throw new Error("chrome page load timeout");
  }

  /** 异步翻译; 永不 reject。 */
  translate(text: string): Promise<TranslateResult> {
    const key = createHash("sha1").update(text).digest("hex");
    const cached = this.#cache.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = this.#inflight.get(key);
    if (!pending) {
      const result = this.#enqueue(() => this.#doTranslate(text)).catch(
        (err: unknown): TranslateResult => {
          this.#lastError = err instanceof Error ? err.message : String(err);
          return { kind: "skip" };
        },
      );
      pending = result.then((r) => {
        if (this.#cache.size >= CACHE_MAX) {
          const oldest = this.#cache.keys().next().value;
          if (oldest !== undefined) this.#cache.delete(oldest);
        }
        this.#cache.set(key, r);
        this.#notifyViews(key, r);
        return r;
      });
      void pending.finally(() => {
        this.#inflight.delete(key);
      });
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  /** 串行化页面内调用, 避免共享 detector/translator 实例竞争。 */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #doTranslate(text: string): Promise<TranslateResult> {
    if (!(await this.start())) return { kind: "skip" };
    // 快速路径: 中文占比高 → 无需翻译
    if (cjkRatio(text) >= 0.3) return { kind: "skip" };

    const detect = await this.#chrome!.evaluate<DetectorOutcome>(
      `(async () => {
        if (!window.__tt?.detector) return { ok: false, error: "detector missing" };
        const results = await window.__tt.detector.detect(${JSON.stringify(text.slice(0, 1000))});
        const top = results?.[0];
        return { ok: true, language: top?.detectedLanguage ?? "und", confidence: top?.confidence ?? 0 };
      })()`,
    );
    const source = detect.ok && (detect.confidence ?? 0) > 0.5 ? (detect.language ?? "en") : "en";
    if (source === TARGET_LANG || source === "und") return { kind: "skip" };

    const translated = await this.#chrome!.evaluate<TranslatorOutcome>(
      `(async () => {
        const opts = { sourceLanguage: ${JSON.stringify(source)}, targetLanguage: ${JSON.stringify(TARGET_LANG)} };
        const t0 = Date.now();
        let avail = await Translator.availability(opts);
        while (avail === "downloading" && Date.now() - t0 < ${CHROME_STARTUP_GRACE_MS}) {
          await new Promise((r) => setTimeout(r, 2000));
          avail = await Translator.availability(opts);
        }
        if (avail !== "available" && avail !== "downloadable") return { ok: false, error: "Translator availability: " + avail };
        const pairKey = opts.sourceLanguage + "->" + opts.targetLanguage;
        if (!window.__tt.translators[pairKey]) window.__tt.translators[pairKey] = await Translator.create(opts);
        return { ok: true, text: await window.__tt.translators[pairKey].translate(${JSON.stringify(text)}) };
      })()`,
    );
    if (!translated.ok || !translated.text) {
      this.#lastError = `translate: ${translated.error ?? "empty result"}`;
      return { kind: "skip" };
    }
    return { kind: "translated", text: translated.text, source };
  }

  /** renderer 注册待刷新视图。 */
  registerView(key: string, view: TranslateView): void {
    let set = this.#views.get(key);
    if (!set) {
      set = new Set();
      this.#views.set(key, set);
    }
    set.add(view);
  }

  #notifyViews(key: string, result: TranslateResult): void {
    const set = this.#views.get(key);
    if (!set) return;
    this.#views.delete(key);
    for (const view of set) {
      view.setResult(result);
      view.requestRender();
    }
  }

  /** 重启后端 (例如语言包状态异常时)。 */
  async restart(): Promise<void> {
    this.shutdown();
    await this.start();
  }

  shutdown(): void {
    this.#chrome?.kill();
    this.#chrome = null;
    this.#server?.close();
    this.#server = null;
    this.#ready = false;
    this.#starting = null;
    // 二次清理: 进程组 kill 与 chrome 自退之间存在竞态, 按 profile 模式补刀。
    cleanupStaleChrome();
  }
}

let service: TranslateService | null = null;
function getService(): TranslateService {
  service ??= new TranslateService();
  return service;
}

function textKey(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// 渲染组件 (pi-tui Text: 自带 ANSI 感知换行与终端宽度检测)
// ---------------------------------------------------------------------------

const TRANSLATE_PREFIX = "[译] ";

class TranslateView implements Component {
  #container = new Container();
  #text: Text;
  #theme: Theme;
  #requestRender: () => void;
  #empty = true;

  constructor(opts: {
    theme: Theme;
    result: TranslateResult | null;
    pending: boolean;
    requestRender: () => void;
  }) {
    // paddingX=2 缩进与 thinking 正文对齐; 换行交给 pi-tui (处理 East-Asian
    // ambiguous 宽度与 ANSI), 避免手写宽度表导致行溢出重叠。
    this.#text = new Text("", 2, 0);
    this.#theme = opts.theme;
    this.#requestRender = opts.requestRender;
    this.#container.addChild(this.#text);
    this.#apply(opts.result, opts.pending);
  }

  #apply(result: TranslateResult | null, pending: boolean): void {
    const body = pending
      ? `${TRANSLATE_PREFIX}翻译中…`
      : result?.kind === "translated" && result.text
        ? `${TRANSLATE_PREFIX}${result.text}`
        : "";
    // 空文本时 Text 也会渲染一行空白占位, 由 render() 返回 0 行规避。
    this.#empty = body === "";
    this.#text.setText(this.#theme.fg("dim", body));
  }

  setResult(result: TranslateResult): void {
    this.#apply(result, false);
  }

  requestRender(): void {
    try {
      this.#requestRender();
    } catch {
      /* 宿主已卸载 */
    }
  }

  render(width: number): readonly string[] {
    if (this.#empty) return [];
    return this.#container.render(width);
  }

  invalidate(): void {
    this.#container.invalidate();
  }

  setIgnoreTight(ignore: boolean): void {
    this.#container.setIgnoreTight(ignore);
  }

  debugState(): Record<string, unknown> {
    return { text: this.#text.getText().slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.setLabel("Think Translate");

  pi.registerAssistantThinkingRenderer((context, theme) => {
    const svc = getService();
    // 同步快路径: 中文占比高的块必然跳过, 避免"翻译中"占位闪烁。
    // 与 TranslateService.#doTranslate 中的判定阈值保持一致。
    if (cjkRatio(context.text) >= 0.3) return undefined;
    const key = textKey(context.text);
    const cached = svc.peek(key);
    if (cached?.kind === "skip") return undefined;
    const view = new TranslateView({
      theme,
      result: cached,
      pending: cached === null,
      requestRender: context.requestRender,
    });
    if (cached !== null) return view; // 已有译文, 直接渲染
    svc.registerView(key, view);
    void svc.translate(context.text); // inflight 去重; 完成时经视图通知刷新
    return view;
  });

  pi.on("session_start", (_event, ctx) => {
    const svc = getService();
    svc.acquire();
    // 后台预热, 不阻塞会话启动; 永不 reject
    void svc.start().then((ok) => {
      if (!ok) {
        pi.logger.warn(`think-translate: ${svc.status()}`);
        try {
          ctx.ui.notify(`think-translate 后端未就绪: ${svc.status()}`, "warning");
        } catch {
          /* no UI */
        }
      }
    });
  });

  pi.on("session_shutdown", () => {
    getService().release();
  });

  pi.registerCommand("think-translate", {
    description: "思维翻译后端状态 / restart 重启",
    handler: async (args, ctx) => {
      const svc = getService();
      if (args.trim() === "restart") {
        await svc.restart();
      }
      ctx.ui.notify(svc.status(), "info");
    },
  });
}
