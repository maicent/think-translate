# think-translate

[omp](https://github.com/oh-my-pi) 扩展:自动把助手 **thinking 块**翻译成你的语言,渲染在原思考内容下方(纯展示层,不修改会话内容与历史)。

灵感来自 [dsh-reasoning-translator](https://github.com/pinkllo/dsh-reasoning-translator)(DeepSeek Harness 插件),本扩展把同样的思路带到了 omp 的终端 UI。

An [omp](https://github.com/oh-my-pi) extension that translates the model's **thinking blocks** into your language, rendered below the original thinking content. Display-only — session content and history are never modified.

```
 The user wants me to think briefly in English about why the sky is blue...
  [译] 用户希望我用英语简要地思考为什么天空是蓝色的,然后准确地回答"完成"。...
```

## 特性 / Features

- **本地翻译,零 API key**:使用 Google Chrome 内置的 [Translator API](https://developer.chrome.com/docs/ai/translator-api),模型完全在本地运行,内容不出本机,无 token 费用
- **纯展示层**:翻译只发生在 TUI 渲染层,会话文件、上下文、模型回放内容全部保持原文
- **自动跳过**:已是目标语言的 thinking 块(中文占比启发式 + `LanguageDetector` 双重判定)不显示译文
- **按需异步**:翻译在后台完成,完成后自动刷新,不阻塞会话
- **缓存**:按内容哈希缓存译文(上限 500 条),同一 thinking 块重复渲染(滚动、重绘)不会重复翻译
- **进程托管**:Chrome 随 omp 会话自动启动/清理(detached 进程组 + 单例锁清理,不留孤儿进程)

## 要求 / Requirements

- **Google Chrome ≥ 138**(发行版自带的 Chromium 构建不含内置 AI 模型;不支持移动端 Chrome)
- **omp ≥ 18.x**
- 首次使用会下载目标语言包(几十 MB,保存在扩展的 Chrome profile 中,之后离线可用)

## 安装 / Install

单文件扩展,拷进 omp 的用户扩展目录即可:

```bash
curl -o ~/.omp/agent/extensions/think-translate.ts \
  https://raw.githubusercontent.com/<your-name>/think-translate/main/think-translate.ts
```

重启 omp 生效(扩展在会话启动时加载)。项目级安装:放到 `<cwd>/.omp/extensions/`。

## 使用 / Usage

无需配置,自动生效:模型用英文(或其他非目标语言)思考时,thinking 块下方自动出现 dim 样式的 `[译]` 译文;中文思考直接跳过。

```text
/think-translate           查看后端状态(Chrome pid、缓存条数、目标语言)
/think-translate restart   重启 Chrome 后端(语言包状态异常时使用)
```

### 配置(环境变量)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `THINK_TRANSLATE_TARGET` | `zh` | 目标语言(BCP-47),如 `ja`、`ko`。换语言首次会下载对应语言包 |
| `THINK_TRANSLATE_CHROME` | 自动探测 | Chrome 可执行文件路径 |

## 原理 / How it works

```
omp (Bun 运行时)
 └─ think-translate.ts (扩展, registerAssistantThinkingRenderer)
     ├─ 内嵌 HTTP 服务 (127.0.0.1, 宿主页面)
     └─ headless Google Chrome (常驻, --remote-debugging-pipe)
         ├─ LanguageDetector  判定源语言
         └─ Translator        on-device 翻译
```

- **CDP pipe 而非端口**:`--remote-debugging-pipe` 走 fd3/fd4(`\0` 分隔 JSON),不占调试端口
- **user gesture**:模型未下载时 Chrome 要求 user activation 才允许 `Translator.create()`;所有 `Runtime.evaluate` 带 `userGesture: true` 兜底 + CDP 可信点击双保险
- **安全上下文**:Translator API 只在 secure context 暴露(`about:blank` 不可用),故内嵌 127.0.0.1 页面
- **语言包缓存**:Chrome profile 固定在 `~/.omp/agent/think-translate/chrome-profile`,语言包只下载一次;损坏时删除该目录重建即可

## 已知限制 / Limitations

- 仅 TUI 模式渲染(print/rpc 模式 thinking 不可见,无影响)
- 只翻译 thinking 块,不翻译助手的最终回答
- 译文缓存为内存级,重启 omp 后首次翻译需重新调用 Chrome
- 非中文目标语言时,中文快路径阈值(0.3)可能不适合,欢迎提 issue

## 故障排查 / Troubleshooting

| 现象 | 处理 |
|---|---|
| 启动提示"后端未就绪: 未找到 Google Chrome" | 安装 Google Chrome 或设置 `THINK_TRANSLATE_CHROME` |
| 翻译不出现,状态显示 `Translator availability` 错误 | `/think-translate restart`;仍不行则删除 `~/.omp/agent/think-translate/chrome-profile` 重建 |
| 想换目标语言 | 设置 `THINK_TRANSLATE_TARGET` 后重启 omp(或 `/think-translate restart`) |

## 许可 / License

MIT
