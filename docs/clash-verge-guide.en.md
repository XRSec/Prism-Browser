# Prism Browser & Clash Verge (Rev) Dedicated Routing Integration Guide

> This guide provides a complete multi-profile independent proxy node routing solution based on **Script Override** mode for users of the **Clash Verge (Rev)** client.
> **Key Benefits**: Zero tampering with airport subscriptions, dynamic updates without losing custom rules, physical decoupling between system port and Prism port, intuitive node selection in the Verge GUI, and persistent node memory across restarts.

---

## 1. Core Architecture & Design Philosophy

In Clash Verge, the most elegant multi-profile isolation approach is not modifying the downloaded subscription YAML file directly, but dynamically composing configurations in memory using **Script (JavaScript extension scripts)**.

```
                    ┌── [Port 7897 (No Auth)] ──────> For macOS system proxy & daily apps, uses default policy
[Clash Verge Core] ──┤
                    └── [Port 17890 (Users Auth)] ──> For Prism profiles, routed via IN-USER rules to dedicated groups
                                                                │
                                   ┌────────────────────────────┼────────────────────────────┐
                                   ▼                            ▼                            ▼
                          [Prism-Profile-01 Group]     [Prism-Profile-02 Group]     [Prism-Profile-03 Group]
                          (Manual select in Verge UI)   (Manual select in Verge UI)   (Manual select in Verge UI)
```

### Why Use This Architecture?
1. **Complete Port Decoupling**: The main port (`7897`) remains completely unauthenticated, preventing macOS system proxies or RFC 1928 SOCKS5 handshakes from failing with auth errors or connection resets. Port `17890` is bound as a dedicated listener strictly for Prism profile traffic.
2. **Appended to `proxy-groups` End**: The custom profile proxy groups are appended to the *end* of the `proxy-groups` array, preserving the airport's original top-level default group (e.g. `🚀 Node Selection`) as the primary system selector.
3. **Pure Manual Selection with Persistence**: Proxy groups use `type: select` without automatic latency switching, and `profile.store-selected: true` is enabled to retain chosen nodes permanently across system restarts.

---

## 2. Clash Verge 5 Core Configuration Files Explained

Clash Verge Rev configuration is driven by 5 coordinated configuration files:

| File Name | Physical Path (macOS: `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/`) | Role & Contents |
| :--- | :--- | :--- |
| **`clash-verge.yaml`** | Root directory | **👑 Effective Runtime Configuration**.<br>The final compiled configuration dynamically aggregated from airport subscriptions, Script overrides, Merge patches, and DNS configurations. This is the exact file read and executed by the Mihomo core. Inspect this file to verify rule hits. |
| **`profiles.yaml`** | Root directory | **📋 Subscription & Script Registry Metadata**.<br>Tracks remote subscription URLs, local files, Merge rules, Script extensions, active subscription UID (`current: xxxx`), and auto-update intervals. |
| **`config.yaml`** | Root directory | **⚙️ Core Template**.<br>Defines primary listen ports (`mixed-port: 7897`), external controller endpoint (`external-controller: 127.0.0.1:9090`), API secret key, CORS whitelist, and log levels. |
| **`dns_config.yaml`** | Root directory | **🌐 Standalone DNS Override Rules**.<br>Controls the DNS module, Fake-IP settings, domestic upstream servers (Alibaba/Tencent DNS), and overseas Cloudflare DoH upstream servers. |
| **`verge.yaml`** | Root directory | **🖥️ Application GUI Preferences**.<br>Governs window geometry, auto-start on boot, system proxy toggle, light/dark themes, and tray icon styles. |

---

## 3. Proxy Providers vs. Traditional Subscriptions

Users frequently confuse Proxy Providers with traditional Subscriptions. The key difference lies in **control ownership**:

```
                      Traditional Airport Subscription              Mihomo Proxy Providers
                      ────────────────────────────────              ──────────────────────
Data format:          Bundled package (YAML file)                   Pure node data pool (Raw Node List)
Included content:     Proxies + Rules + Proxy Groups                Physical node list only
Local control:        Controlled by airport (wiped on update)       Full local control over rules & groups
Routing stability:    Poor: manual IN-USER rules erased on update   Excellent: rules & groups static, nodes update dynamically
Best form in Verge:   Use [Script Override] for dynamic patch       Declare `use: [provider_name]` directly
```

- **Traditional Subscriptions** bundle nodes, groups, and rules together. Updating the subscription replaces the entire configuration, erasing custom routing rules.
- **Proxy Providers** treat the airport as a node repository. Fresh nodes are pulled while local routing rules and proxy groups remain intact.
- **Why Script Override?** Most Clash Verge users import traditional bundled subscriptions. **Script Override delivers the permanence of Proxy Providers on top of regular subscriptions without altering remote sources!**

---

## 4. Web UI Dashboard URL Parameter Specification

The Mihomo external controller interface (`127.0.0.1:9090`) supports multiple modern Web dashboards. Use the following standard parameter format for direct connection:

| Dashboard Name | URL Format |
| :--- | :--- |
| **Zashboard** (Official Online) | `https://board.zash.run.place/#/setup?http=true&hostname=127.0.0.1&port=9090&secret=[REDACTED_CREDENTIAL]` |
| **MetaCubeXD** (Official Online) | `https://metacubex.github.io/metacubexd/#/setup?http=true&hostname=127.0.0.1&port=9090&secret=[REDACTED_CREDENTIAL]` |
| **YACD** (Classic Dashboard) | `https://yacd.metacubex.one/?hostname=127.0.0.1&port=9090&secret=[REDACTED_CREDENTIAL]` |
| **Local Offline UI** | `http://127.0.0.1:9090/ui/#/setup?hostname=127.0.0.1&port=9090&secret=[REDACTED_CREDENTIAL]` |

> **Key Parameters**:
> 1. **`http=true`**: Required for HTTPS-hosted dashboards (e.g. GitHub Pages) connecting to plain HTTP loopbacks (`127.0.0.1`) to prevent mixed-content blocking.
> 2. **Hash Router**: Zashboard and MetaCubeXD use client-side SPA routing; parameters must appear after `/#/setup?`.

---

## 5. Complete JavaScript Override Script (Clash Verge Script)

In Clash Verge: navigate to **Profiles -> New (top right) -> Type: Script**, set a name (e.g. `Prism-Routing`), edit, and paste the code below:

```javascript
// ====================================================================
// Prism Browser & Clash Verge: Decoupled Listener + 3 Independent Groups
// ====================================================================
function main(config) {
  // 1. Filter valid physical proxy nodes (excluding notice placeholders)
  const allProxyNames = (config.proxies || [])
    .map((p) => p.name)
    .filter((name) => name && !/remaining|expire|website|group|update|traffic/i.test(name));
  
  const providerNames = config['proxy-providers'] ? Object.keys(config['proxy-providers']) : [];

  // 2. Enable persistent selection memory
  config['profile'] = {
    ...(config['profile'] || {}),
    'store-selected': true
  };

  // 3. Core Decoupling: Bind dedicated 17890 listener for Prism
  // In listeners, users must be an array of objects: [{ username, password }]
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

  // 4. Generate 3 dedicated manual selection proxy groups
  const prismGroupNames = ['Prism-Environment-01', 'Prism-Environment-02', 'Prism-Environment-03'];
  const newProxyGroups = prismGroupNames.map((groupName) => {
    const group = {
      name: groupName,
      type: 'select',
      proxies: ['DIRECT', ...allProxyNames]
    };
    if (providerNames.length > 0) group.use = providerNames;
    return group;
  });

  // 5. Append to proxy-groups end (preserving original top primary group)
  config['proxy-groups'] = [...(config['proxy-groups'] || []), ...newProxyGroups];

  // 6. Prepend IN-USER routing rules at top priority
  const prismRules = [
    'IN-USER,node-0001,Prism-Environment-01',
    'IN-USER,node-0002,Prism-Environment-02',
    'IN-USER,node-0003,Prism-Environment-03'
  ];
  config.rules = [...prismRules, ...(config.rules || [])];

  return config;
}
```

---

## 6. Structure Comparison: Before vs. After Override

### Before: Raw Subscription YAML Excerpt
```yaml
mode: rule
mixed-port: 7897
allow-lan: false
proxies:
  - name: 🇸🇬 SG-Line-01
    type: vless
    server: ...
  - name: 🇯🇵 JP-Line-01
    type: vless
    server: ...
proxy-groups:
  - name: 🚀 Node Selection
    type: select
    proxies:
      - 🇸🇬 SG-Line-01
      - 🇯🇵 JP-Line-01
rules:
  - DOMAIN-SUFFIX,google.com,🚀 Node Selection
  - MATCH,DIRECT
```

### After: Generated Runtime Configuration (`clash-verge.yaml`) Excerpt
```yaml
mode: rule
mixed-port: 7897                  # Main port remains unauthenticated for macOS system proxy
profile:
  store-selected: true            # Persists user selection across app restarts

# 1. Injected dedicated listener on 17890 with user credentials
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

# 2. Original primary group remains at index 0
proxy-groups:
  - name: 🚀 Node Selection
    type: select
    proxies:
      - 🇸🇬 SG-Line-01
      - 🇯🇵 JP-Line-01

  # 3. Dedicated groups appended at the end
  - name: Prism-Environment-01
    type: select
    proxies:
      - DIRECT
      - 🇸🇬 SG-Line-01
      - 🇯🇵 JP-Line-01
  - name: Prism-Environment-02
    type: select
    proxies:
      - DIRECT
      - 🇸🇬 SG-Line-01
      - 🇯🇵 JP-Line-01
  - name: Prism-Environment-03
    type: select
    proxies:
      - DIRECT
      - 🇸🇬 SG-Line-01
      - 🇯🇵 JP-Line-01

# 4. Injected IN-USER rules at top priority
rules:
  - IN-USER,node-0001,Prism-Environment-01
  - IN-USER,node-0002,Prism-Environment-02
  - IN-USER,node-0003,Prism-Environment-03
  - DOMAIN-SUFFIX,google.com,🚀 Node Selection
  - MATCH,DIRECT
```

---

## 7. Profile Proxy Configuration in Prism Browser

Configure the following proxy settings inside each Prism Browser profile:

| Profile No. | Protocol | Host | Port | Username | Password | Target Proxy Group |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Profile 1** | `HTTP` or `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0001` | `prism` | `Prism-Environment-01` |
| **Profile 2** | `HTTP` or `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0002` | `prism` | `Prism-Environment-02` |
| **Profile 3** | `HTTP` or `SOCKS5` | `127.0.0.1` | **`17890`** | `node-0003` | `prism` | `Prism-Environment-03` |

> **Notice**:
> Always configure port **`17890`** for Prism profiles; keep port `7897` reserved for general macOS system proxy.

---

## 8. Troubleshooting

#### Q: Clash Verge reports error `listener 0: 'users[0]' expected a map, got 'string'`?
* **Cause**: Top-level `users:` accepts string arrays (`['user:pass']`), but inside `listeners:`, Mihomo's Go parser requires an array of structs (`[{ username: "...", password: "..." }]`).
* **Fix**: Ensure your script passes an array of objects as shown in Section 5.
