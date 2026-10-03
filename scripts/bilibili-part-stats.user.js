// ==UserScript==
// @name         Bilibili 分P数据补全
// @name:en      Bilibili Part Stats
// @namespace    https://github.com/kyo-zzz/bili-part-stats
// @version      0.2.1
// @description  在 B 站视频标题下方补齐「每个分 P」的弹幕数与在线观看人数，补回官方改版后丢失的展示。
// @description:en  Restores the per-part danmaku count and live viewer count below the video title on bilibili.com.
// @author       kyo-zzz
// @homepage     https://github.com/kyo-zzz/bili-part-stats
// @match        https://www.bilibili.com/video/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @connect      www.bilibili.com
// @run-at       document-idle
// @noframes
// @license      MIT
// @saveAs       bilibili-part-stats.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 同一页面只装载一次，避免油猴「更新」时的双跑。
  if (window.__biliPartStatsInstalled) return;
  window.__biliPartStatsInstalled = true;

  /* ==========================================================================
   * 设计说明
   *
   * 数据来源分三层，优先级从高到低：
   *
   * 1. window.__INITIAL_STATE__ —— 页面自己加载出来的数据，零额外请求、零风控面。
   *    提供分P列表（cid / 标题 / 时长）、当前 cid、UP主、全片总弹幕数。
   * 2. GET /x/web-interface/view?bvid= —— 初始状态缺失时的兜底，
   *    是官方前端自身在用的公开接口。
   * 3. GET /x/v2/dm/web/seg.so —— 唯一能拿到「真实单分P弹幕数」的途径。
   *    注意：/x/v1/dm/list.so 有 1200 条硬上限（实测同一视频 P1=1200 / P2=1165，
   *    而总数 8040），因此不能用来计数，只能像播放器一样逐段拉 seg.so 累加。
   *
   * 在线人数走 /x/web-interface/view/type。该端点已被下线（实测返回服务端
   * 错误 HTML 页而非 JSON），所以这里采用「尽力而为 + 熔断」：第一个分P取不到
   * 就 5 分钟内不再对其他分P重试，UI 上诚实显示 "—"，而不是编造数字。
   *
   * cid 粒度的结果都落缓存（弹幕数 TTL 默认 15 分钟，在线人数 60 秒），
   * 切分P来回跳不会重复打接口。
   * ========================================================================== */

  const API = 'https://api.bilibili.com';
  const BAR_ID = 'b-ps-bar';
  const PANEL_ID = 'b-ps-panel';
  const STORE_KEY = 'bPsStore.v1';
  const BVID_RE = /\/video\/(BV[0-9A-Za-z]+)/i;
  const PAGE_RE = /[?&]p=(\d+)/i;
  const PENDING = { pending: true }; // 「统计中」占位，区别于「尚未统计」的 undefined

  const DEFAULTS = {
    enabled: true,
    // 打开视频时是否自动统计全部分P（每个分P约 5~20 次请求，默认关闭）
    autoAllParts: false,
    cacheMin: 15,
    viewersTtlSec: 60,
    maxSegCalls: 80,
    concurrency: 2,
    paceMs: 120,
  };

  /* ----------------------------- 基础工具 ----------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadStore() {
    try {
      const raw = typeof GM_getValue === 'function'
        ? GM_getValue(STORE_KEY, '')
        : (localStorage.getItem(STORE_KEY) || '');
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveStore(patch) {
    const next = Object.assign({}, loadStore(), patch);
    const raw = JSON.stringify(next);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, raw);
      else localStorage.setItem(STORE_KEY, raw);
    } catch (_) {
      /* 存储满了也不能让脚本崩掉 */
    }
  }

  const cfg = () => Object.assign({}, DEFAULTS, loadStore().config || {});

  /** 缓存条目；过期或不存在返回 null */
  function readCache(ns, key, ttlMs) {
    const bucket = (loadStore()[ns] || {})[key];
    if (!bucket || !Number.isFinite(bucket.ts)) return null;
    return Date.now() - bucket.ts > ttlMs ? null : bucket;
  }

  function writeCache(ns, key, value) {
    const store = loadStore();
    store[ns] = store[ns] || {};
    store[ns][key] = { ts: Date.now(), value };
    // 每个命名空间最多留 200 个 key，防止长期膨胀。
    const keys = Object.keys(store[ns]);
    if (keys.length > 200) {
      keys
        .sort((a, b) => store[ns][a].ts - store[ns][b].ts)
        .slice(0, keys.length - 200)
        .forEach((k) => delete store[ns][k]);
    }
    saveStore(store);
  }

  async function fetchOnce(url, timeoutMs, credentials) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 9000);
    try {
      const res = await fetch(url, {
        credentials,
        signal: ctrl.signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 默认先发带 cookie 的请求（弹幕分段接口需要 buvid3），
   * 若被 CORS 拦下（服务端回 Access-Control-Allow-Origin: * 时 credentials:include 会被浏览器拒绝）
   * 再退回到不带 cookie 重试一次。避免 CORS 组合问题让整个脚本静默消失。
   */
  async function fetchJSON(url, timeoutMs) {
    const modes = ['include', 'omit'];
    let lastErr;
    for (const mode of modes) {
      try {
        return await fetchOnce(url, timeoutMs, mode);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** 12345 -> "1.2万"，与 B 站自身展示口径保持一致 */
  function fmt(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2).replace(/\.?0+$/, '') + '万';
    return String(Math.round(n));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function trunc(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /* ----------------------------- 数据层 ----------------------------- */

  function currentBvid() {
    const m = location.pathname.match(BVID_RE);
    return m ? m[1].toUpperCase() : null;
  }

  /* ----------------------------- 页面数据 ----------------------------- */

  // B 站业务错误码里少数几个值得让用户看懂的
  const CODE_HINT = {
    '-101': '账号不存在',
    '-111': '登录状态异常',
    '-214': '账号被封禁',
    '-352': '触发风控',
    '-403': '无权限',
    '-404': '请求被拒或视频不可见',
    '-412': '需要登录',
    '-429': '请求过于频繁',
  };

  /**
   * 在 __INITIAL_STATE__ 里找分P列表：找到第一个「pages 是数组且每项带 cid」的对象。
   *
   * B 站这个状态的结构一直在变，不能钉死在某条 key 路径上——videoData 有时是对象、
   * 有时是被 JSON.stringify 过的字符串，外面还可能再裹一层 data。
   * 有界深度扫描（最多 5 层）兜住所有变体，解析失败静默跳过。
   */
  function scanForVideo(node, depth) {
    if (!node || depth > 5) return null;
    if (typeof node === 'string') {
      if (node.length > 500000) return null;
      try { return scanForVideo(JSON.parse(node), depth); } catch (_) { return null; }
    }
    if (typeof node !== 'object') return null;
    if (Array.isArray(node.pages) && node.pages.length &&
        node.pages[0] && node.pages[0].cid !== undefined) return node;
    let keys;
    try { keys = Object.keys(node); } catch (_) { return null; }
    for (let i = 0; i < keys.length; i++) {
      const hit = scanForVideo(node[keys[i]], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 第一优先：直接读页面已加载的初始状态，不发任何请求。
   *
   * 这条路径是整个脚本的地基——它命中就不需要任何网络请求，
   * 也就不受登录态、风控、CORS 的影响。syncCurrent 每秒都会调它，
   * 所以结果按状态对象做记忆化，不能每次都全量扫描。
   */
  function readInitialState() {
    try {
      const st = window.__INITIAL_STATE__;
      if (st && typeof st === 'object') {
        if (st.__bPsVideoMemo) return st.__bPsVideoMemo;
        const hit = scanForVideo(st, 0);
        if (hit) {
          try { st.__bPsVideoMemo = hit; } catch (_) {}
          return hit;
        }
      }
    } catch (_) {}
    const script = document.querySelector('script#__INITIAL_STATE__');
    if (script && script.textContent) {
      try {
        const hit = scanForVideo(JSON.parse(script.textContent), 0);
        if (hit) return hit;
      } catch (_) {}
    }
    return null;
  }

  async function fetchView(bvid) {
    const j = await fetchJSON(API + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.pages)) {
      const code = j && j.code;
      const hint = CODE_HINT[String(code)];
      throw new Error('view 接口异常 code=' + code + (hint ? '（' + hint + '）' : ''));
    }
    return j.data;
  }

  async function loadVideo(bvid) {
    let data = readInitialState();
    if (!data) data = await fetchView(bvid);
    return {
      bvid,
      title: String(data.title || ''),
      pages: (data.pages || []).map((p, i) => ({
        page: Number(p.page) || i + 1,
        cid: String(p.cid),
        part: String(p.part || ''),
        duration: Number(p.duration) || 0,
      })),
      totalDanmaku: (data.stat && data.stat.danmaku) | 0,
    };
  }

  /**
   * 遍历弹幕分段接口，累加出单个 cid 的真实弹幕数。
   * 返回 { count, complete, ... }；complete=false 时 count 只能算下界。
   */
  async function countDanmaku(cid, durationSec, maxCalls) {
    let dur = Math.max((durationSec || 0) * 1000, 1000);
    let progress = 0;
    let segIndex = 0;
    let count = 0;
    let calls = 0;
    const limit = maxCalls || cfg().maxSegCalls;
    const pace = cfg().paceMs;

    while (calls < limit) {
      const url = API + '/x/v2/dm/web/seg.so?type=1&oid=' + cid +
        '&seg_index=' + segIndex +
        '&progress=' + Math.floor(progress) +
        '&platform=web';
      let j;
      try {
        j = await fetchJSON(url);
      } catch (_) {
        return { count, complete: false, error: '网络中断' };
      }
      if (!j || typeof j.code !== 'number' || j.code !== 0) {
        // -403 / -412 等：该分P无弹幕权限或已被风控；缺 code 字段则是响应格式异常。
        // 一律标为不可用，而不是误报成「0 条弹幕」。
        return { count: 0, complete: false, error: '响应异常', code: j && j.code };
      }

      const data = j.data || {};
      const page = data.page || {};
      count += Array.isArray(data.danmaku) ? data.danmaku.length : 0;
      calls += 1;

      const next = Number(page.progress) || 0;
      if (Number.isFinite(page.duration) && page.duration > dur) dur = Number(page.duration);
      if (!Number.isFinite(next) || next <= progress) break;
      progress = next;
      segIndex = Number(page.seg_index) > segIndex ? Number(page.seg_index) : segIndex + 1;

      if (progress >= dur) return { count, complete: true, calls };
      if (pace > 0) await sleep(pace);
    }
    return { count, complete: false, calls };
  }

  // 在线人数：端点已下线，用熔断避免每次刷新都白打一遍。
  const viewerCircuit = { open: false, until: 0 };

  async function fetchViewers(bvid, cid) {
    if (viewerCircuit.open && Date.now() < viewerCircuit.until) return null;
    viewerCircuit.open = false;

    const url = API + '/x/web-interface/view/type?type=bvid&bvid=' + bvid + '&cid=' + cid;
    try {
      const j = await fetchJSON(url, 6000);
      // 端点下线时服务端回的是 HTML 错误页，JSON.parse 会抛错 —— 这正是熔断信号。
      const vt = (j && j.data && j.data.view_type) || (j && j.data) || {};
      const view = Number(vt.view);
      if (!j || j.code !== 0 || !Number.isFinite(view) || view < 0) return null;
      return view;
    } catch (_) {
      viewerCircuit.open = true;
      viewerCircuit.until = Date.now() + 5 * 60 * 1000;
      return null;
    }
  }

  /* ----------------------------- 并发控制 ----------------------------- */

  /** 简单信号量：别把十几个分P的弹幕同时打出去 */
  function makePool(limit) {
    let active = 0;
    const queue = [];
    function next() {
      if (active >= limit || !queue.length) return;
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job)
        .then(
          () => { active -= 1; next(); },
          () => { active -= 1; next(); },
        );
    }
    return (fn) => new Promise((res, rej) => { queue.push(() => fn().then(res, rej)); next(); });
  }

  /* ----------------------------- UI ----------------------------- */

  const CSS = `
#b-ps-bar{
  --b-ps-accent:#00AEEC; --b-ps-text:#61666d; --b-ps-strong:#18191c;
  --b-ps-line:#e3e5e7; --b-ps-bg:#f6f7f8;
  display:flex; flex-wrap:wrap; align-items:center; gap:8px;
  margin:6px 0 2px; padding:5px 0; font-size:12px; line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",
              Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--b-ps-text);
}
.b-ps-chip{
  display:inline-flex; align-items:center; gap:5px; white-space:nowrap;
  padding:2px 8px; border-radius:4px; background:var(--b-ps-bg);
}
.b-ps-chip b{ color:var(--b-ps-strong); font-weight:600; }
.b-ps-chip.is-cur{ background:#e6f3fd; }
.b-ps-tag{ display:inline-flex; align-items:center; gap:4px; font-weight:600; color:var(--b-ps-strong); }
.b-ps-num{ color:var(--b-ps-accent); font-weight:600; font-variant-numeric:tabular-nums; }
.b-ps-dash{ color:#9499a0; }
.b-ps-btn{ display:inline-flex; align-items:center; gap:4px; cursor:pointer; color:var(--b-ps-accent); user-select:none; }
.b-ps-btn:hover{ text-decoration:underline; }
.b-ps-close{ cursor:pointer; color:#9499a0; font-size:15px; line-height:1; }
.b-ps-close:hover{ color:var(--b-ps-strong); }
#b-ps-panel{
  display:none; margin:2px 0 10px; border:1px solid var(--b-ps-line);
  border-radius:8px; background:#fff; overflow:hidden; font-size:12px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",
              Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  box-shadow:0 2px 12px rgba(0,0,0,.06);
}
#b-ps-panel.is-open{ display:block; }
.b-ps-head{
  display:flex; align-items:center; gap:10px; padding:8px 12px;
  background:#fff; border-bottom:1px solid var(--b-ps-line);
}
.b-ps-head h3{ margin:0; font-size:13px; font-weight:600; color:var(--b-ps-strong); }
.b-ps-head .b-ps-meta{ color:var(--b-ps-text); }
.b-ps-scroll{ max-height:320px; overflow:auto; }
.b-ps-table{ width:100%; border-collapse:collapse; }
.b-ps-table th{
  position:sticky; top:0; text-align:left; font-weight:600; color:var(--b-ps-text);
  background:var(--b-ps-bg); padding:6px 12px; border-bottom:1px solid var(--b-ps-line);
}
.b-ps-table td{ padding:6px 12px; border-bottom:1px solid #f1f2f3; color:var(--b-ps-strong); }
.b-ps-table tr:last-child td{ border-bottom:none; }
.b-ps-row{ cursor:pointer; }
.b-ps-row:hover td{ background:var(--b-ps-bg); }
.b-ps-row.b-ps-cur td{ background:#e6f3fd; }
/* 找不到标题锚点时的兜底停靠位置，保证脚本永远至少能被看见一次 */
#b-ps-bar.is-float{
  position:fixed; left:12px; top:70px; z-index:999999; max-width:62vw;
}
#b-ps-bar.is-notice{
  background:#fffbe6; border:1px solid #ffe58f; border-radius:6px;
  padding:6px 10px; font-size:12px; line-height:1.5;
}
#b-ps-bar.is-notice.is-bad{ background:#fff1f0; border-color:#ffa39e; }
`;

  function injectCss() {
    if (document.getElementById('b-ps-css')) return;
    const style = document.createElement('style');
    style.id = 'b-ps-css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 锚点：优先 B 站标题元素。
   * 选择器列表刻意写宽 —— B 站改版频繁，宁可多试几种也不要静默不显示。
   */
  function findAnchor() {
    const sels = [
      'h1.video-title__text',
      'h1.video-title',
      '.video-title h1',
      'h1[class*="title"]',
      '.video-title',
      '[class*="video-title"]',
      'h1',
      '.title',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.textContent.trim().length > 1) return el;
    }
    return null;
  }

  /**
   * 把栏和面板作为兄弟节点挂在标题容器之后。
   * 栏和面板用两个独立容器 —— renderBar 清栏时不会连带清掉面板。
   * 找不到标题锚点时退化为固定停靠（见 mountFloating），绝不静默消失。
   */
  function mount() {
    const anchor = findAnchor();
    if (!anchor) return mountFloating();
    const box = anchor.closest('.video-title') || anchor.parentElement;
    if (!box) return mountFloating();

    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
    }
    bar.classList.remove('is-float', 'is-notice', 'is-bad');
    bar.style.cssText = '';
    box.insertAdjacentElement('afterend', bar);

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
    }
    if (panel.previousElementSibling !== bar) bar.insertAdjacentElement('afterend', panel);
    state.floating = false;
    return true;
  }

  /** 标题锚点都找不到时的兜底：贴在视口左上，保证脚本永远至少能被看见一次 */
  function mountFloating() {
    const host = document.body || document.documentElement;
    if (!host) return false;
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
    }
    bar.classList.add('is-float');
    host.appendChild(bar);

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
    }
    if (panel.previousElementSibling !== bar) bar.insertAdjacentElement('afterend', panel);
    state.floating = true;
    return true;
  }

  function hideAll() {
    [BAR_ID, PANEL_ID].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  /**
   * 任何失败都要给出可见的原因，绝不 hideAll 后让用户对着空白页猜。
   * 这是 v0.2 最关键的一条改动。
   */
  function showError(reason) {
    injectCss();
    hideAll();
    if (!mountFloating()) return;
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.remove('is-notice', 'is-bad');
    bar.classList.add('is-notice', 'is-bad');
    bar.innerHTML =
      '<b>分P数据</b> <span style="color:#cf1322">未显示</span> · ' +
        escapeHtml(reason) +
        ' <span class="b-ps-btn" data-act="refresh" style="margin-left:6px">重试</span>' +
        '<span class="b-ps-btn" data-act="dismiss" style="margin-left:4px">忽略</span>';
  }

  /**
   * 之前被手动关过（enabled: false）时的提示。
   * 旧版本主栏上的「×」会把 enabled 持久化为 false，之后整个脚本静默不显示，
   * 用户只会看到空白页。所以这个状态也必须可见、且能一键恢复。
   */
  function showPaused() {
    injectCss();
    hideAll();
    if (!mountFloating()) return;
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.add('is-notice');
    bar.innerHTML =
      '<b>分P数据</b> <span style="color:#d48806">已暂停</span>' +
        '（之前被关闭过，不会显示）' +
        ' <span class="b-ps-btn" data-act="enable" style="margin-left:6px">重新启用</span>' +
        '<span class="b-ps-btn" data-act="quiet" style="margin-left:4px">忽略</span>';
  }

  function renderBar(v) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    // 清掉 showError / showPaused 留下的通知样式；is-float 由 mount / mountFloating 管理
    bar.style.cssText = '';
    bar.classList.remove('is-notice', 'is-bad');
    const cur = state.current;
    const multi = v.pages.length > 1;
    bar.innerHTML =
      '<span class="b-ps-tag">P' + cur.page +
        (cur.part ? ' · ' + escapeHtml(trunc(cur.part, 18)) : '') + '</span>' +
      '<span class="b-ps-chip is-cur">弹幕 <b class="b-ps-num">' + cellDanmaku(cur.cid) + '</b></span>' +
      '<span class="b-ps-chip">在线 <b class="b-ps-num">' + cellViewers(cur.cid) + '</b></span>' +
      (multi
        ? '<span class="b-ps-btn" data-act="toggle">全部分P（' + v.pages.length + '） ▾</span>' +
          '<span class="b-ps-btn" data-act="count-all">统计全部分P</span>'
        : '') +
      '<span class="b-ps-btn" data-act="refresh">刷新</span>';
  }

  function renderPanel(v) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const rows = v.pages
      .map((p) =>
        '<tr class="b-ps-row' + (p.cid === state.current.cid ? ' b-ps-cur' : '') + '" data-cid="' + p.cid + '">' +
          '<td style="width:46px">P' + p.page + '</td>' +
          '<td>' + escapeHtml(p.part || '（未命名）') + '</td>' +
          '<td style="width:70px;text-align:right">' + fmtDur(p.duration) + '</td>' +
          '<td style="width:104px;text-align:right" class="b-ps-num">' + cellDanmaku(p.cid) + '</td>' +
          '<td style="width:104px;text-align:right" class="b-ps-num">' + cellViewers(p.cid) + '</td>' +
        '</tr>'
      )
      .join('');
    panel.innerHTML =
      '<div class="b-ps-head">' +
        '<h3>' + escapeHtml(trunc(v.title, 30)) + '</h3>' +
        '<span class="b-ps-meta">全片总弹幕 <b>' + fmt(v.totalDanmaku) + '</b></span>' +
        '<span class="b-ps-close" data-act="toggle" style="margin-left:auto" title="收起">×</span>' +
      '</div>' +
      '<div class="b-ps-scroll"><table class="b-ps-table">' +
        '<thead><tr>' +
          '<th>分P</th><th>标题</th>' +
          '<th style="text-align:right">时长</th>' +
          '<th style="text-align:right">弹幕数</th>' +
          '<th style="text-align:right">在线观看</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cellDanmaku(cid) {
    const dm = state.byCid[cid];
    if (dm === PENDING) return '<span class="b-ps-dash">统计中…</span>';
    if (!dm) return '<span class="b-ps-dash">—</span>';
    if (dm.error || (typeof dm.code === 'number' && dm.code !== 0)) {
      return '<span class="b-ps-dash">—</span>';
    }
    // complete=false 时 count 只是下界，用上标加号标记
    return fmt(dm.count) + (dm.complete ? '' : '⁺');
  }

  function cellViewers(cid) {
    const vs = state.viewers[cid];
    return vs === null || vs === undefined
      ? '<span class="b-ps-dash">—</span>'
      : fmt(vs);
  }

  function fmtDur(sec) {
    sec = Math.floor(Number(sec) || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function togglePanel(force) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state.video) return;
    state.panelOpen = typeof force === 'boolean' ? force : !state.panelOpen;
    panel.classList.toggle('is-open', state.panelOpen);
    // 面板是懒创建的，首次打开时 innerHTML 还是空的
    if (state.panelOpen) renderPanel(state.video);
  }

  function jumpToCid(cid) {
    const v = state.video;
    if (!v) return;
    const p = v.pages.find((x) => x.cid === cid);
    if (!p) return;
    const url = location.pathname.replace(BVID_RE, '/video/' + v.bvid) + '?p=' + p.page;
    if (history.pushState) {
      history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else {
      location.href = url;
    }
  }

  /**
   * 事件委托只装一次，栏和面板共用。
   * 注意：主栏刻意不提供关闭按钮 —— 一次误点就会把脚本永久关掉，
   * 用户只会看到一片空白然后来报「不显示了」。要持久关闭走 Tampermonkey 菜单。
   */
  function wire() {
    document.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (actEl && (actEl.closest('#b-ps-bar') || actEl.closest('#b-ps-panel'))) {
        const act = actEl.getAttribute('data-act');
        if (act === 'toggle') togglePanel();
        else if (act === 'count-all') {
          // 只算数据不展开面板会让人误以为「没反应」，所以顺手打开
          togglePanel(true);
          void countAll();
        } else if (act === 'refresh') void rebuild();
        else if (act === 'dismiss') hideAll();
        else if (act === 'quiet') { pausedQuiet = true; noticeUntil = 0; hideAll(); }
        else if (act === 'enable') {
          pausedQuiet = false; noticeUntil = 0;
          const c = cfg();
          saveStore({ config: Object.assign({}, c, { enabled: true }) });
          void rebuild();
        }
        return;
      }
      const row = e.target.closest('.b-ps-row');
      if (row) jumpToCid(row.getAttribute('data-cid'));
    });
  }

  /* ----------------------------- 编排 ----------------------------- */

  const state = {
    video: null,
    current: null,
    byCid: {},
    viewers: {},
    busy: new Set(),
    panelOpen: false,
    dirty: true,
    floating: false,
  };

  /** 为单个 cid 取数：先缓存、再网络；同 cid 并发去重 */
  async function ensurePart(cid) {
    if (state.byCid[cid] || state.busy.has(cid)) return;
    const v = state.video;
    if (!v) return;

    state.busy.add(cid);
    state.byCid[cid] = PENDING; // 占位：UI 上显示「统计中…」
    state.dirty = true;
    repaint();

    try {
      const dmKey = v.bvid + ':' + cid;
      const hit = readCache('dm', dmKey, cfg().cacheMin * 60 * 1000);
      if (hit) {
        state.byCid[cid] = hit.value;
      } else {
        const page = v.pages.find((p) => p.cid === cid);
        const r = await countDanmaku(cid, page && page.duration, 0);
        state.byCid[cid] = r && typeof r.count === 'number'
          ? r
          : { count: 0, complete: false };
        writeCache('dm', dmKey, state.byCid[cid]);
      }

      const vwKey = v.bvid + ':' + cid;
      const vHit = readCache('vw', vwKey, cfg().viewersTtlSec * 1000);
      if (vHit) {
        state.viewers[cid] = vHit.value;
      } else {
        const n = await fetchViewers(v.bvid, cid);
        state.viewers[cid] = n;
        if (n !== null) writeCache('vw', vwKey, n);
      }
    } finally {
      state.busy.delete(cid);
      state.dirty = true;
      repaint();
    }
  }

  /**
   * 逐分P统计，并发度由 concurrency 控制。
   * 每个分P内部的分段遍历是串行的（带 paceMs 限速），并发只在分P之间生效。
   */
  async function countAll() {
    if (!state.video) return;
    const run = makePool(Math.max(1, cfg().concurrency));
    await Promise.all(state.video.pages.map((p) =>
      run(async () => {
        if (!cfg().enabled) return; // 允许被「隐藏面板」中途打断
        await ensurePart(p.cid);
      })
    ));
  }

  function repaint() {
    if (!state.video || !state.current || !state.dirty) return;
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    renderBar(state.video);
    if (state.panelOpen) renderPanel(state.video);
    state.dirty = false;
  }

  async function syncCurrent() {
    const v = state.video;
    if (!v) return false;
    const pm = location.search.match(PAGE_RE);
    const byPage = pm && v.pages.find((p) => String(p.page) === pm[1]);
    const st = readInitialState();
    const cidFromState = st && st.cid ? String(st.cid) : null;
    const cur = byPage || v.pages.find((p) => p.cid === cidFromState) || v.pages[0];
    if (!cur) return false;
    const changed = !state.current || state.current.cid !== cur.cid;
    state.current = cur;
    if (changed) {
      state.dirty = true;
      void ensurePart(cur.cid);
    }
    return changed;
  }

  // 同一提示 30 秒内只画一次，否则 1 秒轮询会反复重建 DOM，按钮根本点不动
  let noticeUntil = 0;
  // 点过「忽略」后本页面会话内不再重复弹「已暂停」提示（enabled 仍为 false，只是不再打扰）
  let pausedQuiet = false;

  async function rebuild() {
    if (!cfg().enabled) {
      if (pausedQuiet || noticeUntil > Date.now()) return;
      noticeUntil = Date.now() + 30000;
      return showPaused();
    }
    injectCss();
    const bvid = currentBvid();
    if (!bvid) return hideAll();

    if (state.video && state.video.bvid === bvid) {
      await syncCurrent();
      if (document.getElementById(BAR_ID) || mount()) repaint();
      return;
    }

    // 换视频了：清内存态，GM 缓存保留
    state.video = null;
    state.current = null;
    state.byCid = {};
    state.viewers = {};
    state.busy.clear();
    state.panelOpen = false;

    try {
      state.video = await loadVideo(bvid);
    } catch (err) {
      if (noticeUntil > Date.now()) return;
      noticeUntil = Date.now() + 30000;
      const msg = err && err.message ? err.message : String(err);
      console.warn('[bilibili-part-stats] 视频数据加载失败：', err);
      // 显示不出来就必须说清楚为什么，而不是留一片空白让人猜
      return showError('取不到视频数据（' + msg + '）');
    }
    if (!state.video.pages.length) {
      if (noticeUntil <= Date.now()) {
        noticeUntil = Date.now() + 30000;
        showError('这个视频没有分 P 列表，可能不是普通投稿');
      }
      return;
    }
    await syncCurrent();
    if (!state.current) {
      if (noticeUntil <= Date.now()) {
        noticeUntil = Date.now() + 30000;
        showError('定位不到当前正在看的分 P');
      }
      return;
    }
    noticeUntil = 0;
    mount();
    state.dirty = true;
    repaint();
    console.log('[bilibili-part-stats] ready: ' + bvid +
      ' 共 ' + state.video.pages.length + ' 个分P，当前 P' + state.current.page);
    if (cfg().autoAllParts && state.video.pages.length > 1) void countAll();
  }

  /* ----------------------------- 路由与保活 ----------------------------- */

  /**
   * B 站是 SPA，切视频不整页刷新，只替换 script#__INITIAL_STATE__ 的内容。
   * 同时挂 MutationObserver + pushState 钩子 + popstate + 1s 轮询，多路冗余。
   */
  function watchRoutes() {
    const script = document.querySelector('script#__INITIAL_STATE__');
    if (script) {
      new MutationObserver(() => void rebuild()).observe(script, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    const before = history.pushState;
    history.pushState = function () {
      const r = before.apply(this, arguments);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return r;
    };
    window.addEventListener('popstate', () => void rebuild());
    setInterval(() => void rebuild(), 1000);
  }

  /** 我们的节点被 B 站重绘挤掉时自动补回（正常在位时什么都不做，避免 DOM 抖动） */
  function keepAlive() {
    setInterval(() => {
      if (!cfg().enabled || !state.video || !findAnchor()) return;
      const bar = document.getElementById(BAR_ID);
      if (bar && bar.isConnected) return;
      if (mount()) {
        state.dirty = true;
        repaint();
      }
    }, 800);
  }

  /* ----------------------------- 油猴菜单 ----------------------------- */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('刷新当前视频数据', () => { saveStore({}); void rebuild(); });
    GM_registerMenuCommand('立即统计全部分P', () => void countAll());
    GM_registerMenuCommand('关闭 / 开启分P数据栏', () => {
      const c = cfg();
      pausedQuiet = false;
      noticeUntil = 0;
      saveStore({ config: Object.assign({}, c, { enabled: !c.enabled }) });
      if (c.enabled) hideAll();
      else void rebuild();
    });
  }

  /* ----------------------------- 启动 ----------------------------- */

  injectCss();
  wire();
  watchRoutes();
  keepAlive();
  void rebuild();
})();
