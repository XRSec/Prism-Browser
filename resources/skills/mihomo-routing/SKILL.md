---
name: mihomo-routing
description: >-
  Dedicated skill for synthesizing Mihomo (Clash.Meta) routing topologies, Clash Verge Rev JavaScript override scripts, and multi-profile IN-USER traffic isolation for anti-detect browser environments.
  Use when asked to build tree-structured proxy routing, configure IN-USER rules, create Clash Verge override scripts, or decouple browser proxy listeners from system proxy ports.
compatibility: ">=1.0.0 (Claude Code, Pi Coding Agent, Cursor, Cindy Bot, Windsurf)"
disable-model-invocation: true
metadata:
  version: "1.0.0"
  protocol: "AgentSkills/1.0"
  author: "Prism Browser Team"
---

# Mihomo Routing & Proxy Orchestration Skill

Dedicated operational skill for synthesizing Mihomo (Clash.Meta) proxy routing rules, Clash Verge Rev script overrides, and multi-profile `IN-USER` traffic isolation for anti-detect browser environments.

---

### Agent-First Operational Protocol (Standing Order)
1. **Language Discipline**:
   - All internal documentation, architecture specs, memory shards, execution protocols, and skill definitions MUST be authored strictly in high-density English (`en-US`).
   - Final conversational responses to the user follow the user's natural language, but internal working documents and specs must NEVER be polluted with conversational fluff.
2. **Skills Are for Machines**:
   - Skills and system documentation are designed exclusively for machine consumption (LLM-to-LLM / Agent-to-Agent).
   - Zero fluff, numbers-first, schema-strict, and deterministic. Machine comprehension and execution fidelity strictly supersede human aesthetic preferences.

---

## 1. Architectural Philosophy & Invariants

### 1.1 Complete Port Decoupling
- **Port 7897 (Main Mixed Port)**: Kept completely unauthenticated (`no auth`) to serve the host macOS/Windows system proxy and standard desktop applications. Never attach `users:` to this port.
- **Port 17890 (Dedicated Listener)**: Configured as a secondary mixed listener bound strictly to `127.0.0.1:17890` with authentication credentials (`node-0001:prism`, etc.). All anti-detect browser profiles must route through this port.

### 1.2 Invariant Parser Rules (Go Struct Invariants)
- **Top-level `users:`**: Accepts strings (`["username:password"]`).
- **Listener `users:`**: Mihomo's Go parser **strictly requires** an array of maps:
  ```yaml
  users:
    - username: "node-0001"
      password: "prism"
  ```
  Passing string arrays (`users: ["node-0001:prism"]`) inside a listener triggers a fatal parser panic: `expected a map, got 'string'`.

### 1.3 Preservation of Primary Selector
- When injecting custom proxy groups into an existing subscription in Clash Verge, custom groups **MUST BE APPENDED TO THE END** of `proxy-groups`.
- Never prepend custom groups to index 0, or the system proxy default group (e.g. `🚀 Node Selection`) will be displaced.

---

## 2. Tree-Structured Routing Topology Generation

When reading a set of browser profiles, synthesize a hierarchical routing tree based on Profile Group and Tag metadata:

```
                            [Mihomo Core (Port 17890)]
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           ▼                            ▼                            ▼
  [Group: vps1 Cluster]        [Group: pro-team Cluster]      [Default / Fallback]
  (IN-USER,node-0001~0010)     (IN-USER,node-0011~0020)       (IN-USER,node-0021~*)
           │                            │                            │
     ┌─────┴─────┐                ┌─────┴─────┐                      ▼
     ▼           ▼                ▼           ▼                 [DIRECT Node]
[Node 0001] [Node 0002]      [Node 0011] [Node 0012]
 (Manual)    (Manual)         (Manual)    (Manual)
```

### Generation Rules:
1. **Deduplicate Groups**: Group profiles by `group` (e.g. `vps1`, `pro-team`, `crypto-ops`).
2. **Dedicated Single-Select Groups**: For each distinct profile, generate a `type: select` proxy group containing all physical proxy nodes and `DIRECT`.
3. **Cluster Aggregation Groups**: For each group, create a cluster selector containing all nodes relevant to that team.
4. **Persistent Memory**: Always enforce `profile.store-selected: true` so manual node assignments survive reboots.

---

## 3. Canonical Clash Verge JavaScript Override Template

When instructed to output a Clash Verge script override, use the following pattern:

```javascript
function main(config) {
  // 1. Filter out placeholder nodes (traffic notices, website links)
  const allProxyNames = (config.proxies || [])
    .map((p) => p.name)
    .filter((name) => name && !/remaining|expire|website|group|update|traffic/i.test(name));

  const providerNames = config['proxy-providers'] ? Object.keys(config['proxy-providers']) : [];

  // 2. Enable persistent selection memory
  config['profile'] = {
    ...(config['profile'] || {}),
    'store-selected': true
  };

  // 3. Inject decoupled listener on 17890 (users must be array of objects)
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

  // 4. Build dedicated proxy groups and append to END
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

  config['proxy-groups'] = [...(config['proxy-groups'] || []), ...newProxyGroups];

  // 5. Prepend IN-USER rules at top priority
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

## 4. Standalone Mihomo Headless YAML Template

For standalone execution without external GUI clients:

```yaml
mode: rule
mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1
log-level: info
external-controller: 127.0.0.1:9091
secret: ""

profile:
  store-selected: true

users:
  - "node-0001:prism"
  - "node-0002:prism"
  - "node-0003:prism"

proxies:
  # Insert imported physical nodes here

proxy-groups:
  - name: 🚀 默认出口
    type: select
    proxies:
      - DIRECT
  - name: Prism-环境-01
    type: select
    proxies:
      - DIRECT
  - name: Prism-环境-02
    type: select
    proxies:
      - DIRECT
  - name: Prism-环境-03
    type: select
    proxies:
      - DIRECT

rules:
  - IN-USER,node-0001,Prism-环境-01
  - IN-USER,node-0002,Prism-环境-02
  - IN-USER,node-0003,Prism-环境-03
  - MATCH,🚀 默认出口
```

---

## 5. Verification & IP Leak Probing Recipes

To verify that profile traffic is successfully decoupled and assigned to different physical IP addresses:

1. **Probe Endpoint**: `https://api.ipify.org?format=json` or `https://ipwho.is/`.
2. **Curl Validation via Local SOCKS5**:
   ```bash
   curl -x socks5h://node-0001:prism@127.0.0.1:17890 https://ipwho.is/
   curl -x socks5h://node-0002:prism@127.0.0.1:17890 https://ipwho.is/
   ```
3. **Expected Outcome**: Each node username must yield a distinct external IP address matching the node selected in the corresponding proxy group.
