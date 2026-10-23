/**
 * PC 端设置页：锁屏密码 + 设备配对 + 设备管理。
 *
 * 为什么要这个页面：锁屏密码与配对码此前只有 HTTP 接口，没有界面入口。
 * 结果是"功能实现了，但没人用得到"——用户不知道要 curl，也不会去翻文档。
 * 一个插件的能力如果只存在于接口层，等于没做。
 *
 * 形态选择：单文件 HTML（内联样式与脚本），由插件自己在 /dsh-link/setup 吐出。
 * 不引入前端构建链路——这是宿主侧的一个辅助页面，不值得为它加一个打包步骤，
 * 也不该让 dsh 的 Web 包体因此变大。
 */

export const SETUP_PATH = '/dsh-link/setup'

/** HTML 转义。hostId 来自本地文件但仍可能是任意字符串，不能直接插进模板。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

export function renderSetupPage(rawHostId: string, rawEndpoints: readonly string[], port: number): string {
  const hostId = escapeHtml(rawHostId)
  const endpoints = rawEndpoints.map(escapeHtml)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOSS Link · 设置</title>
<style>
  :root {
    --bg: #050806; --s1: #0b1210; --s2: #101a16;
    --bd: rgba(70,227,166,.18); --bd-strong: rgba(70,227,166,.42);
    --t1: #e6f3ec; --t2: #8fa79b; --t3: #5b6f66;
    --acc: #46e3a6; --warn: #e8c24a; --danger: #ff5c4d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 80px;
    background: radial-gradient(ellipse 80% 60% at 50% 0%, #0d1512, #050806 60%);
    color: var(--t1); font: 14px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    min-height: 100vh;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; letter-spacing: 2px; margin: 0 0 4px; font-weight: 700; }
  h1 span { color: var(--acc); }
  .sub { color: var(--t3); font-size: 12px; margin-bottom: 28px; }
  section {
    border: 1px solid var(--bd); border-radius: 10px; background: var(--s1);
    padding: 18px; margin-bottom: 16px;
  }
  h2 { font-size: 13px; margin: 0 0 4px; letter-spacing: 1px; font-weight: 600; }
  .desc { color: var(--t3); font-size: 12px; margin-bottom: 14px; }
  label { display: block; font-size: 12px; color: var(--t2); margin: 10px 0 5px; }
  input {
    width: 100%; height: 40px; padding: 0 12px; border-radius: 7px;
    border: 1px solid var(--bd); background: var(--bg); color: var(--t1);
    font: inherit; outline: none;
  }
  input:focus { border-color: var(--bd-strong); }
  button {
    height: 38px; padding: 0 16px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--bd-strong); background: var(--s2); color: var(--t1);
    font: inherit; transition: .15s;
  }
  button:hover { background: #16211c; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--acc); border-color: transparent; color: #04140e; font-weight: 600; }
  button.danger { border-color: rgba(255,92,77,.5); color: var(--danger); background: transparent; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  .msg { min-height: 20px; font-size: 12px; margin-top: 10px; }
  .msg.ok { color: var(--acc); }
  .msg.err { color: var(--danger); }
  .msg.warn { color: var(--warn); }
  .code {
    font-size: 40px; letter-spacing: 12px; text-align: center; padding: 18px 0 10px;
    color: var(--acc); font-weight: 700;
  }
  .code-hint { text-align: center; color: var(--t3); font-size: 12px; }
  .dev {
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    padding: 11px 0; border-top: 1px solid var(--bd);
  }
  .dev:first-child { border-top: 0; }
  .dev-info { min-width: 0; }
  .dev-name { font-size: 13px; }
  .dev-meta { color: var(--t3); font-size: 11px; margin-top: 2px; }
  .empty { color: var(--t3); font-size: 12px; padding: 8px 0; }
  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px;
    border: 1px solid var(--bd-strong); color: var(--acc); margin-left: 6px;
  }
  .status { font-size: 12px; color: var(--t2); margin-bottom: 14px; }
  .status b { color: var(--t1); font-weight: 600; }
  .status .off { color: var(--warn); }
  kbd {
    padding: 1px 5px; border-radius: 4px; border: 1px solid var(--bd);
    background: var(--bg); font-size: 11px;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>MOSS<span>LINK</span> / 设置</h1>
  <div class="sub">主机 <code>${hostId}</code> · 端口 <code>${String(port)}</code></div>

  <section>
    <h2>手机连接地址</h2>
    <div class="desc">
      在手机 App 的「添加电脑」里填下面任意一个地址。同一局域网内才可用。
    </div>
    ${endpoints.length === 0
      ? '<div class="empty">没有检测到局域网地址（可能处于离线或仅回环）</div>'
      : endpoints.map((url) => `<div class="dev"><code style="font-size:12px">${url}</code>
          <button data-copy="${url}">复制</button></div>`).join('')}
    <div class="desc" style="margin-top:12px;margin-bottom:0">
      首次连接需要配对：先在下面的「配对新设备」生成 6 位码，再在手机上输入。
    </div>
  </section>

  <div class="status" id="status">读取状态…</div>

  <!-- 锁屏 -->
  <section>
    <h2>锁屏密码</h2>
    <div class="desc">
      锁的是 dsh 的操作能力，不是操作系统登录屏。设密码之前锁屏不会生效。
    </div>
    <div id="pw-fields">
      <label>新密码（至少 8 位）</label>
      <input id="pw-next" type="password" autocomplete="new-password" placeholder="••••••••">
      <div id="pw-current-wrap" style="display:none">
        <label>当前密码</label>
        <input id="pw-current" type="password" autocomplete="current-password" placeholder="••••••••">
      </div>
    </div>
    <div class="row">
      <button class="primary" id="pw-save">设置密码</button>
      <button id="pw-lock">立即锁定</button>
      <button class="danger" id="pw-clear" style="display:none">清除密码</button>
    </div>
    <div class="msg" id="pw-msg"></div>
  </section>

  <!-- 配对 -->
  <section>
    <h2>配对新设备</h2>
    <div class="desc">
      点下面的按钮生成一个 6 位码，然后在手机上输入。码 2 分钟内有效，且只能使用一次。
    </div>
    <div class="row">
      <button class="primary" id="pair-start">生成配对码</button>
    </div>
    <div id="pair-out"></div>
    <div class="msg" id="pair-msg"></div>
  </section>

  <!-- 设备 -->
  <section>
    <h2>已配对设备</h2>
    <div class="desc">撤销后该设备的令牌立即失效，正在连接的也会被断开。</div>
    <div id="devices"><div class="empty">读取中…</div></div>
    <div class="msg" id="dev-msg"></div>
  </section>
</div>

<script>
(function () {
  var BASE = '/dsh-link'

  function api(path, body) {
    var opt = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    return fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, opt))
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .catch(function (e) { return { status: 0, body: { error: String(e) } } })
  }

  function say(el, text, kind) {
    var node = document.getElementById(el)
    node.textContent = text
    node.className = 'msg' + (kind ? ' ' + kind : '')
  }

  // ── 状态 ──────────────────────────────────────────────────────────────
  function refreshStatus() {
    return api('/lock').then(function (out) {
      if (out.status !== 200) {
        document.getElementById('status').innerHTML = '<span class="off">主机没有响应</span>'
        return
      }
      var b = out.body
      var armed = b.armed === true
      var hasPw = b.hasPassword === true
      document.getElementById('status').innerHTML =
        '锁屏：' + (armed ? '<b>已启用</b>' : '<span class="off">未生效</span>') +
        (hasPw ? '' : '（未设置密码）') +
        ' · 当前 ' + (b.locked ? '<b>已锁定</b>' : '未锁') +
        ' · 在线设备 ' + (b.connections || 0)

      // 有密码时切换成"改密码"形态
      document.getElementById('pw-current-wrap').style.display = hasPw ? 'block' : 'none'
      document.getElementById('pw-clear').style.display = hasPw ? 'inline-block' : 'none'
      document.getElementById('pw-save').textContent = hasPw ? '修改密码' : '设置密码'
    })
  }

  // ── 密码 ──────────────────────────────────────────────────────────────
  document.getElementById('pw-save').addEventListener('click', function () {
    var next = document.getElementById('pw-next').value
    var current = document.getElementById('pw-current').value
    if (next.length < 8) { say('pw-msg', '密码至少 8 位', 'err'); return }
    var payload = { next: next }
    if (document.getElementById('pw-current-wrap').style.display !== 'none') payload.current = current
    api('/lock/password', payload).then(function (out) {
      if (out.status === 200) {
        say('pw-msg', '密码已保存，锁屏已生效', 'ok')
        document.getElementById('pw-next').value = ''
        document.getElementById('pw-current').value = ''
        refreshStatus()
      } else {
        say('pw-msg', (out.body && out.body.error) || '保存失败', 'err')
      }
    })
  })

  document.getElementById('pw-lock').addEventListener('click', function () {
    api('/lock', { action: 'lock' }).then(function (out) {
      if (out.status === 200 && out.body && out.body.locked) say('pw-msg', '已锁定——刷新页面即可看到锁层', 'ok')
      else if (out.status === 200) say('pw-msg', '没有生效：请先设置密码', 'warn')
      else say('pw-msg', '锁定失败', 'err')
      refreshStatus()
    })
  })

  document.getElementById('pw-clear').addEventListener('click', function () {
    var current = document.getElementById('pw-current').value
    if (current.length === 0) { say('pw-msg', '清除密码需要先在下面填入当前密码', 'err'); return }
    if (!confirm('清除密码后锁屏不再生效，确定？')) return
    fetch(BASE + '/lock/password', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ current: current })
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .then(function (out) {
        if (out.status === 200) { say('pw-msg', '密码已清除，锁屏不再生效', 'ok'); document.getElementById('pw-current').value = ''; refreshStatus() }
        else say('pw-msg', (out.body && out.body.error) || '清除失败', 'err')
      })
  })

  // ── 配对 ──────────────────────────────────────────────────────────────
  document.getElementById('pair-start').addEventListener('click', function () {
    var btn = this
    btn.disabled = true
    api('/pair/start', {}).then(function (out) {
      btn.disabled = false
      if (out.status !== 200) { say('pair-msg', (out.body && out.body.error) || '生成失败', 'err'); return }
      var code = out.body.code
      var left = Math.max(0, Math.round((out.body.expiresAt - Date.now()) / 1000))
      document.getElementById('pair-out').innerHTML =
        '<div class="code">' + code + '</div>' +
        '<div class="code-hint">在手机上输入这个码 · <span id="ttl">' + left + '</span> 秒后失效</div>'
      say('pair-msg', '')
      var timer = setInterval(function () {
        left -= 1
        var el = document.getElementById('ttl')
        if (el) el.textContent = String(Math.max(0, left))
        if (left <= 0) {
          clearInterval(timer)
          var out = document.getElementById('pair-out')
          if (out) out.innerHTML = '<div class="code-hint" style="padding:16px 0">配对码已过期，请重新生成</div>'
        }
      }, 1000)
    })
  })

  // ── 设备 ──────────────────────────────────────────────────────────────
  function refreshDevices() {
    api('/pair/devices').then(function (out) {
      var box = document.getElementById('devices')
      if (out.status !== 200) { box.innerHTML = '<div class="empty">读取失败</div>'; return }
      var list = (out.body && out.body.devices) || []
      if (list.length === 0) { box.innerHTML = '<div class="empty">还没有配对任何设备</div>'; return }
      box.innerHTML = list.map(function (d) {
        var seen = new Date(d.lastSeen)
        var meta = (d.platform || '?') + ' · ' + d.role + ' · 最近 ' + seen.toLocaleString()
        return '<div class="dev">' +
          '<div class="dev-info"><div class="dev-name">' + esc(d.label) + '</div>' +
          '<div class="dev-meta">' + esc(meta) + '</div></div>' +
          '<button class="danger" data-revoke="' + esc(d.deviceId) + '">撤销</button>' +
          '</div>'
      }).join('')
      Array.prototype.forEach.call(box.querySelectorAll('[data-revoke]'), function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-revoke')
          if (!confirm('撤销这台设备？它需要重新配对才能再用。')) return
          api('/pair/revoke', { deviceId: id }).then(function (out) {
            if (out.status === 200) { say('dev-msg', '已撤销', 'ok'); refreshDevices(); refreshStatus() }
            else say('dev-msg', (out.body && out.body.error) || '撤销失败', 'err')
          })
        })
      })
    })
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // 复制连接地址：用户要把它填到手机里，手抄一串 ws:// 地址非常容易错
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy')
      var done = function () { var old = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = old }, 1200) }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { window.prompt('复制这个地址', text) })
      } else {
        window.prompt('复制这个地址', text)
      }
    })
  })

  refreshStatus()
  refreshDevices()
})()
</script>
</body>
</html>`
}
