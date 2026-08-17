'use strict';

// Tenote renderer — auto-saving composer (contenteditable, inline images/bold/italic),
// recents strip, all-notes takeover view, and a settings popover.

(() => {
  const jot = window.tenote;
  const $ = (s) => document.querySelector(s);

  const ta = $('#note');
  const statusEl = $('#status');
  const chipsEl = $('#chips');
  const hintEl = $('#hint');
  const recentsEl = $('#recents');
  const composerView = $('#composer');
  const panelEl = $('#panel');
  const panelTitleEl = $('#panel-title');
  const noteListEl = $('#note-list');
  const settingsPop = $('#settings-pop');
  const tipsPop = $('#tips-pop');
  const welcomeEl = $('#welcome');
  const setHideBlur = $('#set-hide-blur');
  const setLaunch = $('#set-launch');
  const setHideBrand = $('#set-hide-brand');
  const setHideRecents = $('#set-hide-recents');
  const brandEl = $('.brand');
  const notesCountEl = $('#btn-notes-count');

  const state = { id: null, created: null, sessionCreated: false, lastText: '' };

  let saveTimer = null;
  let saveChain = Promise.resolve();
  let statusTimer = null;
  let panelOpen = false;
  let settingsOpen = false;
  let tipsOpen = false;
  let gen = 0; // bumped on every composer reset — stale async saves can't touch state
  let hideRecents = false; // settings: collapse the recents strip to a count button

  // ---- helpers -------------------------------------------------------------
  const TAGS_RE = /(^|\s)#([A-Za-z0-9_\u00C0-\uFFFF][\w\u00C0-\uFFFF\-+]*)/g;

  function extractTags(text) {
    const out = [];
    const seen = new Set();
    let m;
    TAGS_RE.lastIndex = 0;
    while ((m = TAGS_RE.exec(text)) && out.length < 8) {
      const t = m[2];
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function timeStr(d) {
    try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function fullTimeStr(d) {
    try { return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return String(d); }
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    const diff = Date.now() - then;
    if (diff < 0) return fullTimeStr(new Date(iso));
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + 'd ago';
    return fullTimeStr(new Date(iso));
  }

  function showStatus(msg, ms) {
    statusEl.textContent = msg;
    statusEl.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.remove('show'), ms || 2200);
  }

  function b64url(s) {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---- markdown (very simple, escape-first so it's XSS-safe) ---------------
  function mdToHtml(src) {
    let html = escapeHtml(String(src || ''));
    // images stored in the notes folder
    html = html.replace(/!\[([^\]]*)\]\((images\/[^)\s]+)\)/g, (m, alt, url) =>
      `<img class="md-img" src="timg://file/${b64url(url)}" alt="${alt}">`);
    // external images
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1">');
    // links
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    // headings
    html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    // inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // bold / italic
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // bullet lists (group consecutive lines)
    html = html.replace(/(?:^|\n)((?:[ \t]*[-*] .*(?:\n|$))+)/g, (m, block) => {
      const items = block.trim().split('\n').map((l) => l.replace(/^\s*[-*] /, '')).join('</li><li>');
      return '\n<ul><li>' + items + '</li></ul>\n';
    });
    // paragraphs
    html = html.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (!t) return '';
      if (/^(<h[123]>|<ul>|<img)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    return html;
  }

  function b64urlDecode(s) {
    try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { return s; }
  }

  // ---- serializer: rendered composer DOM → markdown stored on disk ----------
  function imgMd(img) {
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || 'image';
    const m = src.match(/^timg:\/\/file\/(.+)$/);
    return `![${alt}](${m ? b64urlDecode(m[1]) : src})`;
  }

  function inlineMd(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const inner = () => Array.from(node.childNodes).map(inlineMd).join('');
    switch (node.tagName) {
      case 'STRONG': case 'B': return '**' + inner() + '**';
      case 'EM': case 'I': return '*' + inner() + '*';
      case 'CODE': return '`' + inner() + '`';
      case 'BR': return '\n';
      case 'IMG': return imgMd(node);
      case 'A': return `[${inner()}](${node.getAttribute('href') || ''})`;
      default: return inner();
    }
  }

  function blockMd(node) {
    const inline = () => Array.from(node.childNodes).map(inlineMd).join('');
    if (/^H[123]$/.test(node.tagName)) return '#'.repeat(+node.tagName[1]) + ' ' + inline();
    if (node.tagName === 'UL') {
      return Array.from(node.children)
        .filter((c) => c.tagName === 'LI')
        .map((li) => '- ' + Array.from(li.childNodes).map(inlineMd).join(''))
        .join('\n');
    }
    if (node.tagName === 'IMG') return imgMd(node);
    if (node.tagName === 'BR') return '';
    // DIV/P and anything else: a line of inline content (empty-ish → blank line)
    if (!node.textContent && !node.querySelector('img')) return '';
    return inline();
  }

  function htmlToMd(root) {
    return Array.from(root.childNodes)
      .map((n) => (n.nodeType === 3 ? n.nodeValue : n.nodeType === 1 ? blockMd(n) : ''))
      .join('\n');
  }

  function caretToEnd(el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function insertNodeAtCaret(node) {
    ta.focus();
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      ta.appendChild(node);
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // ---- rendering -----------------------------------------------------------
  function renderChips(tags) {
    if (tags && tags.length) {
      chipsEl.innerHTML = tags.map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('');
      chipsEl.classList.remove('hidden');
    } else {
      chipsEl.classList.add('hidden');
      chipsEl.innerHTML = '';
    }
  }

  function resetComposer() {
    gen++; // invalidate any in-flight saves touching composer state
    state.id = null;
    state.created = null;
    state.sessionCreated = false;
    state.lastText = '';
    ta.innerHTML = '';
    renderChips([]);
  }

  // ---- recents strip -------------------------------------------------------
  function renderRecents(notes, total) {
    if (hideRecents) {
      recentsEl.innerHTML = '';
      recentsEl.classList.add('hidden');
      if (total > 0) {
        notesCountEl.textContent = total + (total === 1 ? ' note' : ' notes');
        notesCountEl.classList.remove('hidden');
      } else {
        notesCountEl.classList.add('hidden');
      }
      return;
    }
    notesCountEl.classList.add('hidden');
    const cards = notes.map((n) => `<button class="recent-card" data-id="${escapeHtml(n.id)}">
      <div class="rt">${escapeHtml(n.title)}</div>
      <div class="rs">${escapeHtml(relativeTime(n.updated))}</div>
    </button>`);
    const more = total - notes.length;
    if (more > 0) {
      cards.push(`<button class="recent-card recent-more" data-more="1"><div class="rt">+${more} more</div></button>`);
    }
    recentsEl.innerHTML = cards.join('');
    recentsEl.classList.toggle('hidden', cards.length === 0);
  }

  async function refreshRecents() {
    try {
      const res = await jot.recentNotes(3);
      let notes = res.notes || [];
      const total = res.total || 0;
      if (state.sessionCreated && state.id) notes = notes.filter((n) => n.id !== state.id);
      renderRecents(notes, total);
    } catch (err) { console.error('recents failed', err); }
  }



  // ---- settings popover ----------------------------------------------------
  function applyTheme(t) {
    const theme = ['latte', 'pearl', 'espresso', 'midnight', 'pastel'].includes(t) ? t : 'latte';
    document.body.dataset.theme = theme;
    document.querySelectorAll('.theme-swatch').forEach((sw) => sw.classList.toggle('active', sw.dataset.theme === theme));
  }

  function applyHideBrand(hide) {
    brandEl.classList.toggle('hidden', !!hide);
  }

  async function openSettings() {
    try {
      const s = await jot.getSettings();
      setHideBlur.checked = !!s.hideOnBlur;
      setLaunch.checked = !!s.launchAtLogin;
      setHideBrand.checked = !!s.hideBrand;
      setHideRecents.checked = !!s.hideRecents;
      applyTheme(s.theme);
      applyHideBrand(s.hideBrand);
      settingsOpen = true;
      settingsPop.classList.remove('hidden');
    } catch (err) { console.error('settings failed', err); }
  }

  function closeSettings() {
    settingsOpen = false;
    settingsPop.classList.add('hidden');
  }

  function toggleSettings() {
    if (settingsOpen) closeSettings();
    else { closeTips(); openSettings(); }
  }

  function openTips() {
    closeSettings();
    tipsOpen = true;
    tipsPop.classList.remove('hidden');
  }

  function closeTips() {
    tipsOpen = false;
    tipsPop.classList.add('hidden');
  }

  function toggleTips() {
    if (tipsOpen) closeTips();
    else openTips();
  }

  // ---- notes view (takeover) ----------------------------------------------
  function renderNoteList(notes, preserveScroll) {
    const scrollTop = preserveScroll ? noteListEl.scrollTop : 0;
    panelTitleEl.textContent = notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : 'Notes';
    noteListEl.innerHTML = notes.length
      ? notes.map((n) => {
          const when = relativeTime(n.updated);
          const chips = (n.tags || []).slice(0, 4).map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('');
          return `<li class="note-item${n.id === state.id ? ' active' : ''}" data-id="${escapeHtml(n.id)}">
            <div class="t">${escapeHtml(n.title)}</div>
            <div class="s">${escapeHtml(n.snippet)}</div>
            <div class="meta"><span class="when">${escapeHtml(when)}</span>${chips}</div>
          </li>`;
        }).join('')
      : '<li id="empty">No notes yet — jot something down!</li>';
    noteListEl.scrollTop = scrollTop;
  }

  async function fetchNotes() {
    const notes = await jot.listNotes();
    renderNoteList(notes);
    return notes;
  }

  async function openPanel() {
    flushSave();
    closeSettings();
    closeTips();
    try {
      await fetchNotes();
      panelOpen = true;
      composerView.classList.add('hidden');
      panelEl.classList.remove('hidden');
      console.log('notes view opened, count:', noteListEl.children.length);
    } catch (err) {
      console.error('notes view failed', err);
      showStatus('Could not load notes');
    }
  }

  function closePanel() {
    panelOpen = false;
    panelEl.classList.add('hidden');
    composerView.classList.remove('hidden');
  }

  async function refreshPanel() {
    try {
      const notes = await jot.listNotes();
      renderNoteList(notes, true);
    } catch (err) { console.error('panel refresh failed', err); }
  }

  // ---- saving --------------------------------------------------------------
  function doSave(force, silent) {
    const text = htmlToMd(ta);
    const id = state.id;
    const g = gen; // snapshot: only apply results if the composer wasn't reset
    if (!state.id && !text.trim()) return; // no note on disk yet and nothing to save
    // (an emptied existing note falls through — the main process deletes the file)
    if (!force && text === state.lastText) return;
    state.lastText = text;
    saveChain = saveChain.then(async () => {
      try {
        const res = await jot.saveNote({ id, text, tags: extractTags(text) });
        if (!res || !res.ok) { console.error('save failed', res); showStatus('Save failed'); return; }
        if (res.deleted) {
          console.log('note deleted (emptied):', res.id);
          if (g === gen) resetComposer();
          refreshRecents();
          if (panelOpen) refreshPanel();
          return;
        }
        if (g === gen) {
          state.id = res.id;
          state.created = res.created || state.created;
          state.sessionCreated = true;
        }
        if (!silent) showStatus('Saved ' + timeStr(new Date(res.updated || Date.now())));
        renderChips(extractTags(text));
        refreshRecents();
        if (panelOpen) refreshPanel();
      } catch (err) {
        console.error('save threw', err);
        showStatus('Save error');
      }
    });
  }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => doSave(false), 350); }
  function flushSave() { clearTimeout(saveTimer); doSave(true, true); return saveChain; }

  // ---- notes ---------------------------------------------------------------
  async function openNote(id) {
    // Persist in-progress text before swapping the composer (debounce may not have fired).
    // Must await the chain — openNote does not bump gen, so a late save would clobber state.
    try { await flushSave(); } catch (err) { console.error('flush before open failed', err); }
    closeSettings();
    closeTips();
    closePanel(); // takeover: back to the composer with this note loaded
    try {
      const n = await jot.readNote(id);
      if (!n) { showStatus('Note not found'); return; }
      state.id = n.id;
      state.created = n.created;
      state.sessionCreated = false;
      state.lastText = n.body;
      ta.innerHTML = mdToHtml(n.body);
      renderChips(n.tags || []);
      refreshRecents();
      caretToEnd(ta);
    } catch (err) { console.error('open note failed', err); }
  }

  // Starts a brand-new note. Callers must flushSave() first if there's text to keep.
  function newNote() {
    closePanel();
    closeSettings();
    closeTips();
    resetComposer();
    refreshRecents();
    ta.focus();
  }

  // ---- images: attach by paste or drag-and-drop -----------------------------
  function attachImageFile(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { showStatus('Image too large (max 15 MB)', 3500); return; }
    showStatus('Saving image…');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.split(',')[1] || '';
        const r = await jot.attachImage({ mime: file.type || 'image/png', base64, noteId: state.id });
        if (r && r.ok) {
          const img = document.createElement('img');
          img.src = 'timg://file/' + b64url(r.path);
          img.alt = 'image';
          insertNodeAtCaret(img);
          showStatus('Image attached → ' + r.path, 3000);
        } else {
          showStatus((r && r.error) || 'Could not save image', 3500);
        }
      } catch (err) {
        console.error('attach failed', err);
        showStatus('Image save failed', 3000);
      }
    };
    reader.onerror = () => showStatus('Could not read image', 3000);
    reader.readAsDataURL(file);
  }

  function isImageFile(file) {
    return (file.type && file.type.startsWith('image/'))
      || /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i.test(file.name || '');
  }

  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const item of items) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          attachImageFile(item.getAsFile());
          return;
        }
      }
    }
    // Text/html paste: plain text only — markdown syntax stays literal until reload.
    e.preventDefault();
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });

  // Drag-and-drop: images attach inline; any other file inserts its path.
  ta.addEventListener('dragover', (e) => { e.preventDefault(); });
  ta.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (!files.length) return;
    // Insert at the point where the file was dropped.
    const range = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
    if (range && ta.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    for (const file of files) {
      if (isImageFile(file)) {
        attachImageFile(file);
      } else {
        let p = '';
        try { p = jot.pathForFile(file); } catch (err) { console.error('pathForFile failed', err); }
        if (p) insertNodeAtCaret(document.createTextNode(p));
      }
    }
  });

  // ---- init ----------------------------------------------------------------
  async function init() {
    try {
      const st = await jot.getState();
      if (st.shortcut) hintEl.textContent = `${st.shortcut} toggles · notes → ${st.notesDir}`;
      else hintEl.textContent = `notes → ${st.notesDir}`;
      if (st.firstRun) welcomeEl.classList.remove('hidden');
      if (st.windowVisible) ta.focus();
      const s = await jot.getSettings();
      applyTheme(s.theme);
      applyHideBrand(s.hideBrand);
      hideRecents = !!s.hideRecents;
      refreshRecents();
    } catch (err) { console.error('init failed', err); }
  }

  // ---- events --------------------------------------------------------------
  ta.addEventListener('input', () => {
    // Chrome leaves a stray <br> in an emptied composer — clear it so the placeholder returns.
    if (!ta.textContent && !ta.querySelector('img')) ta.innerHTML = '';
    scheduleSave();
  });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  window.addEventListener('blur', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  function welcomeVisible() { return !welcomeEl.classList.contains('hidden'); }
  function dismissWelcome() { welcomeEl.classList.add('hidden'); }
  welcomeEl.addEventListener('click', dismissWelcome);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (welcomeVisible()) dismissWelcome();
      else if (settingsOpen) closeSettings();
      else if (tipsOpen) closeTips();
      else if (panelOpen) closePanel();
      else { flushSave(); jot.hide(); }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      flushSave();
      jot.hide();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
      if (panelOpen) return;
      e.preventDefault();
      document.execCommand('bold');
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
      if (panelOpen) return;
      e.preventDefault();
      document.execCommand('italic');
    }
  });

  document.querySelectorAll('.rz').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      jot.resizeStart(el.dataset.edge);
    });
  });
  window.addEventListener('mouseup', () => jot.resizeEnd());
  window.addEventListener('blur', () => jot.resizeEnd());

  $('#btn-new').addEventListener('click', () => { flushSave(); newNote(); });
  $('#btn-close').addEventListener('click', () => { flushSave(); jot.hide(); });

  notesCountEl.addEventListener('click', async () => {
    if (!panelOpen) { openPanel(); return; }
    try {
      const res = await jot.recentNotes(1);
      const latest = res && res.notes && res.notes[0];
      if (latest) openNote(latest.id);
      else closePanel();
    } catch (err) {
      console.error('open latest failed', err);
      closePanel();
    }
  });
  $('#btn-settings').addEventListener('click', () => toggleSettings());
  $('#set-tips').addEventListener('click', () => toggleTips());

  $('#btn-panel-close').addEventListener('click', () => closePanel());
  $('#btn-panel-files').addEventListener('click', () => jot.openNotesFolder());

  setHideBlur.addEventListener('change', () => jot.setHideOnBlur(setHideBlur.checked));
  setLaunch.addEventListener('change', () => jot.setLaunchAtLogin(setLaunch.checked));
  setHideBrand.addEventListener('change', () => { applyHideBrand(setHideBrand.checked); jot.setHideBrand(setHideBrand.checked); });
  setHideRecents.addEventListener('change', () => { hideRecents = setHideRecents.checked; refreshRecents(); jot.setHideRecents(setHideRecents.checked); });
  document.querySelectorAll('.theme-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      applyTheme(sw.dataset.theme);
      jot.setTheme(sw.dataset.theme);
    });
  });
  $('#set-notes').addEventListener('click', () => { closeSettings(); jot.openNotesFolder(); });
  $('#set-quit').addEventListener('click', () => { closeSettings(); jot.quit(); });

  recentsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { openPanel(); return; }
    const card = e.target.closest('.recent-card');
    if (card) openNote(card.dataset.id);
  });

  noteListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.note-item');
    if (item) openNote(item.dataset.id);
  });

  // Clicking outside the settings/tips popovers closes them (the toggles manage themselves).
  document.addEventListener('click', (e) => {
    if (settingsOpen && !settingsPop.contains(e.target) && !e.target.closest('#btn-settings')) {
      closeSettings();
    }
    if (tipsOpen && !tipsPop.contains(e.target) && !e.target.closest('#set-tips')) {
      closeTips();
    }
  });

  // Every time the window opens: a fresh note (already-saved text stays saved).
  jot.onShown(() => {
    flushSave();
    newNote();
  });
  jot.onGoto((view) => { if (view === 'history') openPanel(); });

  window.addEventListener('error', (e) => {
    try { jot.log('error', 'window.onerror: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')); } catch (err) { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { jot.log('error', 'unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason) || e.reason)); } catch (err) { /* ignore */ }
  });

  document.execCommand('styleWithCSS', false, false); // bold/italic → <b>/<i>, not spans
  init();
})();
