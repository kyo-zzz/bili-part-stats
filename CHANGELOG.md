# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-03

### 新增

- 首个版本。
- 在 B 站视频标题下方新增一行，显示当前分 P 的弹幕数与在线观看人数。
- 「全部分P」明细表：分 P 标题 / 时长 / 弹幕数 / 在线观看人数，当前分 P 高亮，
  点击行直接跳转（走 SPA 路由，不整页刷新）。
- 弹幕数按 `/x/v2/dm/web/seg.so` 分段逐段累加，得到精确值；
  被 `maxSegCalls` 截断时显示为下界并加 `⁺` 上标标记。
- 在线人数走 `/x/web-interface/view/type`，采用「尽力而为 + 5 分钟熔断」策略，
  端点下线时显示 `—` 而非编造数字。
- 结果缓存：弹幕数默认 15 分钟、在线人数默认 60 秒，存于 Tampermonkey `GM_getValue`。
- SPA 感知：同时监听 `script#__INITIAL_STATE__` 变更、`pushState` 钩子、`popstate`
  与 1 秒轮询；节点被 B 站重绘挤掉时每 800ms 自动补回。
- Tampermonkey 菜单：`刷新当前视频数据` / `立即统计全部分P` / `显示 / 隐藏面板`。
- 全部行为收敛到单一 `DEFAULTS` 对象，无需构建步骤即可调整。

### 已知限制

- 在线观看人数端点 `/x/web-interface/view/type` 截至 2026-10-03 实测已下线，
  该列大概率显示为 `—`。
- `/x/v1/dm/list.so` 存在 1200 条硬上限，不能用于计数，本脚本不使用它。
