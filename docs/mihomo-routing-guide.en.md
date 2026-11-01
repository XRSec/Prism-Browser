# Prism Browser & Mihomo Local Multi-Profile Proxy Routing Guide

> This guide is designed for developers and power users requiring **multi-account fingerprint isolation, anti-association, and precise outbound IP allocation**.
> Whether you already use Clash / Flclash / Clash Verge, or only use Shadowrocket or manual config files, this guide provides the leanest and highest-performance routing patterns.

---

## 1. Why We Do Not Bundle Mihomo Binaries by Default

Prism Browser deliberately **does not bundle or package third-party proxy binaries directly into the application distribution**. Here is why:

1. **Security & Antivirus False Positive Isolation**:
   Low-level proxy cores (especially those utilizing TUN interfaces or system routing interception) frequently trigger false positives in Windows Defender, macOS Gatekeeper, or enterprise EDR solutions. A false quarantine of an embedded binary could corrupt the main application bundle.
2. **Open-Source Boundaries**:
   Mihomo (Clash.Meta) is an independent open-source project. Decoupling execution respects the original project's distribution guidelines.
3. **Complete Version Autonomy**:
   Different users depend on varying protocol implementations (e.g. VLESS, Hysteria2, Tuic, Reality). Allowing users to specify their own binary path empowers them to use official stable releases, alpha builds, or custom hardware-accelerated builds without being locked to an outdated version.
4. **Transparent Official Distribution**:
   - **Mihomo Official Releases**: [https://github.com/MetaCubeX/mihomo/releases](https://github.com/MetaCubeX/mihomo/releases)
   - **Recommended Version**: Download the stable release for your architecture (`mihomo-darwin-arm64` or `mihomo-windows-amd64`), unpack it, and store it anywhere on your system.

---

## 2. Decision Tree: Choosing the Best Scenario

Select the cleanest implementation path based on your existing local setup:

```
                         [What proxy software do you currently use?]
                                             │
         ┌───────────────────────────────────┴───────────────────────────────────┐
         ▼                                                                       ▼
  [Scenario A: Existing Clash / Flclash / Verge]              [Scenario B: No Clash / Shadowrocket Only]
  • Do NOT run an additional background client!               • Do NOT install a bloated new GUI client!
  • Best path: [Script / Override Mode]                       • Best path: [Prism 2-Field Lightweight Hosting]
  • Paste Prism's JS override script into your client         • Configure: [Binary Path] + [Config File Path]
  • Subscriptions update dynamically; Prism rules persist     • Auto-starts and terminates with Prism cleanly
```

### Scenario A: You Already Have Flclash / Clash Verge Rev / Mihomo Party
> **Core Principle: Leverage client "Override / Script" mode to dynamically merge configurations without touching original subscriptions.**

* **The Problem**: Airport subscriptions update periodically. Editing the downloaded `config.yaml` directly causes custom rules to be wiped out whenever the subscription refreshes.
* **The Solution: Script / Override Mode**:
  * **Flclash**: `Settings -> Override -> Script / Merge`
  * **Clash Verge Rev**: `Profiles -> New (top right) -> Type: Script -> Enable`
  * **Mihomo Party**: `Overrides -> New JavaScript Override`
* **Mechanism**: The client dynamically synthesizes the airport nodes with Prism's user-based routing rules in memory. **Airport nodes refresh freely while Prism routing rules remain permanent.**

---

### Scenario B: You Do Not Use Clash (Shadowrocket Only or Manual Config)
> **Core Principle: Prism hosts a clean, headless, ultra-low-memory background core.**

* **How It Works (Only 2 Fields Needed)**:
  1. **Field 1 [Mihomo Binary Path]**: E.g. `/opt/homebrew/bin/mihomo` or `C:\tools\mihomo.exe`.
  2. **Field 2 [Config File Path]**: Select any existing subscription file or YAML export.
* **Under the Hood**:
  * Prism reads your template, applies user routing patches in memory, and writes the synthesized file safely to your local vault:
    * macOS: `~/Library/Application Support/prism-browser/vault/mihomo/config.yaml`
    * Windows: `%APPDATA%\prism-browser\vault\mihomo\config.yaml`
  * Mihomo is spawned in the background with isolated directory flags:
    ```bash
    mihomo -d "<vault>/mihomo" -f "<vault>/mihomo/config.yaml"
    ```
  * When Prism exits, the background process terminates cleanly without leaving orphan processes or altering system proxy settings.

---

## 3. Why Passwords Can Be Unified: The Technical Truth Behind IN-USER

Many users assume proxy passwords need to be complex random strings. On a local loopback (`127.0.0.1`), this is unnecessary.

### 1. Loopback Interface Security (`127.0.0.1`)
* Prism enforces `bind-address: 127.0.0.1` and `allow-lan: false`.
* The proxy port is accessible **strictly from the local machine**; LAN and WAN access is rejected at the socket layer.
* Local ports are not exposed to brute-force attacks. **A uniform password (e.g. `prism`) serves purely as a protocol placeholder**.

### 2. The True Purpose of Username: "Routing Tag"
When you configure a proxy for a Profile:
`socks5://node-0001:prism@127.0.0.1:17890`
The string `node-0001` acts as a **traffic dye tag** injected into inbound connections on port 17890.

### 3. Routing Specific Profiles to Specific Outbounds
At the top of Mihomo's `rules` section, declare `IN-USER` rules:

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
  # 1. Route specific profiles to specific nodes
  - IN-USER,node-0001,🇺🇸 US-Dedicated-01
  - IN-USER,node-0002,🇯🇵 JP-Dedicated-02

  # 2. Route an entire Pro team to a dedicated group
  - IN-USER,pro-group-*,🚀 Pro-Dedicated-Group

  # 3. Fallback to direct or default policy
  - MATCH,DIRECT
```

---

## 4. Web UI Dashboards: Purpose and Direct Links

### 1. What Does the Dashboard Do?
Mihomo is a headless background daemon. **Dashboards (e.g. Zashboard or MetaCubeXD) are decoupled single-page web applications** that communicate with the local `127.0.0.1:9090` external controller via WebSockets and REST APIs:
1. **Latency & Speed Measurement**: Test real-time connection status across all nodes.
2. **Manual Outbound Switching**: Instantly switch the active node for any proxy group.
3. **Connection Diagnostics**: Monitor active TCP connections, traffic rates, and session durations per profile.

### 2. Direct Dashboard Links
* **jsDelivr CDN (Zero Download, Instant Access)**:
  `https://cdn.jsdelivr.net/gh/Zephyruso/zashboard@gh-pages/?host=127.0.0.1&port=9090#/proxies`
* **Local Offline UI (Requires extraction to `vault/mihomo/ui/`)**:
  `http://127.0.0.1:9090/ui/?host=127.0.0.1&port=9090#/proxies`
  * Offline bundle download: [https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip](https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip)
* **Official Hosted Instances**:
  - Zashboard: [https://board.zash.run/#/setup](https://board.zash.run/#/setup)
  - MetaCubeXD: [https://metacubex.github.io/metacubexd/](https://metacubex.github.io/metacubexd/)

---

## 5. AI Agent Prompt Recipes

If you use Claude Code, Pi Coding Agent, Cursor, or Cindy, you can provide these prompt recipes directly:

### Prompt Recipe 1: Batch-Configure Profiles to Local Proxy Port
```text
Use Prism's profile batch update tool to configure proxy settings for all target browser profiles to the local Mihomo port:
- Protocol: SOCKS5 (or HTTP)
- Host: 127.0.0.1
- Port: 17890 (or 7897)
- Password: prism
- Username: auto-fill based on profile index (e.g. Profile #28 -> node-0028)
- Bypass list: preserve default localhost;127.0.0.1
```

### Prompt Recipe 2: Generate JavaScript Override Script for Clash Verge
```text
Read the names and indices of all existing Prism profiles, generate matching Mihomo users credentials and IN-USER routing rules, and produce a JavaScript extension script ready to paste into Clash Verge / Flclash.
```

---

## 6. How to View Locally

This document is version-controlled inside the repository:
- **Relative Path**: `docs/mihomo-routing-guide.en.md`
- **macOS View Command**:
  ```bash
  open "docs/mihomo-routing-guide.en.md"
  ```
- **Windows View Command**:
  ```powershell
  start docs\mihomo-routing-guide.en.md
  ```
Inside the Prism Browser desktop app, click **[Clash Verge Guide]** or **[General Routing Guide]** at the top of the Mihomo Assistant modal to open the guide in your default markdown viewer.
