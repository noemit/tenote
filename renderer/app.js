'use strict';

// Tenote renderer — auto-saving composer, markdown preview, paste-image support,
// recents strip, all-notes takeover view, and a settings popover.

(() => {
  const jot = window.tenote;
  const $ = (s) => document.querySelector(s);

  const ta = $('#note');
  const statusEl = $('#status');
  const chipsEl = $('#chips');
  const hintEl = $('#hint');
  const previewEl = $('#preview');
  const recentsEl = $('#recents');
  const composerView = $('#composer');
  const panelEl = $('#panel');
  const panelTitleEl = $('#panel-title');
  const noteListEl = $('#note-list');
  const settingsPop = $('#settings-pop');
  const mdbar = $('#mdbar');
  const segEdit = $('#seg-edit');
  const segPreview = $('#seg-preview');
  const setHideBlur = $('#set-hide-blur');
  const setLaunch = $('#set-launch');
  const setPreview = $('#set-preview');

  const state = { id: null, created: null, sessionCreated: false, lastText: '' };

  let saveTimer = null;
  let previewTimer = null;
  let saveChain = Promise.resolve();
  let statusTimer = null;
  let panelOpen = false;
  let previewing = false;
  let settingsOpen = false;
  let previewOnPaste = true; // synced from settings; until then assume on
  let gen = 0; // bumped on every composer reset — stale async saves can't touch state

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
    ta.value = '';
    renderChips([]);
    updateMdBar();
  }

  // ---- preview (Edit/Preview toggle: rendered markdown replaces the textarea)
  function renderPreview() {
    const st = previewEl.scrollTop;
    previewEl.innerHTML = mdToHtml(ta.value);
    previewEl.scrollTop = st;
  }

  function updateMdBar() {
    mdbar.classList.toggle('hidden', !(previewing || looksLikeMarkdown(ta.value)));
  }

  function setMode(mode) {
    const want = mode === 'preview';
    if (want === previewing) return;
    previewing = want;
    composerView.classList.toggle('previewing', previewing);
    previewEl.classList.toggle('hidden', !previewing);
    segEdit.classList.toggle('active', !previewing);
    segPreview.classList.toggle('active', previewing);
    if (previewing) { renderPreview(); previewEl.scrollTop = 0; }
    else ta.focus();
  }

  function exitPreview() { if (previewing) setMode('edit'); }

  // ---- recents strip -------------------------------------------------------
  function renderRecents(notes, total) {
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

  async function openSettings() {
    try {
      const s = await jot.getSettings();
      setHideBlur.checked = !!s.hideOnBlur;
      setLaunch.checked = !!s.launchAtLogin;
      setPreview.checked = !!s.previewOnPaste;
      previewOnPaste = !!s.previewOnPaste;
      applyTheme(s.theme);
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
    else openSettings();
  }

  // ---- notes view (takeover) ----------------------------------------------
  function renderNoteList(notes, preserveScroll) {
    const scrollTop = preserveScroll ? noteListEl.scrollTop : 0;
    panelTitleEl.textContent = 'Notes' + (notes.length ? ` (${notes.length})` : '');
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
    exitPreview();
    closeSettings();
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
  function doSave(force) {
    const text = ta.value;
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
        showStatus('Saved ' + timeStr(new Date(res.updated || Date.now())));
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
  function flushSave() { clearTimeout(saveTimer); doSave(true); return saveChain; }

  // ---- notes ---------------------------------------------------------------
  async function openNote(id) {
    // Persist in-progress text before swapping the composer (debounce may not have fired).
    // Must await the chain — openNote does not bump gen, so a late save would clobber state.
    try { await flushSave(); } catch (err) { console.error('flush before open failed', err); }
    exitPreview();
    closeSettings();
    closePanel(); // takeover: back to the composer with this note loaded
    try {
      const n = await jot.readNote(id);
      if (!n) { showStatus('Note not found'); return; }
      state.id = n.id;
      state.created = n.created;
      state.sessionCreated = false;
      state.lastText = n.body;
      ta.value = n.body;
      renderChips(n.tags || []);
      updateMdBar();
      refreshRecents();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch (err) { console.error('open note failed', err); }
  }

  // Starts a brand-new note. Callers must flushSave() first if there's text to keep.
  function newNote() {
    exitPreview();
    closePanel();
    closeSettings();
    resetComposer();
    refreshRecents();
    ta.focus();
  }

  // ---- image paste ---------------------------------------------------------
  function insertAtCursor(text) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  function looksLikeMarkdown(t) {
    return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?)|[*_]{1,2}[^*\n]|`[^`\n]`|\[[^\]]*\]\(|!\[/.test(t);
  }

  function maybePreviewAfterPaste() {
    if (previewOnPaste) setTimeout(() => { updateMdBar(); setMode('preview'); }, 80);
  }

  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const item of items) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          if (file.size > 15 * 1024 * 1024) { showStatus('Image too large (max 15 MB)', 3500); return; }
          showStatus('Saving image…');
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const dataUrl = String(reader.result || '');
              const base64 = dataUrl.split(',')[1] || '';
              const r = await jot.attachImage({ mime: file.type, base64, noteId: state.id });
              if (r && r.ok) {
                insertAtCursor(`![image](${r.path})`);
                showStatus('Image attached → ' + r.path, 3000);
                maybePreviewAfterPaste();
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
          return;
        }
      }
    }
    // Text paste that looks like markdown → hop to preview after the insert.
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text && looksLikeMarkdown(text)) maybePreviewAfterPaste();
  });

  // ---- init ----------------------------------------------------------------
  async function init() {
    try {
      const st = await jot.getState();
      if (st.shortcut) hintEl.textContent = `${st.shortcut} toggles · notes → ${st.notesDir}`;
      else hintEl.textContent = `notes → ${st.notesDir}`;
      if (st.firstRun) {
        hintEl.classList.add('show');
        setTimeout(() => hintEl.classList.remove('show'), 9000);
      }
      if (st.windowVisible) ta.focus();
      const s = await jot.getSettings();
      previewOnPaste = !!s.previewOnPaste;
      applyTheme(s.theme);
      refreshRecents();
    } catch (err) { console.error('init failed', err); }
  }

  // ---- events --------------------------------------------------------------
  ta.addEventListener('input', () => {
    scheduleSave();
    updateMdBar();
    if (previewing) { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 120); }
  });

  // ⌘/Ctrl+B toggles **bold** around the selection; Tab indents, Shift+Tab outdents.
  function toggleBold() {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const sel = ta.value.slice(start, end);
    if (start === end) {
      ta.setRangeText('****', start, end, 'end');
      ta.setSelectionRange(start + 2, start + 2);
    } else if (ta.value.slice(start - 2, start) === '**' && ta.value.slice(end, end + 2) === '**') {
      ta.setRangeText(sel, start - 2, end + 2, 'select'); // unwrap existing **
    } else {
      ta.setRangeText('**' + sel + '**', start, end, 'select');
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  function indentSelection(outdent) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = v.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const next = outdent
      ? lines.map((l) => l.replace(/^ {1,2}/, ''))
      : lines.map((l) => '  ' + l);
    const block = next.join('\n');
    ta.setRangeText(block, lineStart, lineEnd, 'end');
    ta.setSelectionRange(lineStart, lineStart + block.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); indentSelection(e.shiftKey); }
  });
  window.addEventListener('blur', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (previewing) exitPreview();
      else if (settingsOpen) closeSettings();
      else if (panelOpen) closePanel();
      else { flushSave(); jot.hide(); }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      flushSave();
      jot.hide();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
      if (previewing || panelOpen) return;
      e.preventDefault();
      toggleBold();
    }
  });

  $('#btn-new').addEventListener('click', () => { flushSave(); newNote(); });
  $('#btn-close').addEventListener('click', () => { flushSave(); jot.hide(); });

  segEdit.addEventListener('click', () => setMode('edit'));
  segPreview.addEventListener('click', () => setMode('preview'));
  $('#btn-settings').addEventListener('click', () => toggleSettings());

  $('#btn-panel-close').addEventListener('click', () => closePanel());
  $('#btn-panel-new').addEventListener('click', () => { flushSave(); newNote(); });

  setHideBlur.addEventListener('change', () => jot.setHideOnBlur(setHideBlur.checked));
  setLaunch.addEventListener('change', () => jot.setLaunchAtLogin(setLaunch.checked));
  setPreview.addEventListener('change', () => {
    previewOnPaste = setPreview.checked;
    jot.setPreviewOnPaste(previewOnPaste);
  });
  document.querySelectorAll('.theme-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      applyTheme(sw.dataset.theme);
      jot.setTheme(sw.dataset.theme);
    });
  });
  $('#set-notes').addEventListener('click', () => { closeSettings(); jot.openNotesFolder(); });
  $('#set-logs').addEventListener('click', () => { closeSettings(); jot.openLogsFolder(); });
  $('#set-quit').addEventListener('click', () => { closeSettings(); jot.quit(); });

  recentsEl.addEventListener('click', (e) => {
    if (e.target.closest('.recent-more')) { openPanel(); return; }
    const card = e.target.closest('.recent-card');
    if (card) openNote(card.dataset.id);
  });

  noteListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.note-item');
    if (item) openNote(item.dataset.id);
  });

  // Clicking outside the settings popover closes it (the toggle button manages itself).
  document.addEventListener('click', (e) => {
    if (settingsOpen && !settingsPop.contains(e.target) && !e.target.closest('#btn-settings')) {
      closeSettings();
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

  init();
})();
