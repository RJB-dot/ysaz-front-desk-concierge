(function(){
  var els = {
    thread: document.getElementById('thread'),
    intro: document.getElementById('intro'),
    composer: document.getElementById('composer'),
    q: document.getElementById('q'),
    send: document.getElementById('send'),
    menuBtn: document.getElementById('menu-btn'),
    scrim: document.getElementById('scrim'),
    rail: document.getElementById('rail'),
    logoutBtn: document.getElementById('logout-btn'),
    askSupportBtn: document.getElementById('ask-support-btn'),
    dlg: document.getElementById('support-dialog'),
    sForm: document.getElementById('support-form'),
    sQuestion: document.getElementById('s-question'),
    sName: document.getElementById('s-name'),
    sTopic: document.getElementById('s-topic'),
    sOtherWrap: document.getElementById('s-other-wrap'),
    sOther: document.getElementById('s-other'),
    sStatus: document.getElementById('s-status'),
    sSend: document.getElementById('s-send'),
    sCancel: document.getElementById('s-cancel'),
  };
  var history = [];

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

  function autoGrow(){
    els.q.style.height = 'auto';
    els.q.style.height = Math.min(els.q.scrollHeight, 120) + 'px';
  }
  els.q.addEventListener('input', autoGrow);
  els.q.addEventListener('keydown', function(ev){
    if(ev.key === 'Enter' && !ev.shiftKey){ ev.preventDefault(); els.composer.requestSubmit(); }
  });

  els.menuBtn && els.menuBtn.addEventListener('click', function(){ els.rail.classList.add('open'); els.scrim.hidden = false; });
  els.scrim && els.scrim.addEventListener('click', function(){ els.rail.classList.remove('open'); els.scrim.hidden = true; });

  els.logoutBtn && els.logoutBtn.addEventListener('click', function(){
    fetch('/api/logout', { method: 'POST' }).then(function(){ window.location.href = '/'; });
  });

  function addMsg(role, text, pending){
    if(els.intro){ els.intro.remove(); els.intro = null; }
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Assistant';
    var bubble = document.createElement('div');
    bubble.className = 'bubble' + (pending ? ' pending' : '');
    bubble.textContent = text;
    wrap.appendChild(who); wrap.appendChild(bubble);
    els.thread.appendChild(wrap);
    els.thread.scrollTop = els.thread.scrollHeight;
    return bubble;
  }
  function addNote(text, warn){
    var n = document.createElement('div');
    n.className = 'note' + (warn ? ' warn' : '');
    n.textContent = text;
    els.thread.appendChild(n);
    els.thread.scrollTop = els.thread.scrollHeight;
  }
  function appendFlyerChips(afterEl, flyers){
    flyers.forEach(function(f){
      var isImg = /\.(png|jpe?g|gif|webp)$/i.test(f.filename || '');
      var a = document.createElement('a');
      a.className = 'flyer-chip'; a.href = f.url; a.target = '_blank'; a.rel = 'noopener';
      a.innerHTML = (isImg ? '<img src="'+f.url+'">' : '📎') + '<span>'+escapeHtml(f.filename || f.title)+'</span>';
      afterEl.appendChild(a);
    });
  }

  // ---------- "Ask Support": send a question the concierge couldn't answer ----------
  // Name is remembered on this computer so staff don't retype it every time.
  function remembered(key){ try { return localStorage.getItem(key) || ''; } catch(e){ return ''; } }
  function remember(key, val){ try { localStorage.setItem(key, val); } catch(e){} }

  function openSupport(question){
    els.sQuestion.value = question || '';
    els.sName.value = remembered('fdc_name');
    els.sTopic.value = ''; els.sOther.value = ''; showOther();
    els.sStatus.textContent = ''; els.sStatus.className = 'dlg-status';
    els.sSend.disabled = false;
    els.rail.classList.remove('open'); els.scrim.hidden = true;
    els.dlg.showModal();
    (els.sName.value ? els.sTopic : els.sName).focus();
  }
  function showOther(){
    var isOther = els.sTopic.value === 'Other';
    els.sOtherWrap.hidden = !isOther;
    els.sOther.required = isOther;
    return isOther;
  }
  els.sTopic.addEventListener('change', function(){ if(showOther()) els.sOther.focus(); });
  els.askSupportBtn.addEventListener('click', function(){ openSupport(''); });
  els.sCancel.addEventListener('click', function(){ els.dlg.close(); });

  els.sForm.addEventListener('submit', function(ev){
    ev.preventDefault();
    var payload = {
      question: els.sQuestion.value.trim(), name: els.sName.value.trim(),
      topic: els.sTopic.value === 'Other' ? 'Other: ' + els.sOther.value.trim() : els.sTopic.value
    };
    if(!payload.question || !payload.name || !els.sTopic.value || (els.sTopic.value === 'Other' && !els.sOther.value.trim())){
      els.sStatus.textContent = 'Please fill in your name, the topic, and the question.'; els.sStatus.className = 'dlg-status err'; return;
    }
    remember('fdc_name', payload.name);
    els.sSend.disabled = true;
    els.sStatus.textContent = 'Sending…'; els.sStatus.className = 'dlg-status';
    fetch('/api/questions', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload)
    }).then(function(r){
      if(r.status === 401){ window.location.href = '/'; return; }
      if(!r.ok){ throw new Error(r.status === 429 ? 'rate' : 'fail'); }
      els.dlg.close();
      addNote('✓ Sent to Support: "' + payload.question + '"');
    }).catch(function(err){
      els.sSend.disabled = false;
      els.sStatus.textContent = err && err.message === 'rate'
        ? 'Too many questions sent from this computer — try again in a few minutes.'
        : "Couldn't send that — check your connection and try again.";
      els.sStatus.className = 'dlg-status err';
    });
  });

  function addSupportLink(afterEl, question){
    var a = document.createElement('button');
    a.type = 'button'; a.className = 'support-link';
    a.textContent = "Didn't answer it? Send to Support";
    a.addEventListener('click', function(){ openSupport(question); });
    afterEl.appendChild(a);
  }

  els.composer.addEventListener('submit', function(ev){
    ev.preventDefault();
    var question = els.q.value.trim();
    if(!question) return;
    els.q.value = ''; autoGrow();
    addMsg('user', question);

    var bubble = addMsg('assistant', 'Thinking…', true);
    els.send.disabled = true;

    fetch('/api/chat', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ question: question, history: history })
    }).then(function(r){
      if(r.status === 401){ window.location.href = '/'; return null; }
      return r.json().then(function(data){ return { ok: r.ok, data: data }; });
    }).then(function(res){
      if(!res) return;
      els.send.disabled = false;
      if(!res.ok){
        bubble.classList.remove('pending');
        bubble.textContent = "Sorry — something went wrong answering that. Try again in a moment.";
        if(bubble.parentElement) addSupportLink(bubble.parentElement, question);
        return;
      }
      bubble.classList.remove('pending');
      bubble.innerHTML = linkify(res.data.answer || '');
      if(res.data.flyers && res.data.flyers.length && bubble.parentElement){
        appendFlyerChips(bubble.parentElement, res.data.flyers);
      }
      if(bubble.parentElement) addSupportLink(bubble.parentElement, question);
      history.push({ role:'user', content: question });
      history.push({ role:'assistant', content: res.data.answer || '' });
      if(history.length > 12) history = history.slice(-12);
    }).catch(function(){
      els.send.disabled = false;
      bubble.classList.remove('pending');
      bubble.textContent = "Sorry — couldn't reach the server. Check your connection and try again.";
    });
  });

  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){
    if(d && d.demoMode){
      var slot = document.getElementById('demo-banner-slot');
      var b = document.createElement('div');
      b.className = 'demo-banner';
      b.textContent = 'Demo mode — no Anthropic API key configured yet, so answers below are placeholders.';
      slot.appendChild(b);
    }
  }).catch(function(){});
})();
