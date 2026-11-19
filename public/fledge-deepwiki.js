(function () {
  if (window.__fledgeDeepWiki) return;
  window.__fledgeDeepWiki = true;

  var REPO = 'HugoXK/fledge';
  var ENDPOINT = 'https://mcp.deepwiki.com/mcp';
  var PAGE = 'https://deepwiki.com/' + REPO;
  var body = document.body;
  var auth = body.getAttribute('data-fledge-auth') || 'out';
  var locale = body.getAttribute('data-fledge-locale') || 'zh';
  var path = body.getAttribute('data-fledge-path') || '/';
  var zh = locale !== 'en';

  var C = zh ? {
    title: 'DeepWiki', label: '问 DeepWiki', chat: '对话', open: '打开页面 \u2197',
    emptyTitle: '问关于 Fledge 的问题',
    empty: '功能、配置、权限、常见报错都可以问。答案来自 HugoXK/fledge 的 DeepWiki 索引；请对照源码核实。',
    placeholder: '问一个关于 Fledge 的问题\u2026', send: '发送', stop: '停止', retry: '重试',
    copy: '复制', copied: '已复制', caveats: '说明',
    footer: 'DeepWiki 是第三方、模型生成的；请对照源码核实。',
    info: '关于 DeepWiki 与 MCP', openPage: '打开 DeepWiki 页面 \u2197',
    thinking: '正在查索引\u2026', stopped: '已停止。准备好后再问。',
    unavailable: 'DeepWiki 暂时不可用：', unreadable: 'DeepWiki 返回了无法读取的内容。',
    emptyAnswer: 'DeepWiki 没有返回内容。', copyFailed: '复制失败',
  } : {
    title: 'DeepWiki', label: 'Ask DeepWiki', chat: 'Chat', open: 'Open page \u2197',
    emptyTitle: 'Ask about Fledge',
    empty: 'Ask about features, configuration, permissions, or common errors. Answers come from the HugoXK/fledge DeepWiki index; verify against the source.',
    placeholder: 'Ask a question about Fledge\u2026', send: 'Send', stop: 'Stop', retry: 'Retry',
    copy: 'Copy', copied: 'Copied', caveats: 'Caveats',
    footer: 'DeepWiki is third-party and model-generated; verify against the source.',
    info: 'About DeepWiki and MCP', openPage: 'Open the DeepWiki page \u2197',
    thinking: 'Searching the index\u2026', stopped: 'Stopped. Ask again when you are ready.',
    unavailable: 'DeepWiki is unavailable right now: ', unreadable: 'DeepWiki returned an unreadable response.',
    emptyAnswer: 'DeepWiki returned an empty answer.', copyFailed: 'Copy failed',
  };

  function suggestions() {
    if (auth !== 'in') return zh ? [
      ['Fledge 是做什么的？', '一个可以自己长大的托管仓库'],
      ['怎么连接一个仓库？', 'GitHub 登录、token、fork、目标'],
      ['GitHub token 需要什么权限？', '写权限、最小权限、审批'],
      ['PR 打开前会发生什么？', 'plan、review、测试、创建 PR'],
      ['常见报错（登录 / 权限）怎么处理？', '把症状贴出来，DeepWiki 会定位'],
    ] : [
      ['What does Fledge do?', 'Hosted repositories that grow themselves'],
      ['How do I connect a repository?', 'GitHub login, token, fork, goal'],
      ['What permissions does the GitHub token need?', 'Write access, least privilege, approval'],
      ['What happens before a pull request?', 'Plan, review, tests, one PR'],
      ['How do I fix login or permission errors?', 'Describe the symptom and ask'],
    ];
    var list = zh ? [
      ['模型 / API Key 在哪里配置？', 'Settings \u2192 Model / 自有模型回退'],
      ['额度在哪里看？', '平台额度、通知、402 错误'],
      ['怎么开启 auto-merge？', '仓库角色、review gate、合并条件'],
      ['quota exhausted 怎么处理？', '平台额度用完 / 自带模型'],
      ['仓库设置在哪里？', '目标、节奏、审批、允许/禁止路径'],
      ['常见报错（token invalid / PR check failed）怎么处理？', '认证、权限、检查失败'],
    ] : [
      ['Where do I configure the model / API key?', 'Settings \u2192 Model / own-model fallback'],
      ['Where is my quota?', 'Platform quota, notifications, 402'],
      ['How do I enable auto-merge?', 'Repo role, review gate, merge conditions'],
      ['How do I fix quota exhausted?', 'Platform quota vs your own model'],
      ['Where are repository settings?', 'Goal, cadence, approval, allow/deny paths'],
      ['How do I fix token invalid or PR check failed?', 'Auth, permissions, failing checks'],
    ];
    if (path.indexOf('/settings') === 0) list.unshift(list.splice(0, 1)[0]);
    if (path.indexOf('/dashboard') === 0 || path.indexOf('/repos') === 0) {
      var repo = list.findIndex(function (item) { return item[0].indexOf('仓库设置') === 0 || item[0].indexOf('repository settings') === 0; });
      if (repo > 0) list.unshift(list.splice(repo, 1)[0]);
    }
    if (path.indexOf('/pending') === 0) list.unshift(zh
      ? ['账号为什么还在审批？', '申请状态、管理员通知、审批后入口']
      : ['Why is my account still pending?', 'Application status, admin notification, access']);
    return list;
  }

  var items = suggestions();
  var icons = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5z"/><path d="M5 4.5v17"/><path d="M9 7h7M9 10h7"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/></svg>',
  };

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'fdw-launcher';
  launcher.id = 'fdw-launcher';
  launcher.title = C.label;
  launcher.setAttribute('aria-label', C.label);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'fdw-panel');
  launcher.innerHTML = icons.chat + '<span class="fdw-launcher-text">' + C.label + '</span><span class="fdw-dot" aria-hidden="true"></span>';

  var panel = document.createElement('section');
  panel.className = 'fdw-panel';
  panel.id = 'fdw-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'DeepWiki');
  panel.innerHTML = [
    '<header class="fdw-head">',
    '<div class="fdw-brand"><span class="fdw-logo">' + icons.logo + '</span>',
    '<div><strong>' + C.title + '</strong><span class="fdw-repo"><i></i>' + REPO + '</span></div></div>',
    '<div class="fdw-head-actions">',
    '<a class="fdw-icon-btn" href="' + PAGE + '" target="_blank" rel="noopener" title="' + C.info + '" aria-label="' + C.info + '">' + icons.info + '</a>',
    '<button type="button" class="fdw-icon-btn" id="fdw-new" aria-label="' + (zh ? '新对话' : 'New chat') + '" title="' + (zh ? '新对话' : 'New chat') + '">' + icons.refresh + '</button>',
    '<button type="button" class="fdw-icon-btn" id="fdw-close" aria-label="' + (zh ? '关闭' : 'Close') + '" title="' + (zh ? '关闭' : 'Close') + '">' + icons.close + '</button>',
    '</div></header>',
    '<div class="fdw-tabs"><button type="button" class="fdw-tab active">' + C.chat + '</button>',
    '<a class="fdw-tab" href="' + PAGE + '" target="_blank" rel="noopener">' + C.open + '</a></div>',
    '<div class="fdw-log" id="fdw-log" role="log" aria-live="polite">',
    '<div class="fdw-empty"><span class="fdw-empty-icon">' + icons.spark + '</span>',
    '<h3>' + C.emptyTitle + '</h3><p>' + C.empty + '</p><div class="fdw-prompts">',
    items.map(function (item) {
      return '<button type="button" class="fdw-prompt" data-q="' + item[0].replace(/"/g, '&quot;') + '"><span>' + item[0] + '</span><small>' + item[1] + '</small><b>\u2192</b></button>';
    }).join(''),
    '</div></div></div>',
    '<form class="fdw-form" id="fdw-form"><div class="fdw-input-wrap">',
    '<textarea id="fdw-input" rows="1" placeholder="' + C.placeholder + '" aria-label="' + C.placeholder + '"></textarea>',
    '<button type="submit" class="fdw-send" id="fdw-send" aria-label="' + C.send + '">' + icons.send + '</button>',
    '</div><div class="fdw-hint"><span>' + C.footer + '</span><a href="' + PAGE + '" target="_blank" rel="noopener">' + C.caveats + '</a></div></form>',
  ].join('');

  body.appendChild(launcher);
  body.appendChild(panel);

  var log = panel.querySelector('#fdw-log');
  var form = panel.querySelector('#fdw-form');
  var input = panel.querySelector('#fdw-input');
  var send = panel.querySelector('#fdw-send');
  var close = panel.querySelector('#fdw-close');
  var newChat = panel.querySelector('#fdw-new');
  var emptyTemplate = log.querySelector('.fdw-empty').cloneNode(true);
  var busy = false;
  var history = [];
  var controller = null;

  function scroll() { log.scrollTop = log.scrollHeight; }
  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }
  function bindPrompts(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.fdw-prompt'), function (prompt) {
      prompt.addEventListener('click', function () {
        input.value = prompt.getAttribute('data-q') || '';
        form.requestSubmit();
      });
    });
  }
  function resetChat() {
    if (controller) { controller.abort(); controller = null; }
    history = [];
    while (log.firstChild) log.removeChild(log.firstChild);
    var empty = emptyTemplate.cloneNode(true);
    log.appendChild(empty);
    bindPrompts(empty);
    input.value = '';
    input.style.height = 'auto';
    input.focus();
  }

  launcher.addEventListener('click', function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  close.addEventListener('click', closePanel);
  newChat.addEventListener('click', resetChat);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });
  document.addEventListener('click', function (event) {
    if (!event.target || !event.target.closest) return;
    if (event.target.closest('[data-fdw-open]')) { event.preventDefault(); openPanel(); }
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  });

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }
  function inline(text) {
    var value = escapeHtml(text);
    value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    value = value.replace(/\[([^\]]+)\]\((\/[^\s)]+)\)/g, '<a href="https://deepwiki.com$2" target="_blank" rel="noopener">$1</a>');
    return value;
  }
  function renderProse(text) {
    var lines = text.split(/\r?\n/);
    var html = '';
    var paragraph = [];
    var list = null;
    function flush() {
      if (paragraph.length) { html += '<p>' + inline(paragraph.join(' ')) + '</p>'; paragraph = []; }
    }
    function closeList() { if (list) { html += '</' + list + '>'; list = null; } }
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) { flush(); closeList(); return; }
      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) { flush(); closeList(); html += '<h4>' + inline(heading[2]) + '</h4>'; return; }
      var unordered = line.match(/^[-*]\s+(.*)$/);
      if (unordered) { flush(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(unordered[1]) + '</li>'; return; }
      var ordered = line.match(/^\d+\.\s+(.*)$/);
      if (ordered) { flush(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(ordered[1]) + '</li>'; return; }
      var quote = line.match(/^>\s?(.*)$/);
      if (quote) { flush(); closeList(); html += '<blockquote>' + inline(quote[1]) + '</blockquote>'; return; }
      paragraph.push(line);
    });
    flush(); closeList();
    return html;
  }
  function renderMarkdown(text) {
    var parts = String(text || '').split(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g);
    var html = '';
    for (var i = 0; i < parts.length; i += 2) {
      if (parts[i]) html += renderProse(parts[i]);
      if (i + 1 < parts.length) html += '<pre><code>' + escapeHtml(parts[i + 1].replace(/\n$/, '')) + '</code></pre>';
    }
    return html || '<p>' + escapeHtml(text) + '</p>';
  }
  function copyText(text, button) {
    if (!navigator.clipboard) { button.textContent = C.copyFailed; return; }
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = C.copied;
      setTimeout(function () { button.textContent = C.copy; }, 1400);
    }).catch(function () { button.textContent = C.copyFailed; });
  }
  function message(role, text) {
    var row = document.createElement('div');
    row.className = 'fdw-msg fdw-' + role;
    if (role === 'bot') {
      var avatar = document.createElement('span');
      avatar.className = 'fdw-avatar';
      avatar.textContent = 'DW';
      row.appendChild(avatar);
    }
    var bubble = document.createElement('div');
    bubble.className = 'fdw-bubble';
    if (role === 'user') {
      bubble.textContent = text;
    } else {
      var meta = document.createElement('div');
      meta.className = 'fdw-meta-row';
      var label = document.createElement('span');
      label.className = 'fdw-meta';
      label.textContent = 'DeepWiki';
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'fdw-copy';
      copy.textContent = C.copy;
      copy.addEventListener('click', function () { copyText(text, copy); });
      meta.appendChild(label); meta.appendChild(copy);
      var bodyEl = document.createElement('div');
      bodyEl.className = 'fdw-md';
      bodyEl.innerHTML = renderMarkdown(text);
      bubble.appendChild(meta); bubble.appendChild(bodyEl);
    }
    row.appendChild(bubble);
    log.appendChild(row);
    scroll();
    return row;
  }
  function thinking() {
    var row = document.createElement('div');
    row.className = 'fdw-msg fdw-bot fdw-thinking';
    row.innerHTML = '<span class="fdw-avatar">DW</span><div class="fdw-bubble"><span class="fdw-dots"><i></i><i></i><i></i></span><span>' + C.thinking + '</span><button type="button" class="fdw-stop">' + C.stop + '</button></div>';
    log.appendChild(row);
    scroll();
    return row;
  }
  function error(text, question) {
    var row = message('bot', text);
    row.querySelector('.fdw-bubble').classList.add('fdw-error');
    var link = document.createElement('p');
    link.innerHTML = '<a href="' + PAGE + '" target="_blank" rel="noopener">' + C.openPage + '</a>';
    row.querySelector('.fdw-md').appendChild(link);
    if (question) {
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'fdw-retry';
      retry.textContent = C.retry;
      retry.addEventListener('click', function () { row.remove(); ask(question); });
      row.querySelector('.fdw-md').appendChild(retry);
    }
    scroll();
  }
  function parseSse(raw) {
    var last = null;
    raw.split(/\r?\n/).forEach(function (line) {
      if (line.indexOf('data: ') !== 0) return;
      try {
        var obj = JSON.parse(line.slice(6));
        if (obj && (obj.result || obj.error)) last = obj;
      } catch (e) { /* keep-alive */ }
    });
    if (!last) {
      try {
        var direct = JSON.parse(raw);
        if (direct && (direct.result || direct.error)) last = direct;
      } catch (e) { /* not JSON */ }
    }
    return last;
  }
  function call(question, signal) {
    var bodyPayload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ask_wiki_question', arguments: { repoName: REPO, question: question } },
    };
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(bodyPayload),
      signal: signal,
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    }).then(function (raw) {
      var payload = parseSse(raw);
      if (!payload) throw new Error(C.unreadable);
      if (payload.error) throw new Error(payload.error.message || C.unreadable);
      var result = payload.result || {};
      var text = (result.content || []).map(function (part) { return part.text || ''; }).join('\n').trim();
      if (result.isError) return { ok: false, text: text || C.emptyAnswer };
      return { ok: true, text: text || C.emptyAnswer };
    });
  }
  function ask(question) {
    if (busy) return;
    busy = true;
    send.disabled = true;
    var empty = log.querySelector('.fdw-empty');
    if (empty) empty.remove();
    message('user', question);
    var pending = thinking();
    var stop = pending.querySelector('.fdw-stop');
    if (stop) stop.addEventListener('click', function () { if (controller) controller.abort(); });
    var context = history.slice(-2).map(function (item) { return 'Q: ' + item.q + '\nA: ' + item.a.slice(0, 900); }).join('\n\n');
    var prompt = context ? 'Previous conversation for context:\n' + context + '\n\nNew question: ' + question : question;
    controller = ('AbortController' in window) ? new AbortController() : null;
    call(prompt, controller ? controller.signal : undefined).then(function (result) {
      if (pending.parentNode) pending.remove();
      if (result.ok) {
        history.push({ q: question, a: result.text });
        if (history.length > 4) history.shift();
        message('bot', result.text);
      } else {
        error(result.text, question);
      }
    }).catch(function (failure) {
      if (pending.parentNode) pending.remove();
      if (failure && failure.name === 'AbortError') error(C.stopped, question);
      else error(C.unavailable + (failure.message || 'unknown'), question);
    }).then(function () {
      controller = null;
      busy = false;
      send.disabled = false;
      input.focus();
    });
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var question = input.value.trim();
    if (!question) return;
    input.value = '';
    input.style.height = 'auto';
    ask(question);
  });
  bindPrompts(log);
})();
