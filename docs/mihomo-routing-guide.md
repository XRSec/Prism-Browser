# Prism Browser & Mihomo 本地代理多环境分流全景指南

> 本文档面向需要进行 **多账号指纹隔离、防关联防封、出口 IP 精准分配** 的用户与自动化开发者。
> 无论你是已有 Clash/Flclash 客户端的老玩家，还是日常只用 Shadowrocket（小火箭）的用户，本文档都能为你提供最轻量、最高性能的代理分配落地方案。

---

## 1. 为什么我们不默认内置 Mihomo 二进制？

在设计 Prism Browser 时，我们经过深思熟虑，决定**不直接打包或捆绑第三方网络代理二进制文件**。核心原因如下：

1. **安全与杀毒误报防护（防连带隔离）**：
   网络代理底层核心（尤其是包含 TUN 模式、系统路由接管特性的二进制）经常被 Windows Defender、macOS Gatekeeper 或各类安全软件标记为误报。如果不慎被杀毒软件误杀，会导致整个 Prism Browser 主程序被连带损坏或崩溃。
2. **开源规范与职责边界**：
   Mihomo（Clash.Meta）遵循开源许可协议，保持松耦合独立调用是尊重开源项目的规范做法。
3. **版本完全自主权**：
   不同用户对代理协议的支持要求不同（如最新的 VLESS、Hysteria2、Tuic、Reality 等）。让用户自主指定二进制路径，意味着你可以自由使用官方最新 Release、Alpha 测试版或自己编译的硬件加速版本，而不被浏览器锁定在老旧版本上。
4. **官方获取渠道公开透明**：
   - **Mihomo 官方 GitHub 发布页**：[https://github.com/MetaCubeX/mihomo/releases](https://github.com/MetaCubeX/mihomo/releases)
   - **推荐版本**：下载对应系统架构的稳定版（如 `mihomo-darwin-arm64` 或 `mihomo-windows-amd64`），解压后放置于系统任意目录即可。

---

## 2. 场景化最优解决策树

你应当根据当前电脑已有的网络环境，选择对应的**最简实现路径**：

```
                         【你的当前代理工具是什么？】
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
  【场景 A：已有 Clash / Flclash / Verge】         【场景 B：没有 Clash / 只有 Shadowrocket】
  • 绝不要再开一个软件！                            • 绝不要再去专门装一个臃肿的 Clash 客户端！
  • 最优解：【覆写模式 (Override / Script)】        • 最优解：【Prism 两个输入框后台轻量托管】
  • 把 Prism 生成的几行 JS 扩展脚本贴进客户端       • 仅配置：[二进制路径] + [配置文件路径]
  • 订阅随便自动更新，Prism 分流规则永久生效       • 浏览器启动时自动后台带起，关闭时自动退出
                                                   • 干净利落，替你省掉一个开机自启常驻软件
```

### 场景 A：电脑已有 Flclash / Clash Verge Rev / Mihomo Party
> **核心原则：绝不重复多开软件，利用客户端的“覆写模式 (Override)”实现动态合并。**

* **痛点**：机场订阅每隔几天就会自动更新节点。如果你直接在下载的 `config.yaml` 里改规则，一旦点击“更新订阅”，手写的配置就会全部被冲掉！
* **最优解：扩展脚本 / 覆写模式**：
  * **Flclash**：`设置 -> 覆写 -> 脚本/Merge`
  * **Clash Verge Rev**：`订阅 (Profiles) -> 右上角新建 Script 扩展 -> 启用`
  * **Mihomo Party**：`覆写 (Overrides) -> 新建 JavaScript 覆写`
* **工作机制**：客户端在内存中将原订阅节点与 Prism 的多用户分流规则动态合并，**原订阅节点随时更新，Prism 分流永久有效**！

### 场景 B：没有使用 Clash（日常只用 Shadowrocket 小火箭，或无代理客户端）
> **核心原则：替用户省掉一个额外的启动器，由 Prism 托管一个纯净、无界面、极低占用的后台核心。**

* **如何操作？Prism 只需要“两个输入框”**：
  1. **输入框 1【Mihomo 二进制文件路径】**：例如 `/opt/homebrew/bin/mihomo` 或 `C:\tools\mihomo.exe`。
  2. **输入框 2【使用的配置文件路径】**：选择你现有的任何订阅文件或小火箭导出的 YAML 配置。
* **底层运行机制与配置文件位置**：
  * Prism 会读取你的原配置文件，在内存中注入 Prism 的分流补丁；
  * **绝不篡改原文件**，合成后的运行配置自动写入本地沙盒金库：
    * macOS: `~/Library/Application Support/prism-browser/vault/mihomo/config.yaml`
    * Windows: `%APPDATA%\prism-browser\vault\mihomo\config.yaml`
  * 后台以隔离参数拉起：
    ```bash
    mihomo -d "<vault>/mihomo" -f "<vault>/mihomo/config.yaml"
    ```
  * 浏览器关闭时，后台子进程自动干净杀掉，不占用任何系统全局代理或多余内存。

---

## 3. 为什么密码可以统一？Listen Users 与 IN-USER 的技术本质

很多用户误以为代理密码一定要设计得很复杂，其实在本地回环机制下，这种理解是错误的。

### 1. 本地回环网络（127.0.0.1）的安全性
* Prism 强制配置 `bind-address: 127.0.0.1` 且 `allow-lan: false`；
* 代理端口**仅对本机自身开放，外部局域网及公网完全无法连接**；
* 因此，在本地无需抵御暴力破解，**密码只要填一个统一的值（如 `prism`）作为协议占位符即可**。

### 2. 用户名（Username）的真实作用：“环境路由标签 (Routing Tag)”
当你在 Prism 中给 Profile 填入：
`socks5://node-0001:prism@127.0.0.1:17890`
这个 `node-0001` 的核心作用是**给进入 17890 端口的每一笔流量打上专属染色标签**。

### 3. 如何实现不同 Profile（如 Pro 环境组）走特定出口节点？
在 Mihomo 配置文件的 `rules` 顶部，加入 `IN-USER` 规则：

```yaml
mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1

users:
  - "node-0001:prism"
  - "node-0002:prism"
  - "pro-group-01:prism"
  - "pro-group-02:prism"

rules:
  # 1. 精确指定某环境走特定节点
  - IN-USER,node-0001,🇺🇸 专线节点-美国-01
  - IN-USER,node-0002,🇯🇵 专线节点-日本-02

  # 2. 让所有 Pro 组环境走专属高纯净节点池
  - IN-USER,pro-group-*,🚀 Pro专线策略组

  # 3. 未匹配环境走默认直连或普通分流
  - MATCH,DIRECT
```

---

## 4. Dashboard 是干嘛的？链接在哪？

### 1. Dashboard 的核心作用
Mihomo 核心本身是纯命令行的后台服务，**Dashboard（如 Zashboard 或 MetaCubeXD）是一个解耦的纯前端 Web 界面**，通过 WebSocket / REST API 与本地 `127.0.0.1:9090` 外部控制器通信。
它的核心价值包括：
1. **测速与延迟可视化**：查看订阅中所有节点的实际连通率和真延迟；
2. **手动切换出口**：遇到节点波动时，点一下即可手动切换某个策略组的落地节点；
3. **连接诊断**：查看每个 Profile 发起的 TCP 连接目标、流量占用与持续时间。

### 2. Dashboard 访问方式与直达链接
Prism 软件内已直接内嵌了可视化 iframe，同时也支持以下外部访问方式：

* **方式 1：jsDelivr CDN 直连（推荐，开箱即用，免下载）**
  [https://cdn.jsdelivr.net/gh/Zephyruso/zashboard@gh-pages/?host=127.0.0.1&port=9090#/proxies](https://cdn.jsdelivr.net/gh/Zephyruso/zashboard@gh-pages/?host=127.0.0.1&port=9090#/proxies)
* **方式 2：本地离线内置 UI（需解压离线包至 `vault/mihomo/ui/`）**
  `http://127.0.0.1:9090/ui/?host=127.0.0.1&port=9090#/proxies`
  * 离线包下载直达：[https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip](https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip)
* **方式 3：官方在线托管版**
  - Zashboard: [https://board.zash.run/#/setup](https://board.zash.run/#/setup)
  - MetaCubeXD: [https://metacubex.github.io/metacubexd/](https://metacubex.github.io/metacubexd/)

---

## 5. 给 AI Agent 的提示词指令模板 (Prompt Recipes)

如果你使用 Pi Coding Agent、Claude Code 或 Antigravity (agy)，你无需手动点击界面，把以下提示词直接发送给 AI 即可自动执行：

### 提示词模板 1：自动将存量 Profile 批量绑定到本地分流代理
```text
请调用 Prism 的 profile 更新工具，将我当前所有的浏览器环境代理统一配置为本地 Mihomo 分流端口：
- 协议：SOCKS5
- 主机：127.0.0.1
- 端口：17890
- 密码：prism
- 用户名：按环境序号自动填充（例如环境 #28 对应 node-0028）
- 绕过列表保留默认的 localhost;127.0.0.1
```

### 提示词模板 2：生成可直接贴入客户端的 JavaScript 覆写脚本
```text
读取我当前 Prism 浏览器所有存量 Profile 的名称与序号，生成一份与这些 Profile 严格对应的 Mihomo users 凭据列表和 IN-USER 分流规则代码块，并输出一份可直接贴入 Flclash / Clash Verge 的 JavaScript 扩展脚本。
```

---

## 6. 本地直接查看与打开方式

本文档随代码库物理持久化存储于：
- **项目相对路径**：`docs/mihomo-routing-guide.md`
- **macOS 打开命令**：
  ```bash
  open "docs/mihomo-routing-guide.md"
  ```
- **Windows 打开命令**：
  ```powershell
  start docs\mihomo-routing-guide.md
  ```
同时在 Prism Browser 桌面端的【Mihomo 方案助手】弹窗顶部，提供了一键 **【打开本地文档】** 与 **【复制文档路径】** 按钮，点击即可调用系统默认 Markdown 编辑器直接阅读。
