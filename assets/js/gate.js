/* ============================================================
   阳光3S遥感平台 · 访问门禁（测试版）
   ------------------------------------------------------------
   ⚠️ 安全边界（必须知悉，勿误以为这是真安全）：
   GitHub Pages 是【纯静态托管】，没有服务端，因此本页的"密码"
   只能做「 casual 门禁」—— 挡住普通误入者，挡不住技术人。

   任何人可：
     · 在浏览器开发者工具里删掉这个遮罩层
     · 查看本页 JS 源码看到哈希值
   所以它【不是】访问控制，不能承载真实敏感数据。

   真要加密级保护，必须改为：
     ① Cloudflare Access / 自建服务器 Basic Auth
     ② WorkBuddy「发布应用」（带鉴权的沙箱域名）
     ③ 后端服务校验会话

   已做：仅存 SHA-256 哈希，明文密码不写入任何文件。
   ============================================================ */
(function () {
  'use strict';

  // SHA-256( '访问密码' )——明文不写入本文件
  var HASH = '2c13ed08244da02d611cc5296c9fd8bb9c076a946c2a6002242d7a30d8981c14';
  var SESSION_KEY = 'sf3s_gate_ok_v1';

  // 已登录过则直接放行（同一浏览器会话内不重复询问）
  try {
    if (sessionStorage.getItem(SESSION_KEY) === '1') { apply(); return; }
  } catch (e) { /* 隐私模式禁用 storage，降级为每次询问 */ }

  function apply() { /* 占位：放行状态无需额外处理，遮罩已在构造时移除 */ }

  /* ---------- SHA-256（浏览器原生 SubtleCrypto） ---------- */
  function sha256(text) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(text)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf),
            function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        });
    }
    return Promise.reject(new Error('no-subtle-crypto'));
  }

  function mount() {
    var wrap = document.createElement('div');
    wrap.id = 'sfGate';
    wrap.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:linear-gradient(145deg,#0a1423 0%,#0f2035 55%,#14283f 100%)',
      'display:grid', 'place-items:center', 'font-family:-apple-system,',
      '"PingFang SC","Microsoft YaHei",sans-serif'
    ].join(';');
    wrap.innerHTML = [
      '<div style="max-width:380px;width:calc(100% - 48px);text-align:center">',
      '  <img src="assets/img/sunflower-logo.png" alt="" width="60" height="60"',
      '       style="filter:drop-shadow(0 4px 12px rgba(193,39,45,.45))">',
      '  <div style="color:#e8f0f8;font-size:21px;font-weight:800;margin:14px 0 4px">',
      '    阳光<span style="color:#ffd98a">3S遥感平台</span></div>',
      '  <div style="color:#ffd98a;font-size:12.5px;letter-spacing:2px;',
      '       border:1px solid rgba(193,39,45,.55);display:inline-block;',
      '       padding:2px 12px;border-radius:999px;margin-bottom:18px">测试版</div>',
      '  <div style="color:#8aa0b8;font-size:11px;margin-bottom:16px">',
      '    请输入访问密码</div>',
      '  <input id="sfGatePw" type="password" autocomplete="current-password"',
      '    placeholder="访问密码"',
      '    style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;',
      'border:1px solid rgba(120,170,220,.28);background:rgba(255,255,255,.05);',
      '      color:#e8f0f8;font-size:14.5px;outline:none;text-align:center;',
      '      letter-spacing:2px">',
      '  <div id="sfGateMsg" style="color:#ff8080;font-size:12px;min-height:18px;',
      '       margin-top:9px"></div>',
      '  <button id="sfGateBtn"',
      '    style="width:100%;margin-top:4px;padding:11px;border-radius:10px;border:0;',
      '      background:linear-gradient(135deg,#FFD84D,#FFB800);color:#3B2300;',
      '      font-size:14.5px;font-weight:800;cursor:pointer">进入平台</button>',
      '  <div style="color:#5d7086;font-size:10.5px;margin-top:16px;line-height:1.6">',
      '    本平台为测试版本，数据仅供演示<br>使用范围以公司最新内控文件为准</div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap);
    // 锁定背景滚动
    document.documentElement.style.overflow = 'hidden';

    var pw = wrap.querySelector('#sfGatePw');
    var msg = wrap.querySelector('#sfGateMsg');
    var btn = wrap.querySelector('#sfGateBtn');
    setTimeout(function () { pw.focus(); }, 60);

    function tryIn() {
      var v = pw.value || '';
      if (!v) { msg.textContent = '请输入密码'; return; }
      sha256(v).then(function (h) {
        if (h === HASH) {
          try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { }
          wrap.remove();
          document.documentElement.style.overflow = '';
        } else {
          msg.textContent = '密码不正确，请重试';
          pw.value = '';
          pw.focus();
        }
      }).catch(function () {
        // 无 SubtleCrypto（如非 https 环境）→ 无法校验，明确提示而非降级明文比对
        msg.textContent = '当前环境不支持安全校验，请用 https 访问';
        pw.value = '';
      });
    }
    btn.addEventListener('click', tryIn);
    pw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryIn(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();