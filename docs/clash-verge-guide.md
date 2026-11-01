# Prism Browser & Clash Verge (Rev) 专属分流集成指南

> 本文档针对使用 **Clash Verge (Rev)** 客户端的用户，提供基于**覆写模式（Script Override）**的完整多环境独立节点分流方案。
> 方案特点：**不篡改机场订阅、机场自动更新不丢失配置、主端口与 Prism 端口物理级解耦、Verge 图形界面直观选节点且持久记忆**。

---

## 1. 核心架构与设计哲学

在 Clash Verge 中，最优雅的多环境隔离不是去手动修改下载好的订阅 YAML，而是利用 **Script（JavaScript 扩展脚本）** 在内存中动态合成配置。

```
                    ┌── [端口 7897 (无密码)] ──────> 供 macOS 系统代理与日常应用，走原有默认策略
[Clash Verge 内核] ──┤
                    └── [端口 17890 (含 Users 认证)] ─> 供 Prism 各环境，通过 IN-USER 分流到专属策略组
                                                                │
                                   ┌────────────────────────────┼────────────────────────────┐
                                   ▼                            ▼                            ▼
                          [Prism-环境-01 策略组]       [Prism-环境-02 策略组]       [Prism-环境-03 策略组]
                          (Verge 界面任意点选节点)      (Verge 界面任意点选节点)      (Verge 界面任意点选节点)
```

### 为什么采用此方案？
1. **彻底解耦主端口与分流端口**：主端口（`7897`）保持完全无密码，避免 macOS 系统代理或 SOCKS5 握手因密码问题被拒绝重置；独立开辟 `17890` 专属监听端口供 Prism 各环境使用。
2. **策略组追加至末尾**：将 3 个环境专属策略组追加在 `proxy-groups` 数组末尾，防止挤占第一位，保留机场原有的第一主策略组（如 `🚀 节点选择`）作为系统默认。
3. **纯手动单选 + 持久记忆**：策略组为纯 `type: select`，绝不自动测速切换，并在 `profile` 中开启 `store-selected: true`，选定节点后即使重启电脑也永久记住。

---

## 2. Clash Verge 核心配置文件 5 兄弟详解

Clash Verge Rev 的配置管理是由 5 个协同文件驱动的，理解它们的职责能彻底避免排错走弯路：

| 配置文件名 | 物理路径 (macOS: `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/`) | 职责定位与核心内容 |
| :--- | :--- | :--- |
| **`clash-verge.yaml`** | 根目录下 | **👑 最终生效的真机运行时配置**。<br>Clash Verge 将机场订阅、Script 扩展脚本、Merge 补丁、DNS 覆盖等动态计算后输出的最终大文件。Mihomo 核心实际读取并跑起来的就是它！排查规则是否命中看它最准。 |
| **`profiles.yaml`** | 根目录下 | **📋 订阅与扩展账本元数据**。<br>记录您添加了哪些远程订阅 URL、本地文件、Merge 规则、Script 脚本，以及当前激活的订阅 UID（`current: xxxx`）与自动更新间隔。 |
| **`config.yaml`** | 根目录下 | **⚙️ 核心基础模板**。<br>定义了基础监听端口（`mixed-port: 7897`）、外部控制器（`external-controller: 127.0.0.1:9090`）、API 鉴权密钥（`secret`）、CORS 白名单以及日志级别。 |
| **`dns_config.yaml`** | 根目录下 | **🌐 独立 DNS 覆盖策略**。<br>专门控制 DNS 模块，包括 Fake-IP 模式、国内阿里/腾讯 DNS 与海外 Cloudflare DoH 上游分流解析，防止 DNS 污染。 |
| **`verge.yaml`** | 根目录下 | **🖥️ 客户端 GUI 偏好设置**。<br>控制应用自身的窗口状态、开机自启、系统代理开关状态、浅色/深色主题、托盘图标样式等客户端行为。 |

---

## 3. Mihomo 代理集合 (Proxy Providers) 与传统订阅的区别

很多用户在配置分流时经常混淆这两者的概念，它们的本质区别在于**“控制权归属”**：

```
                      【传统机场订阅 (Subscription)】              【Mihomo 代理集合 (Proxy-Providers)】
                       ───────────────────────                       ────────────────────────────────
数据形式:              整包全家桶 (YAML 文件)                         纯节点数据池 (Raw Node List)
包含内容:              节点 (proxies) + 规则 (rules) + 策略组         仅包含物理节点列表
本地控制权:            受制于机场：更新订阅即全量重置                 完全掌握在本地：本地定义 rules 和 groups
分流稳定性:            差：手写的 IN-USER 规则每次更新必被冲掉       极佳：rules 和策略组永不改变，仅节点动态刷新
在 Verge 中最佳形态:   使用【Script 覆写扩展】动态打补丁              直接在本地配置中声明 use: [provider_name]
```

* **传统订阅**就像机场给你的“盒饭”，里面米饭和菜（节点与规则）混在一起，机场更新就像重新发了一盒新饭，你加的调料（自定义规则）全没了。
* **Proxy Providers** 则是把机场仅当成“菜市场”，你只去拉取新鲜的食材（节点），在本地自己的厨房（本地规则与策略组）里炒菜。
* **为什么本文档采用 Script 覆写？** 因为 Clash Verge 用户大部分直接导入了机场订阅链接（传统整包订阅）。**通过 Script 覆写，我们在不破坏机场订阅的前提下，实现了等同于 Proxy Providers 的持久化分流效果！**

---

## 4. Web UI 控制台标准 URL 传参规范

Mihomo 外部控制接口（默认 `127.0.0.1:9090`）支持多种现代化的 Web 仪表盘。当通过浏览器或 iframe 嵌入时，推荐采用标准参数自动连接：

| 仪表盘名称 | 托管地址与标准自动连接 URL 格式 |
| :--- | :--- |
| **Zashboard** (官方在线) | `https://board.zash.run.place/#/setup?http=true&hostname=127.0.0.1&port=9090&secret=YOUR_SECRET` |
| **MetaCubeXD** (官方在线) | `https://metacubex.github.io/metacubexd/#/setup?http=true&hostname=127.0.0.1&port=9090&secret=YOUR_SECRET` |
| **YACD** (经典仪表盘) | `https://yacd.metacubex.one/?hostname=127.0.0.1&port=9090&secret=YOUR_SECRET` |
| **本地离线 UI** | `http://127.0.0.1:9090/ui/#/setup?hostname=127.0.0.1&port=9090&secret=YOUR_SECRET` |

> **关键参数说明**：
> 1. **`http=true`**：当仪表盘部署在 HTTPS 域名（如 GitHub Pages）时，必须传 `http=true`，告诉前端对 `127.0.0.1` 发送标准的 HTTP 请求而不是强制 HTTPS。
> 2. **Hash 路由结构**：Zashboard 和 MetaCubeXD 采用前端 SPA 单页路由，参数必须拼接在 `/#/setup?` 之后，否则 Vue 路由器无法解析。

---

## 5. 完整覆写脚本代码（Clash Verge Script）

在 Clash Verge 客户端中点击 **「订阅 (Profiles)」-> 右上角「新建」-> 类型选择「Script」**，填入任意名称（如 `Prism-Routing`），点击编辑并粘贴以下完整代码：

```javascript
// ====================================================================
// Prism Browser & Clash Verge: 独立监听器解耦 + 3独立单选策略组
// ====================================================================
function main(config) {
  // 1. 动态过滤有效物理节点 (自动剔除流量提示等占位符)
  const allProxyNames = (config.proxies || [])
    .map((p) => p.name)
    .filter((name) => name && !/剩余流量|套餐到期|官网|群组|更新/i.test(name));
  
  const providerNames = config['proxy-providers'] ? Object.keys(config['proxy-providers']) : [];

  // 2. 开启选择记忆持久化 (确保手动选定后绝不自动跳变)
  config['profile'] = {
    ...(config['profile'] || {}),
    'store-selected': true
  };

  // 3. 【核心解耦】：专门为 Prism 开辟 17890 专属端口，主端口彻底保持无密码
  // 注意：listeners 下的 users 必须是对象数组 { username, password }，不能是纯字符串
  config.listeners = [
    ...(config.listeners || []),
    {
      name: 'prism-inbound',
      type: 'mixed',
      port: 17890,
      listen: '127.0.0.1',
      users: [
        { username: 'node-0001', password: 'prism' },
        { username: 'node-0002', password: 'prism' },
        { username: 'node-0003', password: 'prism' }
      ]
    }
  ];

  // 4. 生成 3 个专属手动单选策略组 (纯 select 模式，不自动测速切换)
  const prismGroupNames = ['Prism-环境-01', 'Prism-环境-02', 'Prism-环境-03'];
  const newProxyGroups = prismGroupNames.map((groupName) => {
    const group = {
      name: groupName,
      type: 'select',
      proxies: ['DIRECT', ...allProxyNames]
    };
    if (providerNames.length > 0) group.use = providerNames;
    return group;
  });

  // 5. 追加在 proxy-groups 末尾，原有的第一主策略 (如 🚀 节点选择) 保持在最顶部不变
  config['proxy-groups'] = [...(config['proxy-groups'] || []), ...newProxyGroups];

  // 6. 规则置顶：IN-USER 规则以最高优先级命中
  const prismRules = [
    'IN-USER,node-0001,Prism-环境-01',
    'IN-USER,node-0002,Prism-环境-02',
    'IN-USER,node-0003,Prism-环境-03'
  ];
  config.rules = [...prismRules, ...(config.rules || [])];

  return config;
}
```

---

## 6. 覆写前后配置文件结构对照示例

### 覆写前：原始订阅 YAML 片段示例
原始机场订阅只包含全局端口和通用规则，完全没有用户认证与环境分流能力：
```yaml
mode: rule
mixed-port: 7897
allow-lan: false
proxies:
  - name: 🇸🇬新加坡01-专线
    type: vless
    server: ...
  - name: 🇯🇵日本01-专线
    type: vless
    server: ...
proxy-groups:
  - name: 🚀 节点选择
    type: select
    proxies:
      - 🇸🇬新加坡01-专线
      - 🇯🇵日本01-专线
rules:
  - DOMAIN-SUFFIX,google.com,🚀 节点选择
  - MATCH,DIRECT
```

---

### 覆写后：最终生成的运行配置 (`clash-verge.yaml`) 片段对照
覆写脚本注入后，最终运行配置结构如下（已实际验证通过）：
```yaml
mode: rule
mixed-port: 7897                  # 原主端口保持无密码，供日常系统代理使用
profile:
  store-selected: true            # 开启策略选择记忆

# 1. 注入的专属监听器 (端口 17890，带入站用户凭据)
listeners:
  - name: prism-inbound
    type: mixed
    port: 17890
    listen: 127.0.0.1
    users:
      - username: node-0001
        password: prism
      - username: node-0002
        password: prism
      - username: node-0003
        password: prism

# 2. 原始策略组依然在首位
proxy-groups:
  - name: 🚀 节点选择              # 机场第一位主策略组完全不受干扰
    type: select
    proxies:
      - 🇸🇬新加坡01-专线
      - 🇯🇵日本01-专线
  # ... (其他机场策略组) ...

  # 3. 追加在末尾的 3 个专属手动单选策略组
  - name: Prism-环境-01
    type: select
    proxies:
      - DIRECT
      - 🇸🇬新加坡01-专线
      - 🇯🇵日本01-专线
  - name: Prism-环境-02
    type: select
    proxies:
      - DIRECT
      - 🇸🇬新加坡01-专线
      - 🇯🇵日本01-专线
  - name: Prism-环境-03
    type: select
    proxies:
      - DIRECT
      - 🇸🇬新加坡01-专线
      - 🇯🇵日本01-专线

# 4. 插入至顶部的 IN-USER 分流规则
rules:
  - IN-USER,node-0001,Prism-环境-01
  - IN-USER,node-0002,Prism-环境-02
  - IN-USER,node-0003,Prism-环境-03
  - DOMAIN-SUFFIX,google.com,🚀 节点选择
  - MATCH,DIRECT
```

---

## 7. Prism 浏览器环境中的代理参数填写

覆写生效后，在 Prism 浏览器对应环境设置中，配置如下网络代理即可生效：

| 环境编号 | 代理协议 | 代理主机 | 代理端口 | 用户名 | 密码 | 对应分流策略组 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **环境 1** | `HTTP` 或 `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0001` | `prism` | `Prism-环境-01` |
| **环境 2** | `HTTP` 或 `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0002` | `prism` | `Prism-环境-02` |
| **环境 3** | `HTTP` 或 `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0003` | `prism` | `Prism-环境-03` |

> **关键提醒**：
> 端口请填写专属监听端口 **`17890`**；主端口 `7897` 留给日常系统代理即可。

---

## 8. 常见踩坑与排查

#### Q: 保存脚本时提示 `listener 0: 'users[0]' expected a map, got 'string'`？
* **原因**：顶层 `users:` 可以是字符串数组（`['user:pass']`），但 `listeners:` 内部的 `users` 必须是对象结构体（Map），即 `{ username: '...', password: '...' }`。
* **解决**：确保脚本中使用的是本文第 3 节中提供的对象写法。

#### Q: 界面上切换了节点，重启 Clash Verge 会不会重置？
* **回答**：不会。脚本已显式注入 `config.profile['store-selected'] = true`，Clash Verge 内核会自动将您在每个策略组选择的节点持久化保存至 `cache.db`，重启或重新加载订阅均保留您的选择。
