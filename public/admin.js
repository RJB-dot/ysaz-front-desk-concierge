(function(){
  var els = {
    form: document.getElementById('kb-form'),
    title: document.getElementById('f-title'),
    content: document.getElementById('f-content'),
    file: document.getElementById('f-file'),
    fileCurrent: document.getElementById('file-current'),
    save: document.getElementById('f-save'),
    cancel: document.getElementById('f-cancel'),
    status: document.getElementById('f-status'),
    formTitle: document.getElementById('form-title'),
    list: document.getElementById('kb-list'),
    count: document.getElementById('kb-count'),
    logout: document.getElementById('logout-link'),
    qList: document.getElementById('q-list'),
    qOpenCount: document.getElementById('q-open-count'),
    qHint: document.getElementById('q-hint'),
    webList: document.getElementById('web-list'),
    webCheckNow: document.getElementById('web-check-now'),
  };
  var editingId = null;
  var editingEntry = null;
  var removeAttachmentFlag = false;

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  var LINK_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(https?:\/\/[^\s<>"']+)|(www\.[^\s<>"']+)|((?<![\w@.\/])(?:[a-z0-9][a-z0-9-]*\.)+(?:com|org|net|edu|gov|io)(?:\/[^\s<>"']*)?)/gi;
  function linkify(s){
    return escapeHtml(s).replace(LINK_RE, function(m){
      var trail = '';
      while(m && /[.,;:!?)\]}]$/.test(m)){ trail = m.slice(-1) + trail; m = m.slice(0, -1); }
      if(!m) return trail;
      var href;
      if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) href = 'mailto:' + m;
      else if(/^https?:\/\//i.test(m)) href = m;
      else href = 'https://' + m;
      return '<a href="'+href+'" target="_blank" rel="noopener">'+m+'</a>' + trail;
    });
  }

  els.logout.addEventListener('click', function(ev){
    ev.preventDefault();
    fetch('/api/logout', { method: 'POST' }).then(function(){ window.location.href = '/'; });
  });

  function renderFileCurrent(){
    if(editingEntry && editingEntry.attachment && !removeAttachmentFlag){
      els.fileCurrent.innerHTML =
        '📎 <span>'+escapeHtml(editingEntry.attachment.filename || 'Attached flyer')+'</span> ' +
        '<button type="button" class="btn danger" id="remove-attachment" style="margin-left:8px;">Remove</button>';
      var btn = document.getElementById('remove-attachment');
      btn.addEventListener('click', function(){ removeAttachmentFlag = true; renderFileCurrent(); });
    } else {
      els.fileCurrent.innerHTML = '';
    }
  }

  function resetForm(){
    editingId = null; editingEntry = null; removeAttachmentFlag = false;
    els.title.value = ''; els.content.value = ''; els.file.value = '';
    els.formTitle.textContent = 'Add a new answer';
    els.cancel.hidden = true;
    els.status.textContent = ''; els.status.className = 'status-msg';
    renderFileCurrent();
  }
  els.cancel.addEventListener('click', resetForm);

  function startEdit(entry){
    editingId = entry.id; editingEntry = entry; removeAttachmentFlag = false;
    els.title.value = entry.title; els.content.value = entry.content; els.file.value = '';
    els.formTitle.textContent = 'Edit answer';
    els.cancel.hidden = false;
    els.status.textContent = ''; els.status.className = 'status-msg';
    renderFileCurrent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setStatus(msg, ok){
    els.status.textContent = msg;
    els.status.className = 'status-msg ' + (ok ? 'ok' : 'err');
  }

  function loadList(){
    fetch('/api/admin/kb').then(function(r){ return r.json(); }).then(renderList).catch(function(){
      els.list.innerHTML = '<div class="empty">Couldn\'t load saved answers.</div>';
    });
  }

  function renderList(entries){
    els.count.textContent = entries.length;
    if(!entries.length){
      els.list.innerHTML = '<div class="empty">Nothing saved yet. Add the first answer on the left.</div>';
      return;
    }
    els.list.innerHTML = '';
    entries.forEach(function(e){
      var item = document.createElement('div');
      item.className = 'kb-item';
      var flyerHtml = '';
      if(e.attachment){
        flyerHtml = '<div class="file-row">📎 '+escapeHtml(e.attachment.filename || 'Flyer')+
          ' — <a href="/uploads/'+e.attachment.path+'" target="_blank" rel="noopener">view</a></div>';
      }
      item.innerHTML =
        '<div class="row"><div class="ttl">'+escapeHtml(e.title)+'</div>' +
        '<div class="kb-actions"><button data-act="edit">Edit</button><button data-act="del">Delete</button></div></div>' +
        '<div class="body">'+linkify(e.content)+'</div>' + flyerHtml;
      item.querySelector('[data-act="edit"]').addEventListener('click', function(){ startEdit(e); });
      item.querySelector('[data-act="del"]').addEventListener('click', function(){
        if(!confirm('Delete "'+e.title+'"? This can\'t be undone.')) return;
        fetch('/api/admin/kb/'+e.id, { method:'DELETE' }).then(function(){
          if(editingId === e.id) resetForm();
          loadList();
        });
      });
      els.list.appendChild(item);
    });
  }

  els.form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var title = els.title.value.trim();
    var content = els.content.value.trim();
    if(!title || !content){ setStatus('Title and answer are both required.', false); return; }
    els.save.disabled = true; setStatus('Saving…', true);

    var method = editingId ? 'PUT' : 'POST';
    var url = editingId ? '/api/admin/kb/'+editingId : '/api/admin/kb';

    fetch(url, {
      method: method, headers: {'content-type':'application/json'},
      body: JSON.stringify({ title: title, content: content })
    }).then(function(r){ return r.json(); }).then(function(entry){
      var afterSave = function(){
        setStatus('Saved.', true);
        loadList();
        resetForm();
      };
      var file = els.file.files[0];
      if(file){
        var fd = new FormData(); fd.append('file', file);
        fetch('/api/admin/kb/'+entry.id+'/attachment', { method:'POST', body: fd })
          .then(afterSave).catch(function(){ setStatus('Saved, but the flyer upload failed.', false); loadList(); resetForm(); });
      } else if(removeAttachmentFlag && entry.id){
        fetch('/api/admin/kb/'+entry.id+'/attachment', { method:'DELETE' }).then(afterSave);
      } else {
        afterSave();
      }
    }).catch(function(){
      setStatus('Something went wrong saving that.', false);
    }).finally(function(){ els.save.disabled = false; });
  });

  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){
    if(d && d.demoMode){
      var slot = document.getElementById('demo-banner-slot');
      var b = document.createElement('div');
      b.className = 'demo-banner';
      b.textContent = 'Demo mode — no Anthropic API key configured yet. The knowledge base editor below works normally either way.';
      slot.appendChild(b);
    }
  }).catch(function(){});

  // ---------- questions staff sent to Support ----------
  function fmtDate(ms){
    return new Date(ms).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }
  function loadQuestions(){
    fetch('/api/admin/questions').then(function(r){ return r.json(); }).then(renderQuestions).catch(function(){
      els.qList.innerHTML = '<div class="empty">Couldn\'t load staff questions.</div>';
    });
  }
  function setHandled(q, handled){
    fetch('/api/admin/questions/'+q.id, {
      method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ handled: handled })
    }).then(loadQuestions);
  }
  function renderQuestions(entries){
    var open = entries.filter(function(q){ return !q.handled; });
    els.qOpenCount.textContent = open.length;
    els.qHint.textContent = entries.length
      ? 'Once a question is answered, click "Add as answer" so the concierge knows it next time, then mark it handled.'
      : '';
    if(!entries.length){
      els.qList.innerHTML = '<div class="empty">No questions yet. When front desk staff use "Ask Support", they\'ll show up here.</div>';
      return;
    }
    els.qList.innerHTML = '';
    entries.forEach(function(q){
      var item = document.createElement('div');
      item.className = 'kb-item q-item' + (q.handled ? ' handled' : '');
      var meta = (q.topic ? '<span class="q-topic">' + escapeHtml(q.topic) + '</span> · ' : '') +
        escapeHtml(q.name) + ' · ' + fmtDate(q.createdAt) +
        (q.emailed ? ' · emailed to Support' : ' · <span class="q-warn">not emailed</span>');
      item.innerHTML =
        '<div class="row"><div class="ttl">'+escapeHtml(q.question)+'</div>' +
        '<div class="kb-actions">' +
          (q.handled ? '' : '<button data-act="answer">Add as answer</button>') +
          '<button data-act="toggle">'+(q.handled ? 'Reopen' : 'Mark handled')+'</button>' +
        '</div></div>' +
        '<div class="q-meta">'+meta+'</div>';
      var answerBtn = item.querySelector('[data-act="answer"]');
      answerBtn && answerBtn.addEventListener('click', function(){
        resetForm();
        els.title.value = q.question;
        els.content.focus();
        els.form.scrollIntoView({ behavior:'smooth', block:'start' });
      });
      item.querySelector('[data-act="toggle"]').addEventListener('click', function(){ setHandled(q, !q.handled); });
      els.qList.appendChild(item);
    });
  }

  // ---------- tucsonymca.org: weekly download of every page + out-of-date review ----------
  var webPoll = null;
  function loadWebPages(){
    fetch('/api/admin/web-pages').then(function(r){ return r.json(); }).then(function(d){
      els.webList.innerHTML = '';
      var summary = document.createElement('div');
      summary.className = 'q-meta';
      summary.innerHTML = d.running
        ? '⏳ Checking the website now (downloading every page, then reviewing it) — this takes a few minutes…'
        : (d.crawledAt ? d.pageCount + ' pages downloaded ' + fmtDate(d.crawledAt) : 'Not downloaded yet') +
          (d.failed.length ? ' · <span class="q-warn">' + d.failed.length + ' failed</span>' : '') +
          (d.reviewedAt ? ' · last reviewed ' + fmtDate(d.reviewedAt) + (d.emailed ? ' (emailed to Support)' : '') : ' · not reviewed yet');
      els.webList.appendChild(summary);

      var h = document.createElement('h3');
      h.className = 'web-sub';
      var total = d.issues.reduce(function(n, p){ return n + p.items.length; }, 0);
      h.textContent = d.reviewedAt ? (total ? 'May be out of date (' + total + ')' : 'Nothing out of date found in the last review') : '';
      if(h.textContent) els.webList.appendChild(h);
      d.issues.forEach(function(p){
        var item = document.createElement('div');
        item.className = 'kb-item';
        item.innerHTML = '<div class="ttl"><a href="'+escapeHtml(p.url)+'" target="_blank" rel="noopener">'+escapeHtml(p.title)+'</a></div>' +
          p.items.map(function(i){
            return '<div class="body">' + (i.isNew ? '<span class="q-topic">NEW</span> ' : '') + '“' + escapeHtml(i.quote) + '”<br><span class="q-meta">' + escapeHtml(i.problem) + '</span></div>';
          }).join('');
        els.webList.appendChild(item);
      });

      var ph = document.createElement('h3');
      ph.className = 'web-sub';
      ph.textContent = 'Always included with every question';
      els.webList.appendChild(ph);
      d.pinned.forEach(function(p){
        var item = document.createElement('div');
        item.className = 'q-meta';
        item.innerHTML = '<a href="'+escapeHtml(p.url)+'" target="_blank" rel="noopener">'+escapeHtml(p.title)+'</a>' +
          (p.changedAt ? ' · last changed ' + fmtDate(p.changedAt) : '') + (p.error ? ' · <span class="q-warn">last check failed</span>' : '');
        els.webList.appendChild(item);
      });

      els.webCheckNow.disabled = d.running;
      els.webCheckNow.textContent = d.running ? 'Checking…' : 'Check now';
      clearTimeout(webPoll);
      if(d.running) webPoll = setTimeout(loadWebPages, 10000);
    }).catch(function(){ els.webList.innerHTML = '<div class="empty">Couldn\'t load website status.</div>'; });
  }
  els.webCheckNow.addEventListener('click', function(){
    if(!confirm('Download every tucsonymca.org page and review it for out-of-date content now? It takes a few minutes, costs about $0.70 in Claude usage, and emails Support if it finds anything.')) return;
    els.webCheckNow.disabled = true; els.webCheckNow.textContent = 'Checking…';
    fetch('/api/admin/web-pages/check', { method:'POST' }).then(function(){ setTimeout(loadWebPages, 1500); });
  });

  loadList();
  loadQuestions();
  loadWebPages();
})();
