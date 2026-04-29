# NAS Framework Patches

以下修改不在本仓库，直接应用在飞牛 NAS (`/vol1/@appcenter/trim.openclaw/` 和 `/vol1/@apphome/trim.openclaw/data/openclaw/`)。
**OpenClaw 升级后这些补丁会丢失，需要重新应用。**

## 1. server/index.js — 进程管理三个补丁

**路径**: `/vol1/@appcenter/trim.openclaw/server/index.js` (及 `index.cjs`)

### 1.1 isPidAlive: 跳过 zombie 进程

```javascript
function isPidAlive(pid) {
  if (!pid) { return false; }
  const pidNumber = Number(pid);
  if (!Number.isInteger(pidNumber) || pidNumber <= 0) { return false; }
  try {
    process.kill(pidNumber, 0);
    // PATCH: skip zombie processes
    if (!IS_WINDOWS) {
      try {
        const stat = require("fs").readFileSync("/proc/" + pidNumber + "/stat", "utf8");
        const state = stat.split(" ")[2];
        if (state === "Z" || state === "X") { return false; }
      } catch {}
    }
    return true;
  } catch { return false; }
}
```

### 1.2 collectGatewayBootstrapCandidates: 过滤非 openclaw 子进程

```javascript
async function collectGatewayBootstrapCandidates(instance, port, rootPid, watchPids) {
  const candidates = await listGatewayPids(instance, port);
  candidates.add(rootPid);
  for (const watchedPid of watchPids) {
    if (!isPidAlive(watchedPid)) { continue; }
    for (const relatedPid of await listProcessTreePids(watchedPid)) {
      if (relatedPid) {
        // PATCH: only include processes with "openclaw" in comm
        if (!IS_WINDOWS) {
          try {
            const comm = require("fs").readFileSync("/proc/" + relatedPid + "/comm", "utf8").trim();
            if (!comm.includes("openclaw")) continue;
          } catch {}
        }
        candidates.add(relatedPid);
      }
    }
  }
  return candidates;
}
```

### 1.3 filterValidatedGatewayPids: 竞态条件二次检查

在 `isLikelyOpenclawProcess(snapshot)` 返回 false 后，`emitLog` 之前插入：

```javascript
    if (!isPidAlive(pid)) {
      continue;
    }
```

完整函数：
```javascript
async function filterValidatedGatewayPids(pids, enqueue, warnedPids) {
  const validated = new Set;
  for (const pid of pids) {
    if (!isPidAlive(pid)) { continue; }
    const snapshot = await describeProcess(pid);
    if (isLikelyOpenclawProcess(snapshot)) {
      validated.add(pid);
      continue;
    }
    // PATCH: re-check after describeProcess (race condition)
    if (!isPidAlive(pid)) { continue; }
    const detail = snapshot?.commandLine || snapshot?.executablePath || "unknown process";
    if (!warnedPids || !warnedPids.has(pid)) {
      warnedPids?.add(pid);
      emitLog(enqueue, "error", `Refusing to signal PID ${pid} because it is not recognized as an OpenClaw process: ${detail}`);
    }
  }
  return validated;
}
```

## 2. plugin-sdk/index.js — 缺失 SDK 导出

**路径**: `/vol1/@apphome/trim.openclaw/data/openclaw/node_modules/openclaw/dist/plugin-sdk/index.js`

原文件只有 5 行导出，以下为手动追加：

```javascript
export { resolvePreferredOpenClawTmpDir } from "./diffs.js";
export { readJsonFileWithFallback } from "./feishu.js";
export { withFileLock } from "./file-lock.js";
export { writeJsonFileAtomically } from "./json-store.js";
export { DEFAULT_ACCOUNT_ID } from "./account-core.js";
export { addWildcardAllowFrom, formatPairingApproveHint } from "./bluebubbles.js";
export { buildChannelConfigSchema } from "./channel-config-schema.js";
```

## 3. plugin-runtime-deps 权限修复

```bash
chown -R trim.openclaw:trim.openclaw /vol1/@apphome/trim.openclaw/data/home/.openclaw/plugin-runtime-deps/
```

症状：`EACCES: permission denied, unlink '.../plugin-runtime-deps/.../qqbot/api.js'`
原因：目录被 bemly 拥有，gateway (trim.openclaw) 无写权限

## 4. openclaw-qqbot symlink

```bash
ln -s /vol1/@apphome/trim.openclaw/data/openclaw/node_modules/openclaw \
      /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-qqbot/node_modules/openclaw
chown -h trim.openclaw:trim.openclaw /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-qqbot/node_modules/openclaw
```

消除 `[preload] WARNING: could not find openclaw global installation, symlink not created`

## 5. 官方插件 channelConfigs

为 4 个官方插件添加 `channelConfigs` 到 `openclaw.plugin.json`：
- `/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/dingtalk-connector/openclaw.plugin.json`
- `/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-qqbot/openclaw.plugin.json`
- `/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-weixin/openclaw.plugin.json`
- `/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/wecom-openclaw-plugin/openclaw.plugin.json`

每个添加空 `channelConfigs` 结构 (schema 留空，仅消除 Config warnings)。

---

## 一键重打所有补丁

```bash
# SSH 到 NAS 后执行（需用 bemly + sudo）
NAS_IP=192.168.1.162
PASS='mt;4v8M2<H#O3xU'

sshpass -p "$PASS" ssh fnOS '
# 1. 验证/重打 server/index.js 三个补丁
echo "检查 server/index.js 补丁..."
# 如果 isPidAlive 没有 zombie 检查则重打
# 如果 collectGatewayBootstrapCandidates 没有 comm 过滤则重打
# 如果 filterValidatedGatewayPids 没有二次 isPidAlive 则重打

# 2. 验证/重打 plugin-sdk/index.js 导出
echo "检查 SDK 导出..."

# 3. 修复 plugin-runtime-deps 权限
chown -R trim.openclaw:trim.openclaw /vol1/@apphome/trim.openclaw/data/home/.openclaw/plugin-runtime-deps/

# 4. 创建 openclaw-qqbot symlink
ln -sf /vol1/@apphome/trim.openclaw/data/openclaw/node_modules/openclaw \
  /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-qqbot/node_modules/openclaw
chown -h trim.openclaw:trim.openclaw /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/openclaw-qqbot/node_modules/openclaw
'
```
