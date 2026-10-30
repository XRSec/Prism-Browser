# Prism Browser 深度隐私防护、防关联与无痕自动化规划 (TODO.md)

> **设计基调与核心原则**：
> 摒弃花哨的人机协同交互（如双光标轨迹、虚拟任务空间等），将核心研发资源 100% 聚焦于 **“全链路隐私安全、多环境防关联防封、网络防穿透泄漏、内核级 CDP 隐身”**。
> 确保每个 Profile 无论在日常使用还是自动化运行时，均具备最高等级的隐私隔离与抗检测能力。

---

## 1. 核心隐私与关联风险全景透视

在多账号运营与自动化场景中，目标平台（如 Google、Cloudflare、DataDome、Kasada、Twitter/X、Facebook、Amazon 等）主要通过以下 4 维雷达进行用户画像与行为识别：

```
                    ┌────────────────────────────────────────────────────────┐
                    │               目标平台反欺诈与风控雷达                 │
                    └────────────────────────────────────────────────────────┘
                               /                 |                 \
                              /                  |                  \
                             v                   v                   v
     【1. 自动化与 CDP 暴露】          【2. 网络与协议层穿透】         【3. 硬件/环境指纹特征】
     • 本地 TCP 端口扫描探测           • UDP/QUIC 绕过代理直连       • Canvas / WebGL 渲染特征
     • navigator.webdriver 标记        • WebRTC 真实公网/内网 IP 泄露 • AudioContext 声学指纹
     • V8 Inspector 调用栈污染         • 本地 DNS/DoH 泄露真实网段    • 字体、屏幕分辨率、时区
     • Runtime.enable 微任务延迟       • Google 遥测直连回传宿主信息  • Client Hints 与软硬件并发数
                                                 |
                                                 v
                                  【4. 本地存储与状态残留关联】
                                  • TLS Session Tickets 跨环境追踪
                                  • HSTS Cache 超级 Cookie
                                  • 宿主 MachineGuid / 设备号穿透
```

---

## 2. 核心技术对比与 ego 经验去伪存真

| 考量维度 | ego 的做法 | Prism 采纳/扬弃态度 | 核心理由与隐私防护本质 |
| :--- | :--- | :--- | :--- |
| **Agent Cursor (虚拟光标)** | 渲染合成层绘制带标签的 AI 虚拟鼠标 | ❌ **不采纳 (去除)** | 花哨交互，对多账号隐私防封无实质价值。如果未来需要拟人轨迹，直接在自动化层使用 GitHub 成熟开源库（如 `ghost-cursor` 计算贝塞尔曲线平滑轨迹，或用轻量 Shadow DOM 注入展示状态气泡），绝不碰 C++ 渲染层，零额外包袱。 |
| **TaskSpace (任务空间)** | 内核隔离人类标签页与 Agent 任务页 | ❌ **不采纳 (去除)** | Prism 原生就是基于多独立 Profile 并发的，本身已具备进程和存储级隔离，无需单窗口内搞复杂空间概念。 |
| **CDP 隐身机制** | 内核拦截控制台日志与 Inspector 痕迹 | ✅ **深度采纳并加固** | **极其关键**。常规 CDP 会暴露大量调试特征，被高级风控直接判定为 Bot。必须做到自动化无感隐身。 |
| **私有 IPC 替代 TCP** | 废弃 `--remote-debugging-port`，改走管道 | ✅ **深度采纳并强制** | **极其关键**。打开 TCP 端口会被本地恶意网页通过 Ajax 扫描 `127.0.0.1:port`，形成环境指纹甚至劫持。 |
| **底层内核替代** | 全盘替换为 ego 内核 | ❌ **坚决否定** | ego 完全使用宿主机真实原生硬件指纹，直接替换将导致多 Profile 硬件特征完全相同，瞬间批量连坐封号。 |

---

## 3. 隐私与防关联技术复用路线 (TODO List)

### Phase 1: 自动化隐身与 CDP 反检测防御 (P0 - 最高优先级)
*目标：使 Prism 的自动化会话（Playwright / Puppeteer / MCP Agent）在页面看来与人类手工点击毫无二致，完全抹去调试器痕迹。*

- [ ] **1.1 彻底封禁网络调试端口，全量普及 Pipe 管道**：
  - [x] 在 `src/main/browser-launcher.ts` 中已支持管道，需进阶为：在开启自动化时**默认全面禁用 `--remote-debugging-port`**，仅保留 `--remote-debugging-pipe`。
  - [ ] 阻断目标网页利用 `fetch('http://127.0.0.1:xxxx/json')` 实施本地端口探测，从根本上杜绝“端口号探活/跨环境指纹识别”。
- [ ] **1.2 内核级屏蔽 V8 Inspector 与控制台调试痕迹**：
  - [ ] 抹除 `Runtime.enable` 对执行环境的入侵影响，阻断 `consoleAPICalled` 事件可能引发的内部状态泄露。
  - [ ] 拦截并屏蔽利用 `console.debug`、`console.table` 在 DevTools 开启时的微任务耗时异常探测。
  - [ ] 消除 `Error.prepareStackTrace` 中夹带的 DevTools / CDP 内部脚本文件名与调用栈特征。
- [ ] **1.3 内核级 `navigator.webdriver` 绝对抹除**：
  - [ ] 在 Blink 内核层彻底将 `navigator.webdriver` 定义置为 `false` 或 `undefined`。
  - [ ] 杜绝基于 JavaScript `Object.defineProperty` 浅层伪造被反爬脚本通过原型链反射（`getOwnPropertyDescriptor`）戳穿的问题。
- [ ] **1.4 驱动级特征字符串与伪造对象净化**：
  - [ ] 彻底清理 Chromium/ChromeDriver 遗留特征符号（如 `cdc_adoQpoasnfa76pfcZLmcfl_` 变量）。
  - [ ] 补齐 `window.chrome` 运行环境（包含真实的 `chrome.runtime`, `chrome.app`, `chrome.csi`, `chrome.loadTimes`），确保与常规正常点击环境一致。

---

### Phase 2: 网络链路安全与真实 IP/DNS 零穿透 (P0 - 最高优先级)
*目标：杜绝任何绕过单环境代理的请求，确保真实物理网卡 IP、内网网段、国内 DNS 零暴露。*

- [ ] **2.1 TCP 代理防 UDP/QUIC 绕过准则落地**：
  - [ ] 当环境配置为 HTTP/HTTPS/SOCKS5（仅 TCP 链路）时，**必须强制阻断 HTTP/3 (QUIC)**。
  - [ ] 启动参数自动补全 `--disable-quic`，并在网络层拦截/剥离所有响应头中的 `alt-svc`（防止浏览器私自向物理网卡发送 UDP 443 探测包导致真实 IP 直出）。
- [ ] **2.2 WebRTC 严格隔离与内/外网防泄漏**：
  - [ ] 统一配置 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`，确保 WebRTC 媒体协商绝对不扫描物理网卡地址。
  - [ ] 根据 Profile 配置，提供“替换为代理 IP”、“彻底禁用 WebRTC”、“伪造局域网私有 IP”三档防护，防止 STUN 服务器穿透代理嗅探宿主机公网 IP。
- [ ] **2.3 强制远端 DNS 解析，阻断安全 DNS (DoH) 旁路**：
  - [ ] 关闭浏览器内置的“安全 DNS (Secure DNS / DoH)”开关与自动升级策略（`--disable-features=DnsOverHttps`）。
  - [ ] 确保所有域名解析完全由绑定的代理服务器远端代理解析，防止本地系统 DNS 解析请求携带国内真实网段特征。
- [ ] **2.4 拔除浏览器原生遥测与 Google 回传信道**：
  - [ ] 禁用 Google SafeBrowsing（防钓鱼保护会向 Google 上报访问的 URL）。
  - [ ] 禁用 Crashpad / Breakpad 崩溃日志上传（防止系统元数据与宿主环境直传 Google 收集服务器）。
  - [ ] 禁用 Google Metrics、Component Updater、Domain Reliability Monitor 等后台静默直连请求。

---

### Phase 3: 硬件指纹抗聚类与跨环境隔离加固 (P1 - 核心防护)
*目标：保证各个 Profile 的指纹绝对独立、真实自然、可稳定复现，绝不在不同环境间发生特征碰撞。*

- [ ] **3.1 指纹种子（Seed）确定性与漂移防护**：
  - [x] 已完成：`61b14a2` 合并 fingerprint seed 列至指纹列。
  - [ ] 加固：确保 Canvas 噪点、Audio 频响噪点在同一个 Profile 内多次重启后**计算结果绝对恒定**（避免因每次启动随机导致目标站判定为“指纹不稳定欺诈设备”）。
  - [ ] 加固：确保不同 Profile 之间噪点算法空间足够庞大，彻底消除跨环境发生碰撞的概率。
- [ ] **3.2 WebGL 供应商与显卡渲染器深度一致性**：
  - [ ] 校验 `UNMASKED_VENDOR_WEBGL` 与 `UNMASKED_RENDERER_WEBGL` 伪造值与实际的 GL Extensions、Shader 编译精度、最大纹理尺寸（`MAX_TEXTURE_SIZE`）逻辑自洽，杜绝“标称是 RTX 4090，实际特性为 Intel 集显”的矛盾。
- [ ] **3.3 时区、系统语言与代理 GeoIP 严格闭环**：
  - [ ] 启动时自动通过代理节点探测出口 IP 的真实 GeoIP（国家、城市、经纬度、时区），并自动对齐环境内部的：
    - `Intl.DateTimeFormat().resolvedOptions().timeZone`
    - 系统语言 `navigator.languages` 与 HTTP `Accept-Language` 头
    - Geolocation API 虚拟定位坐标。
- [ ] **3.4 屏幕与视口特征真实化**：
  - [ ] 拦截并伪造 `window.screen`（宽高、可用宽高、颜色深度、devicePixelRatio），禁止暴露宿主多显示器物理几何排布（`window.screenX/Y`, `screen.isExtended`）。
- [ ] **3.5 Chromium 内核版本升级与能力一致性防护 (防范 153 版本偏旧风险)**：
  - [ ] **版本滞后风险自查**：
    - 当前本地管理的指纹内核为 `153.0.8010.53`（对比现行主流 Chromium 156+）。
    - 风险 1：**Web API 特征断层（Lie Detection）**。若单纯把 User-Agent / `sec-ch-ua` 伪装为新版（如 156），但底层 153 缺少新版 V8 特性、WebGPU 或 CSS 规范属性，会被 Cloudflare、DataDome 立刻判定为“假冒浏览器（Lies Detected）”。
    - 风险 2：**BoringSSL TLS 握手特征（JA3/JA4）滞后**。老版本握手扩展列表与密码套件偏好与声明的现代 Chrome 不一致。
  - [ ] **近期防护策略**：在内核升级到位前，**严禁跨大版本无脑伪造 UA**，确保 Profile 声明的 `sec-ch-ua` 严格与实际 153 能力对齐，保持“特性与声明绝对自洽”。
  - [ ] **远期升级目标**：推进基于主流最新稳定版本（Chromium 156+）编译新的 Fingerprint 内核，同步更新 `kernel-catalog.ts`。

---

### Phase 4: 本地数据与持久化层防交叉污染 (P1 - 核心隔离)
*目标：杜绝多个环境在本地磁盘和内存中的数据交叉残留，杜绝“超级 Cookie”与追踪凭据。*

- [ ] **4.1 独立隔离存储与绝对零污染**：
  - [ ] 确保每个 Profile 独享唯一的 `userDataDir`，严禁借用或污染 Default 用户目录。
  - [ ] 禁用跨环境同步（Chrome Sync），独立加解密各 Profile 的 SQLite Cookie 数据库。
- [ ] **4.2 阻断 TLS 会话复用与 HSTS 超级 Cookie 追踪**：
  - [ ] 关闭/重置 TLS Session Cache 与 Session Tickets，防止风控系统利用 TLS 握手特征在多次会话间维持追踪。
  - [ ] 在清除环境缓存时，联动清理 HSTS (`TransportSecurity`) 记录，防止站点利用精心构造的 HSTS 状态标记设备。
- [ ] **4.3 宿主机唯一标识（Hardware UUID / GUID）屏蔽**：
  - [ ] 拦截渲染层和扩展层对系统原生设备识别码（如 MAC 地址、硬盘序列号、Windows MachineGuid、macOS IOPlatformUUID）的探测请求，替换为根据环境 Seed 虚拟生成的不可逆虚拟标识。

---

## 4. 关键验证套件与防检评分基准 (Acceptance Matrix)

每个版本发布前，必须在以下测试环境中验证并留存证据：

| 检测靶场 | 核心检验项 | 合格指标 |
| :--- | :--- | :--- |
| **CreepJS** | 指纹稳定性、欺诈指数 (Lies detection) | 欺诈项为 0，没有原型链伪造红字警告，指纹评分等级达到 A。 |
| **Pixelscan** | 软硬件一致性、代理与时区对齐 | 显示 “No automation detected”，所有指纹与代理 IP 一致。 |
| **Incolumitas** | CDP 痕迹、webdriver 状态 | `webdriver: false`，`puppeteer/playwright: false`，无调试器泄露。 |
| **Browserleaks (WebRTC/IP)** | WebRTC 探测、STUN 漏点 | 仅展示代理出口 IP，宿主机本地 IPv4/IPv6 与物理内网网段完全隐藏。 |
| **Browserleaks (DNS/TLS)** | DNS 泄漏测试、JA3/JA4 指纹 | DNS 服务器均为代理节点所在机房，无国内 DNS 服务器解析痕迹。 |
| **Cloudflare Turnstile** | 自动化通过率 | 在正常代理纯净度下，无须频繁人工点选滑块，直出 Token。 |

---

## 5. 代码落地对应模块表

| 防护任务 | Prism 关键文件位置 | 关键改造点 |
| :--- | :--- | :--- |
| **禁用调试端口 & 强制管道** | `src/main/browser-launcher.ts`<br>`src/main/launch-args.ts` | 彻底移除 `--remote-debugging-port`，全面切换至管道模式，杜绝端口探测。 |
| **网络阻断 (UDP/QUIC/DNS)** | `src/main/launch-args.ts`<br>`src/main/proxy-bridge.ts` | 补全 `--disable-quic`、禁用 DoH、阻断非代理 UDP。 |
| **WebRTC 隐私隔离** | `src/main/launch-args.ts` | 针对 Profile 策略精准注入 WebRTC IP 策略参数。 |
| **指纹自洽与抗碰撞** | `src/main/profile-store.ts`<br>`src/main/kernel-manager.ts` | 完善指纹 Seed 生成与各渲染子系统的确定性 Hash 映射。 |
| **遥测与外联阻断** | `src/main/browser-launcher.ts` | 剔除 SafeBrowsing、Crashpad 等 Google 原生后台通讯。 |
