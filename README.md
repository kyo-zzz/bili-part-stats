# Bilibili 分P数据补全

> 在 B 站视频**标题正下方**补齐「每个分 P」的弹幕数与在线观看人数，补回官方改版后丢失的展示。
> 单文件 Tampermonkey 脚本，零依赖、零构建，复制到浏览器即用。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-green.svg)](./scripts/bilibili-part-stats.user.js)
[![tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-orange.svg)](https://www.tampermonkey.net/)

---

## 背景

B 站改版之后，视频标题下方那一栏只剩**全片总量**的播放/弹幕/收藏。对于多分 P 的视频，
你只能看到一个笼统的总数，**每个分 P 各自有多少弹幕、此刻有多少人在看** —— 官方已经不显示了。

本脚本把这部分信息补回来，并且**不加任何自己的数据**：只用页面本身已经加载的内容，
加上 B 站播放器自己就在调用的公开接口。

## 效果

```
【标题】某多分P视频 ……
 ┌─────────────────────────────────────────────────────────────┐
 │  P3 · 第三集   │  弹幕 1.2万  │  在线 3,214  │  全部分P(12) ▾ │ 统计全部分P │ 刷新 │ × │
 └─────────────────────────────────────────────────────────────┘
 ┌─ 展开后 ─────────────────────────────────────────────────────┐
 │ 分P    标题              时长     弹幕数    在线观看          │
 │ P1     第一集           05:32   8,402     1,024             │
 │ P2     第二集           04:18     9,130      892             │
 │ P3 *   第三集           06:05    12,408     3,214   ← 当前   │
 │ ...                                                          │
 └──────────────────────────────────────────────────────────────┘
```

点击任意一行直接跳到那个分 P，走 B 站自己的 SPA 路由，不整页刷新。

## 功能

| 能力 | 说明 |
|---|---|
| 当前分 P 弹幕数 | 精确值。按 B 站弹幕分段接口逐段累加得出 |
| 当前分 P 在线观看人数 | 尽力而为；端点下线时诚实显示 `—`，不编造 |
| 全部分 P 明细表 | 一表看全片，含时长 / 弹幕数 / 在线人数 |
| 点击行跳转 | 走 SPA 路由，不打断观看 |
| 结果缓存 | 弹幕数 15 分钟、在线人数 60 秒，来回切分 P 不重复打接口 |
| SPA 感知 | 切视频、切分 P 自动同步，不需要手动刷新 |
| 单文件 | 一个 `.user.js`，没有构建步骤 |

弹幕数列里带 `⁺` 上标的数字表示**被请求上限截断的下界**（真实值 ≥ 该数），不是精确值。

## 安装

分两步：先装 Tampermonkey，再装本脚本。

### 第 1 步 · 装 Tampermonkey（Edge 版）

1. 打开 Edge 扩展商店：<https://microsoftedge.microsoft.com/addons/detail/tampermonkey/ocjgelalgjbkfjkfnajmaekdlagpkhbj>
2. 点「获取」安装 **Tampermonkey**。
3. 装好后 Edge 右上角拼图图标里会出现 Tampermonkey，点它 →「固定到工具栏」。

> 说明：Tampermonkey 是脚本管理器扩展，你以后写的所有油猴脚本都由它来运行。
> 火狐 / Chromium 系浏览器也有各自版本，脚本内容完全通用。

### 第 2 步 · 装本脚本（任选一种）

**方式 A · 粘 raw 地址（推荐，之后能自动更新）**

1. 点上面徽章里的脚本链接，或打开
   <https://raw.githubusercontent.com/kyo-zzz/bili-part-stats/main/scripts/bilibili-part-stats.user.js>
2. 页面上会出现 Tampermonkey 的绿色安装提示，点「安装」。

**方式 B · 上传文件**

1. 把 `scripts/bilibili-part-stats.user.js` 下载到本地。
2. 点击 Tampermonkey 图标 →「添加新脚本」（`+`）。
3. 把文件内容全部粘贴进去（或直接把文件拖到页面上），保存。

**方式 C · 本地安装**

Tampermonkey 图标 →「仪表盘」（Dashboard）→「从本地安装」→ 选 `.user.js` 文件。

装完打开任意**多分 P** 视频页即可看到标题下方多出的那一行。

---

## 上传到 GitHub

下面三种方式任选一种。

### 方式 A · GitHub 网页上传（最快）

1. 登录 <https://github.com> → 右上角 `+` →「New repository」。
2. Repository name 填 `bili-part-stats`，Visibility 选 **Public**（要开源就得选 Public）。
3. 勾选「Add a README file」和「Add or select a .gitignore」(选 None 即可)，点 Create。
4. 进入新仓库 →「Add file」→「Upload files」→ 把整个仓库文件夹里的文件拖进去。
   注意 `.gitignore` 这类点开头的文件在拖拽时会隐藏，需要确认它被一起传上去了。
5. Commit。GitHub 会根据仓库里的 `LICENSE` 自动识别为 MIT。

### 方式 B · gh CLI（已登录的话最快）

```bash
gh repo create kyo-zzz/bili-part-stats --public --clone
cd bili-part-stats
git add .
git commit -m "init: 分P数据补全 userscript"
git push -u origin main
```

### 方式 C · 原生 git

```bash
cd bili-part-stats
git init
git add .
git commit -m "init: 分P数据补全 userscript"
git branch -M main
git remote add origin git@github.com:kyo-zzz/bili-part-stats.git
git push -u origin main
```

> 上传完成后，方式 A 里那个 `raw.githubusercontent.com` 链接才会生效，
> 用户（包括你自己）就能通过粘贴地址来安装，并且以后你更新脚本时会自动提示升级。

## 使用

- 顶部行默认显示**当前分 P** 的弹幕数与在线人数。
- 「全部分P（N）」展开明细表；「统计全部分P」会逐 P 排队统计（每个 P 约 5~20 次请求，会限速）。
- 「刷新」丢弃缓存重新取数。
- 「×」关闭本次显示，并写入设置，下次进页面不再显示；想恢复就用 Tampermonkey 菜单里的「显示 / 隐藏面板」。
- Tampermonkey 图标菜单里还有：`刷新当前视频数据`、`立即统计全部分P`、`显示 / 隐藏面板`。

## 配置项

默认值写在脚本顶部的 `DEFAULTS`，改起来就是改一个对象：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoAllParts` | `false` | 打开视频时是否自动统计全部分 P |
| `cacheMin` | `15` | 弹幕数缓存分钟数 |
| `viewersTtlSec` | `60` | 在线人数缓存秒数 |
| `maxSegCalls` | `80` | 单个分 P 最多拉取的分段数（超过则标记为下界） |
| `concurrency` | `2` | 同时统计的分 P 数量 |
| `paceMs` | `120` | 同一分 P 相邻两次请求的间隔（限速用） |

## 已知限制

- **在线观看人数大概率显示 `—`。** 该数据的历史来源端点已下线。脚本采取「尽力而为 + 熔断」：
  取不到就显示 `—`，不编造数字。若该端点日后恢复或你找到了新端点，欢迎提 issue。
- **弹幕数由分段累加得出。** 因为 `/x/v1/dm/list.so` 存在 1200 条硬上限，
  直接用它计数会严重低估，所以本脚本按弹幕分段逐段累加。
- 单个分 P 的请求量与「把这一集从头看到尾时播放器自己拉取弹幕」的量级相当，并带限速。
  弹幕数会随时间增长，缓存期内可能落后于真实值。
- 分 P 弹幕数被 `maxSegCalls` 截断时，显示为下界并带 `⁺` 上标。
- 会员番剧 / 付费内容 / 被风控的视频，对应分 P 显示 `—`。
- 单分 P 视频也会显示（弹幕数即总弹幕数），但不显示「全部分P」按钮。

## 法律与合规声明

本脚本依赖的 B 站接口并非官方公开文档接口。类似的第三方 B 站接口文档仓库
已于 2026 年因 B 站律师函永久关停，说明这类内容存在被要求下架的现实风险。

脚本仅在你的浏览器内以你自己的登录态运行，无服务端转发、不落库、不共享数据；
但公开仓库本身包含接口路径与参数结构，这一点无法回避。
**个人自用风险相对低，公开分发请自行评估，本人不承担由此产生的责任。**

## 常见问题

**Q：为什么在线人数一直是 `—`？**
端点已下线。见「已知限制」，欢迎提 issue 提供新端点。

**Q：弹幕数后面那个 `⁺` 是什么？**
表示这个数是被 `maxSegCalls` 截断的**下界**，真实值大于等于它。
说明该分 P 弹幕极多、分段数超过了上限。把 `maxSegCalls` 调大可以拿精确值，代价是更多请求。

**Q：会不会拖慢页面 / 被 B 站封号？**
默认情况下每个视频只统计**当前正在看的那一个分 P**（约 5~20 次请求，间隔 120ms），
和播放器自己加载弹幕的量级相当。`paceMs` 和 `concurrency` 都已调小以避免异常流量。
即便如此，任何非官方客户端都存在被风控的可能性，属于正常使用风险。

**Q：单文件脚本，怎么二次开发？**
直接改 `scripts/bilibili-part-stats.user.js` 里的 `DEFAULTS` 或各 `render*` 函数即可，
没有构建链。改完在 Tampermonkey 里点「覆盖安装」就是新版本。

## 本地验证

仓库里带一个零依赖的冒烟测试，用最小 DOM 桩把脚本真跑一遍，专抓 TDZ、声明顺序、
初始化时序和降级路径这类只在运行时暴露的错误：

```bash
node test/smoke.js                       # 场景 1：正常响应，分段遍历收敛
SCENARIO=malformed node test/smoke.js    # 场景 2：接口返回缺 code 字段，必须降级为 —
```

两个场景都应输出 `18/18 通过`，退出码 0，可以直接接 CI。
Windows cmd 下把 `SCENARIO=malformed` 换成 `set SCENARIO=malformed`。

注意：这个测试只覆盖启动与渲染路径，**不覆盖真实浏览器行为**
（CSS 选择器是否命中 B 站真实 DOM、`fetch` 跨域与 cookie、SPA 路由切换）。
改完脚本仍需在 Tampermonkey 里实机验证一次。

## 贡献

欢迎 issue 与 PR。优先级：

1. 🟥 提供在线人数（在线观看人数）的可用新端点 —— 这是目前唯一缺失的核心功能
2. 🟧 B 站改 UI 导致锚点失效时的选择器补充
3. 🟨 分段接口协议变化时的适配
4. 🟩 其他体验改进

## License

[MIT](./LICENSE) © 2026 kyo-zzz
