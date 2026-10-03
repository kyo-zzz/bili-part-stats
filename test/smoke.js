/*
 * userscript 启动冒烟测试：用最小 DOM 桩把脚本真跑一遍。
 *
 * 目的不是测功能，而是抓 TDZ、声明顺序、初始化时序、以及降级路径这类
 * 只在运行时暴露的错误。零依赖，只要本机有 Node。
 *
 * 运行：
 *   node test/smoke.js                       # 场景 1：正常响应，分段遍历收敛
 *   SCENARIO=malformed node test/smoke.js    # 场景 2：接口返回缺 code 字段，必须降级为 —
 *
 * 通过时两个场景都是 26/26，进程退出码 0；任一失败退出码 1，可直接接 CI。
 *
 * 断言分三段：启动与初始渲染 → 模拟点击（面板展开 / 收起）→ countAll 收敛。
 * Windows cmd 下用 set SCENARIO=malformed 代替前缀赋值。
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'bilibili-part-stats.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// SCENARIO=normal      正常响应：分段遍历收敛，弹幕数应为 35
// SCENARIO=malformed   seg.so 返回缺 code 字段：必须降级为 —，绝不能误报成 0
const SCENARIO = process.env.SCENARIO || 'normal';
const EXPECT_SEG = SCENARIO === 'malformed' ? 1 : 7;

/* ---------------- 最小 DOM ---------------- */
const registry = new Map();

function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    parentElement: null,
    textContent: '',
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) {
        if (f === false) this._s.delete(c); else this._s.add(c);
        return this._s.has(c);
      },
      contains(c) { return this._s.has(c); },
    },
  };
  let _id = '';
  Object.defineProperty(el, 'id', {
    configurable: true,
    get() { return _id; },
    set(v) { _id = v; if (v) registry.set(v, el); else registry.delete(_id); },
  });
  let _ih = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return _ih; },
    set(v) { _ih = String(v); },
  });
  let _sib = null;
  Object.defineProperty(el, 'previousElementSibling', {
    configurable: true,
    get() { return _sib; },
  });
  el.querySelector = () => null;
  el.closest = () => null;
  el.appendChild = function (c) {
    this.children.push(c);
    c.parentElement = this;
    return c;
  };
  el.remove = function () {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  };
  el.insertAdjacentElement = function (pos, node) {
    if (pos !== 'afterend') throw new Error('only afterend supported, got ' + pos);
    const p = this.parentElement;
    if (p) {
      const i = p.children.indexOf(this);
      p.children.splice(i + 1, 0, node);
      node.parentElement = p;
      _sib = p.children[i];
      Object.defineProperty(node, 'previousElementSibling', { get() { return _sib; } });
    } else {
      (this._orphan = this._orphan || []).push(node);
    }
    return node;
  };
  return el;
}

const h1 = mkEl('h1');
h1.textContent = '《明日方舟》SideStory「昨日海」活动宣传PV';
const titleBox = mkEl('div');
titleBox.appendChild(h1);
h1.closest = () => titleBox;

const handlers = {}; // 收集 document.addEventListener 注册的事件处理器

const documentStub = {
  head: mkEl('head'),
  body: mkEl('body'),
  documentElement: mkEl('html'),
  getElementById(id) { return registry.get(id) || null; },
  createElement(tag) { return mkEl(tag); },
  querySelector(sel) {
    if (sel === 'script#__INITIAL_STATE__') return null;
    if (sel.startsWith('h1') || sel.startsWith('.video-title')) return h1;
    return null;
  },
  addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
  querySelectorAll() { return []; },
};

/* ---------------- 页面数据 ---------------- */
const PAGE = {
  bvid: 'BV1Rxam6kEtU',
  aid: '117370114869602',
  title: '《明日方舟》SideStory「昨日海」活动宣传PV',
  cid: '42391375292',
  pages: [
    { cid: '42391374735', page: 1, part: '【中】宣传PV', duration: 204 },
    { cid: '42391375292', page: 2, part: '【日】宣传PV', duration: 204 },
  ],
  stat: { danmaku: 8040 },
};

let segCalls = 0;
let viewerCalls = 0;

const locationStub = {
  pathname: '/video/BV1Rxam6kEtU/',
  search: '?p=2',
  href: 'https://www.bilibili.com/video/BV1Rxam6kEtU/?p=2',
};

function ok(body) { return { ok: true, status: 200, json: async () => body }; }
function htmlErr() {
  return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON'); } };
}

// seg.so：每段返回 5 条弹幕，进度 +30s，总时长 204s → 7 次调用后收敛
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.includes('/x/web-interface/view?')) {
    return ok({ code: 0, data: JSON.parse(JSON.stringify(PAGE)) });
  }
  if (u.includes('/x/v2/dm/web/seg.so')) {
    segCalls++;
    const m = u.match(/progress=(\d+)/);
    const progress = Number(m && m[1]) || 0;
    const total = 204000;
    const body = {
      data: {
        page: { duration: total, progress: progress + 30000, seg_index: 6 },
        danmaku: new Array(5).fill(0).map((_, i) => ({ p: i })),
      },
    };
    // malformed 场景：故意不给 code 字段，模拟响应结构被 B 站改掉
    return ok(SCENARIO === 'malformed' ? body : Object.assign({ code: 0 }, body));
  }
  if (u.includes('/x/web-interface/view/type')) {
    viewerCalls++;
    return htmlErr(); // 端点已下线的真实形态：回 HTML 而不是 JSON
  }
  throw new Error('unexpected url: ' + u);
};

/* ---------------- 全局环境 ---------------- */
const store = {};
const menu = [];
const windowStub = {
  addEventListener() {},
  dispatchEvent() {},
  __INITIAL_STATE__: { videoData: { data: PAGE } },
};

const bootError = [];
try {
  // 脚本里 sleep() 用 setTimeout、fetchJSON 也用它设 9s 超时；用真实定时器，
  // 但把 setInterval 打废，避免 1s 轮询让进程不退出。
  const fn = new Function(
    'window', 'document', 'location', 'history', 'fetch', 'localStorage',
    'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand',
    'MutationObserver', 'PopStateEvent', 'AbortController', 'console',
    'setTimeout', 'setInterval', 'clearTimeout',
    src + '\n;return true;'
  );
  const r = fn(
    windowStub, documentStub, locationStub,
    { pushState() {} },
    fetchImpl,
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    (k, d) => (k in store ? JSON.parse(store[k]) : d),
    (k, v) => { store[k] = JSON.stringify(v); },
    (label, cb) => { menu.push([label, cb]); },
    class { observe() {} disconnect() {} },
    class { constructor(t) { this.type = t; } },
    AbortController,
    console,
    setTimeout,
    () => 0,
    clearTimeout,
  );
  if (r !== true) bootError.push('script did not signal completion');
} catch (e) {
  bootError.push('BOOT THREW: ' + e.stack.split('\n').slice(0, 5).join('\n    '));
}

/* ---------------- 断言 ---------------- */
const checks = [];
const assert = (name, cond) => checks.push([name, !!cond]);

/** 模拟点击栏或面板上的某个 data-act 控件 */
function clickAct(act, inPanel) {
  const el = {
    getAttribute: () => act,
    closest(sel) {
      if (sel === '#b-ps-bar') return inPanel ? null : {};
      if (sel === '#b-ps-panel') return inPanel ? {} : null;
      return null;
    },
  };
  const e = {
    target: {
      closest(sel) {
        if (sel === '[data-act]') return el;
        if (sel === '#b-ps-bar') return inPanel ? null : {};
        if (sel === '#b-ps-panel') return inPanel ? {} : null;
        return null;
      },
    },
  };
  (handlers.click || []).forEach((fn) => fn(e));
}

function finish(dmCell) {
  console.log('\n=== userscript 冒烟测试 · 场景: ' + SCENARIO + ' ===');
  if (dmCell !== undefined) {
    console.log('弹幕单元格内容: ' + dmCell.replace(/<[^>]+>/g, '[').replace(/\]/g, ']'));
  }
  let pass = 0;
  for (const [name, okFlag] of checks) {
    console.log((okFlag ? '  PASS  ' : '  FAIL  ') + name);
    if (okFlag) pass++;
  }
  console.log('\nseg.so 调用 ' + segCalls + ' 次 | view/type 调用 ' + viewerCalls + ' 次');
  if (bootError.length) {
    console.log('\n启动异常:');
    bootError.forEach((e) => console.log('  ! ' + e));
  }
  console.log('\n' + pass + '/' + checks.length + ' 通过');
  process.exit(pass === checks.length && !bootError.length ? 0 : 1);
}

setTimeout(() => {
  const bar = registry.get('b-ps-bar');
  const panel = registry.get('b-ps-panel');

  assert('脚本注册了单例标记（防双跑）', windowStub.__biliPartStatsInstalled === true);
  assert('CSS 已注入 <style id=b-ps-css>', !!registry.get('b-ps-css'));
  assert('栏元素已创建', !!bar);
  assert('面板元素已创建', !!panel);
  assert('栏挂在标题容器之后', !!(titleBox._orphan || []).includes(bar));
  assert('面板紧挨在栏之后', !!(bar && bar._orphan || []).includes(panel));
  assert('栏有内容', !!(bar && bar.innerHTML.length > 40));
  assert('栏显示当前分P = P2（来自 ?p=2）', !!(bar && /P2/.test(bar.innerHTML)));
  assert('当前分P标题已转义展示', !!(bar && bar.innerHTML.includes('宣传PV')));
  assert('初始未展开面板（懒加载）', !!panel && !panel.classList.contains('is-open'));
  // 精确取出弹幕单元格内容，避免用 includes 做模糊匹配
  const m = bar ? String(bar.innerHTML).match(/弹幕 <b class="b-ps-num">([\s\S]*?)<\/b>/) : null;
  const dmCell = m ? m[1] : '(未渲染)';

  if (SCENARIO === 'malformed') {
    assert('格式异常响应降级为 —（不误报 0）', dmCell.indexOf('b-ps-dash') >= 0);
    assert('格式异常时不显示任何数字', !/\d/.test(dmCell));
    assert('格式异常时不误标下界上标', dmCell.indexOf('⁺') < 0);
  } else {
    assert('弹幕数已算出为 35（7 段 × 5 条）', dmCell === '35');
    assert('弹幕数不是「统计中…」占位', dmCell.indexOf('统计中') < 0);
    assert('跑完全部分段时不标下界上标', dmCell.indexOf('⁺') < 0);
  }
  assert('当前分P请求次数与预期一致（' + EXPECT_SEG + '）', segCalls === EXPECT_SEG);
  assert('在线人数在端点下线时降级为 —', !!(bar && bar.innerHTML.includes('在线 <b') && bar.innerHTML.indexOf('<span class="b-ps-dash">—</span>') >= 0));
  assert('多分P才显示「全部分P」按钮', !!(bar && bar.innerHTML.includes('全部分P（2）')));
  assert('在线人数端点被调用过且熔断', viewerCalls >= 1);
  assert('缓存已写入 GM 存储', typeof store['bPsStore.v1'] === 'string');
  assert('注册了 3 个油猴菜单项', menu.length === 3);
  assert('注册了 1 个 click 委托处理器', (handlers.click || []).length === 1);

  // 点「统计全部分P」必须同时展开面板——此前只算数据不展开，用户会以为「没反应」
  clickAct('count-all');
  assert('点「统计全部分P」后面板已展开', !!panel && panel.classList.contains('is-open'));
  assert('面板渲染出 2 个分P的行', !!panel && (panel.innerHTML.match(/b-ps-row/g) || []).length === 2);
  assert('面板高亮当前分P', !!panel && panel.innerHTML.includes('b-ps-cur'));
  assert('面板显示全片总弹幕', !!panel && panel.innerHTML.includes('8040'));

  clickAct('toggle', true);
  assert('点面板内的「×」后已收起', !!panel && !panel.classList.contains('is-open'));

  // 等 countAll 把另一个分P也算完
  setTimeout(() => {
    const total = SCENARIO === 'malformed' ? 2 : 14;
    assert('两个分P都统计完（' + total + ' 次）', segCalls === total);
    finish(dmCell);
  }, 1600);
}, 1600);
