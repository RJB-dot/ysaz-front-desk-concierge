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
    annList: document.getElementById('ann-list'),
    annCount: document.getElementById('ann-count'),
    copyScript: document.getElementById('copy-script'),
    copyStatus: document.getElementById('copy-status'),
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
      var today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
      var expiryHtml = '';
      if(e.validUntil) expiryHtml += '<div class="q-meta'+(e.validUntil < today ? ' q-warn' : '')+'">'+(e.validUntil < today ? 'Expired ' : 'Used through ')+escapeHtml(e.validUntil)+(e.validUntil < today ? ' — the concierge no longer uses this answer' : '')+'</div>';
      if(e.attachment && e.attachment.validUntil) expiryHtml += '<div class="q-meta'+(e.attachment.validUntil < today ? ' q-warn' : '')+'">Flyer '+(e.attachment.validUntil < today ? 'hidden since ' : 'shown through ')+escapeHtml(e.attachment.validUntil)+'</div>';
      if(e.attachment){
        flyerHtml = '<div class="file-row">📎 '+escapeHtml(e.attachment.filename || 'Flyer')+
          ' — <a href="/uploads/'+e.attachment.path+'" target="_blank" rel="noopener">view</a></div>';
      }
      item.innerHTML =
        '<div class="row"><div class="ttl">'+escapeHtml(e.title)+'</div>' +
        '<div class="kb-actions"><button data-act="edit">Edit</button><button data-act="del">Delete</button></div></div>' +
        '<div class="body">'+linkify(e.content)+'</div>' + flyerHtml + expiryHtml;
      item.querySelector('[data-act="edit"]').addEventListener('click', function(){ editInPlace(item, e); });
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

  // Edit an answer right inside its own box (title, answer, flyer) — the page doesn't move.
  function editInPlace(item, e){
    var removeFlyer = false;
    item.innerHTML =
      '<label>Title</label><input type="text" class="ed-title">' +
      '<label>Answer</label><textarea class="ed-content"></textarea>' +
      '<div class="file-row ed-flyer"></div>' +
      '<label>' + (e.attachment ? 'Replace the flyer' : 'Attach a flyer') + ' (optional — PDF or image)</label>' +
      '<input type="file" class="ed-file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp">' +
      '<div class="form-actions"><button type="button" class="btn primary ed-save">Save</button><button type="button" class="btn ed-cancel">Cancel</button></div>' +
      '<div class="status-msg ed-status"></div>';
    item.classList.add('editing');
    item.querySelector('.ed-title').value = e.title;
    var content = item.querySelector('.ed-content');
    content.value = e.content;
    content.style.height = Math.min(Math.max(content.scrollHeight + 4, 140), 600) + 'px';
    function renderFlyer(){
      var slot = item.querySelector('.ed-flyer');
      if(e.attachment && !removeFlyer){
        slot.innerHTML = '📎 <a href="/uploads/'+e.attachment.path+'" target="_blank" rel="noopener">'+escapeHtml(e.attachment.filename || 'Flyer')+'</a> ' +
          '<button type="button" class="btn danger ed-remove" style="margin-left:8px;">Remove</button>';
        slot.querySelector('.ed-remove').addEventListener('click', function(){ removeFlyer = true; renderFlyer(); });
      } else {
        slot.innerHTML = removeFlyer ? '<span class="q-meta">Flyer will be removed when you save.</span>' : '';
      }
    }
    renderFlyer();
    content.focus({ preventScroll: true });
    var status = item.querySelector('.ed-status');
    function say(msg, ok){ status.textContent = msg; status.className = 'status-msg ed-status ' + (ok ? 'ok' : 'err'); }
    item.querySelector('.ed-cancel').addEventListener('click', loadList);
    item.querySelector('.ed-save').addEventListener('click', function(){
      var title = item.querySelector('.ed-title').value.trim();
      var text = content.value.trim();
      if(!title || !text){ say('Title and answer are both required.', false); return; }
      var btn = item.querySelector('.ed-save');
      btn.disabled = true; say('Saving…', true);
      fetch('/api/admin/kb/'+e.id, {
        method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ title: title, content: text })
      }).then(function(r){ if(!r.ok) throw new Error(); }).then(function(){
        var file = item.querySelector('.ed-file').files[0];
        if(file){
          var fd = new FormData(); fd.append('file', file);
          return fetch('/api/admin/kb/'+e.id+'/attachment', { method:'POST', body: fd });
        }
        if(removeFlyer) return fetch('/api/admin/kb/'+e.id+'/attachment', { method:'DELETE' });
      }).then(loadList).catch(function(){ btn.disabled = false; say('Something went wrong saving that.', false); });
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
        escapeHtml(q.name) + (q.branch ? ' (' + escapeHtml(q.branch) + ')' : '') + ' · ' + fmtDate(q.createdAt) +
        (q.emailed ? ' · emailed to Support' : ' · <span class="q-warn">not emailed</span>');
      item.innerHTML =
        '<div class="row"><div class="ttl">'+escapeHtml(q.question)+'</div>' +
        '<div class="kb-actions">' +
          (q.handled ? '' : '<button data-act="answer">Add as answer</button>') +
          '<button data-act="toggle">'+(q.handled ? 'Reopen' : 'Mark handled')+'</button>' +
          '<button data-act="del">Delete</button>' +
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
      item.querySelector('[data-act="del"]').addEventListener('click', function(){
        if(!confirm('Delete this question?\n\n"' + q.question + '"\n\nThis can\'t be undone.')) return;
        fetch('/api/admin/questions/'+q.id, { method:'DELETE' }).then(loadQuestions);
      });
      els.qList.appendChild(item);
    });
  }

  // ---------- questions the concierge couldn't answer → fill in the missing info ----------
  var unList = document.getElementById('un-list');
  var unCount = document.getElementById('un-count');
  var unOpenBox = null;
  function loadUnanswered(openQuestion){
    return fetch('/api/admin/unanswered').then(function(r){ return r.json(); }).then(function(list){
      unCount.textContent = list.length;
      unList.innerHTML = list.length ? '' : '<div class="empty">Nothing waiting — every recent question was answered.</div>';
      var target = null;
      list.forEach(function(u){
        var item = renderUnanswered(u);
        if(openQuestion && u.question.trim().toLowerCase() === openQuestion.trim().toLowerCase()) target = item;
      });
      // Opened from an email/usage-page link: open that question (add it if it's no longer listed).
      if(openQuestion && !target){
        if(!list.length) unList.innerHTML = '';
        target = renderUnanswered({ question: openQuestion, count: 0, lastAt: null }, true);
      }
      if(target){ openAnswerBox(target); target.scrollIntoView({ behavior:'smooth', block:'start' }); }
      if(openQuestion) history.replaceState(null, '', '/admin'); // so a refresh doesn't reopen it
    }).catch(function(){ unList.innerHTML = '<div class="empty">Couldn\'t load unanswered questions.</div>'; });
  }
  function renderUnanswered(u, atTop){
    var item = document.createElement('div');
    item.className = 'kb-item';
    item._question = u.question;
    item.innerHTML =
      '<button type="button" class="un-q">' + escapeHtml(u.question) + '</button>' +
      '<div class="q-meta">' + (u.lastAt ? (u.count > 1 ? 'Asked ' + u.count + ' times · last ' : 'Asked ') + fmtDate(u.lastAt) : 'From the weekly report') + (u.askedBy && u.askedBy.length ? ' · by ' + escapeHtml(u.askedBy.join(', ')) : '') + '</div>';
    item.querySelector('.un-q').addEventListener('click', function(){
      if(item.querySelector('.un-box')) closeAnswerBox(item); else openAnswerBox(item);
    });
    if(atTop && unList.firstChild) unList.insertBefore(item, unList.firstChild); else unList.appendChild(item);
    return item;
  }
  function closeAnswerBox(item){
    var box = item.querySelector('.un-box');
    if(box) box.remove();
    if(unOpenBox === item) unOpenBox = null;
  }
  function openAnswerBox(item){
    if(unOpenBox && unOpenBox !== item) closeAnswerBox(unOpenBox);
    unOpenBox = item;
    var question = item._question;
    var box = document.createElement('div');
    box.className = 'un-box';
    box.innerHTML = '<div class="q-meta">Working out what information is needed…</div>';
    item.appendChild(box);
    fetch('/api/admin/unanswered/draft', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ question: question })
    }).then(function(r){ return r.json(); }).catch(function(){ return { title: question, needed: [], related: [] }; }).then(function(d){
      if(!box.isConnected) return;
      var html =
        (d.related && d.related.length ? '<div class="q-meta">Partly covered already by: <strong>' + d.related.map(escapeHtml).join('</strong>, <strong>') + '</strong> — you could edit that answer below instead.</div>' : '') +
        '<label>Title</label><input type="text" class="un-title" value="' + escapeHtml(d.title || question) + '">';
      (d.needed || []).forEach(function(n, i){
        html += '<label for="un-n'+i+'">' + escapeHtml(n) + '</label><input type="text" class="un-need" id="un-n'+i+'" data-label="' + escapeHtml(n) + '">';
      });
      html +=
        '<label>' + ((d.needed || []).length ? 'Anything else staff should know (optional)' : 'The answer') + '</label><textarea class="un-extra"></textarea>' +
        '<label>Attach a flyer (optional — PDF or image)</label><input type="file" class="un-file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp">' +
        '<div class="form-actions">' +
          '<button type="button" class="btn primary un-save">Save as answer</button>' +
          '<button type="button" class="btn un-dismiss">Doesn\'t need an answer</button>' +
          '<button type="button" class="btn un-cancel">Cancel</button>' +
        '</div><div class="status-msg un-status"></div>';
      box.innerHTML = html;
      var status = box.querySelector('.un-status');
      function say(msg, ok){ status.textContent = msg; status.className = 'status-msg un-status ' + (ok ? 'ok' : 'err'); }
      function markDone(){
        return fetch('/api/admin/unanswered/done', {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ question: question })
        });
      }
      box.querySelector('.un-cancel').addEventListener('click', function(){ closeAnswerBox(item); });
      box.querySelector('.un-dismiss').addEventListener('click', function(){
        if(!confirm('Remove this question from the list without adding an answer?')) return;
        markDone().then(function(){ loadUnanswered(); });
      });
      box.querySelector('.un-save').addEventListener('click', function(){
        var title = box.querySelector('.un-title').value.trim();
        var lines = [];
        box.querySelectorAll('.un-need').forEach(function(inp){
          if(inp.value.trim()) lines.push('- ' + inp.getAttribute('data-label') + ' ' + inp.value.trim());
        });
        var extra = box.querySelector('.un-extra').value.trim();
        if(extra) lines.push((lines.length ? '\n' : '') + extra);
        var content = lines.join('\n').trim();
        if(!title || !content){ say('Add a title and at least one piece of information.', false); return; }
        content += '\n\nSource: Admin, answering a staff question ("' + question + '"), ' + new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) + '.';
        var btn = box.querySelector('.un-save');
        btn.disabled = true; say('Saving…', true);
        fetch('/api/admin/kb', {
          method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ title: title, content: content })
        }).then(function(r){ if(!r.ok) throw new Error(); return r.json(); }).then(function(entry){
          var file = box.querySelector('.un-file').files[0];
          if(!file) return entry;
          var fd = new FormData(); fd.append('file', file);
          return fetch('/api/admin/kb/'+entry.id+'/attachment', { method:'POST', body: fd }).then(function(){ return entry; });
        }).then(markDone).then(function(){
          loadList();
          loadUnanswered();
        }).catch(function(){ btn.disabled = false; say('Something went wrong saving that.', false); });
      });
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
          (d.reviewedAt ? ' · last reviewed ' + fmtDate(d.reviewedAt) + '' : ' · not reviewed yet');
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
    if(!confirm('Download every tucsonymca.org page and review it for out-of-date content now? It takes a few minutes, costs about $0.70 in Claude usage. What it finds is shown here, and goes to anthonyf@tucsonymca.org with the Monday email.')) return;
    els.webCheckNow.disabled = true; els.webCheckNow.textContent = 'Checking…';
    fetch('/api/admin/web-pages/check', { method:'POST' }).then(function(){ setTimeout(loadWebPages, 1500); });
  });

  // ---------- announcements from the concierge@ mailbox ----------
  function loadAnnouncements(){
    fetch('/api/admin/announcements').then(function(r){ return r.json(); }).then(function(d){
      var live = d.entries.filter(function(a){ return a.status === 'live' && a.active; });
      els.annCount.textContent = live.length;
      if(!d.entries.length){
        els.annList.innerHTML = '<div class="empty">' + (d.emailsReceived ? 'Emails received, but none had announcements in them.' : 'No emails received yet — set up the Gmail connection below.') + '</div>';
        return;
      }
      els.annList.innerHTML = '';
      d.entries.forEach(function(a){
        var item = document.createElement('div');
        item.className = 'kb-item q-item' + (a.active ? '' : ' handled');
        var when = a.starts ? (a.ends && a.ends !== a.starts ? a.starts + ' to ' + a.ends : a.starts) : 'no date';
        var status = a.status === 'pending' ? '<span class="q-warn">Waiting for approval</span>' : (a.active ? 'Live' : 'Expired');
        item.innerHTML =
          '<div class="row"><div class="ttl">'+escapeHtml(a.title)+'</div><div class="kb-actions">' +
            (a.status === 'pending' ? '<button data-act="approve">Approve</button>' : '') +
            '<button data-act="del">Remove</button></div></div>' +
          '<div class="q-meta"><span class="q-topic">'+escapeHtml(a.category)+'</span> · ' + escapeHtml(a.branches.join(', ') || 'All branches') + ' · ' + escapeHtml(when) + ' · ' + status + '</div>' +
          '<div class="body">'+linkify(a.details)+'</div>' +
          (a.attachments || []).map(function(f){
            return '<div class="file-row">📎 <a href="/uploads/'+encodeURIComponent(f.path)+'" target="_blank" rel="noopener">'+escapeHtml(f.filename)+'</a></div>';
          }).join('') +
          '<div class="q-meta">From “'+escapeHtml(a.subject)+'” — '+escapeHtml(a.from)+' · '+fmtDate(a.receivedAt)+'</div>';
        var approve = item.querySelector('[data-act="approve"]');
        approve && approve.addEventListener('click', function(){
          fetch('/api/admin/announcements/'+a.id, { method:'PUT' }).then(loadAnnouncements);
        });
        item.querySelector('[data-act="del"]').addEventListener('click', function(){
          if(!confirm('Remove "'+a.title+'"? The concierge will stop using it.')) return;
          fetch('/api/admin/announcements/'+a.id, { method:'DELETE' }).then(loadAnnouncements);
        });
        els.annList.appendChild(item);
      });
    }).catch(function(){ els.annList.innerHTML = '<div class="empty">Couldn\'t load announcements.</div>'; });
  }
  els.copyScript.addEventListener('click', function(){
    fetch('/api/admin/email-setup').then(function(r){ return r.json(); }).then(function(d){
      return navigator.clipboard.writeText(d.script);
    }).then(function(){
      els.copyStatus.textContent = 'Copied — paste it into the script editor.'; els.copyStatus.className = 'status-msg ok';
    }).catch(function(){
      els.copyStatus.textContent = "Couldn't copy automatically — try again, or use a different browser."; els.copyStatus.className = 'status-msg err';
    });
  });

  loadAnnouncements();
  loadList();
  loadQuestions();
  loadUnanswered(new URLSearchParams(window.location.search).get('answer'));
  loadWebPages();
})();
