'use strict';

(() => {
  const jot = window.tenote;
  const $ = (s) => document.querySelector(s);

  const state = {
    ready: false,
    initPromise: null,
    plugins: [],
    themes: [],
    themeId: 'latte',
    chips: [],
    chipSeq: 0,
    mdRules: [],
    keys: [],
    schemas: {},
    listeners: {},
    pendingActivate: [],
    inputTimer: null,
    popTimer: null,
    hidePopTimer: null,
    activeChip: null,
    themeSheet: null,
    styleSheets: [],
    views: {},
    activeView: null,
  };

  async function hostCall(method, args) {
    try {
      const res = await jot.invokePlugin('__host', method, args);
      if (!res || !res.ok) throw new Error((res && res.error) || 'host call failed');
      return res.result;
    } catch (err) {
      console.error('[plugins]', method, err);
      return null;
    }
  }

  function setStatus(msg, ms) {
    const el = $('#status');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  // ---- themes ---------------------------------------------------------------
  async function applyThemeSheet(id) {
    if (!id) return;
    try {
      const css = await hostCall('themeCss', { id });
      if (!css || typeof CSSStyleSheet === 'undefined') return;
      const sheet = new CSSStyleSheet();
      await sheet.replace(css);
      state.themeSheet = sheet;
      document.body.dataset.theme = id;
      syncSheets();
    } catch (err) {
      console.error('[plugins] theme apply failed', err);
    }
  }

  function syncSheets() {
    document.adoptedStyleSheets = [state.themeSheet, ...state.styleSheets.map((s) => s.sheet)].filter(Boolean);
  }

  function renderThemeRow() {
    const row = $('#theme-row');
    if (!row) return;
    row.innerHTML = '';
    for (const t of state.themes) {
      const b = document.createElement('button');
      b.className = 'theme-swatch' + (t.id === state.themeId ? ' active' : '');
      b.dataset.theme = t.id;
      b.title = t.name;
      const stops = Array.isArray(t.swatch) && t.swatch.length >= 2 ? t.swatch : ['#ddd', '#999'];
      b.style.setProperty('--swatch', `linear-gradient(135deg, ${stops[0]}, ${stops[1]})`);
      row.appendChild(b);
    }
  }

  function markThemeActive() {
    const row = $('#theme-row');
    if (!row) return;
    row.querySelectorAll('.theme-swatch').forEach((sw) => sw.classList.toggle('active', sw.dataset.theme === state.themeId));
  }

  function wireThemeRow() {
    const row = $('#theme-row');
    if (!row) return;
    row.addEventListener('click', (e) => {
      const sw = e.target.closest('.theme-swatch');
      if (!sw || sw.dataset.theme === state.themeId) return;
      state.themeId = sw.dataset.theme;
      markThemeActive();
      applyThemeSheet(state.themeId);
      jot.setTheme(state.themeId);
    });
  }

  // ---- chips ----------------------------------------------------------------
  function chipsEl() { return $('#plugin-chips'); }
  function moreBtn() { return $('#chips-more'); }
  function morePop() { return $('#chips-more-pop'); }

  function closeChipsMenu() { const p = morePop(); if (p) p.classList.add('hidden'); }

  // Chips that don't fit get .ovf (display:none) and reappear inside the "+N"
  // menu as proxy buttons that forward clicks/hover to the real chip. Widths
  // are cached so a layout pass is pure math — no DOM thrash, no observer loops.
  function relayoutChips() {
    const strip = chipsEl();
    const btn = moreBtn();
    const pop = morePop();
    if (!strip || !btn || !pop) return;
    const chips = [...strip.children];
    const vis = chips.filter((c) => !c.classList.contains('gone'));
    // Only claim topbar space when there is something to see — a plugin that
    // hides all its chips must not leave an empty 46%-wide strip behind.
    const has = vis.length > 0;
    $('#chips-strip').classList.toggle('has-chips', has);
    if (!has) { btn.classList.add('hidden'); closeChipsMenu(); return; }
    for (const c of vis) {
      if (!c.classList.contains('ovf')) c._w = c.offsetWidth;
    }
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    btn.classList.add('hidden');
    const total = vis.reduce((s, c) => s + (c._w || 0), 0) + gap * Math.max(0, vis.length - 1);
    if (total > strip.clientWidth + 1) {
      btn.classList.remove('hidden');
      const avail = strip.clientWidth; // re-read: the +N button now takes room
      let x = 0;
      let cut = false;
      for (const c of chips) {
        if (c.classList.contains('gone')) { c.classList.remove('ovf'); continue; }
        const w = c._w || 0;
        if (cut || x + w > avail - 2) { c.classList.add('ovf'); cut = true; }
        else { c.classList.remove('ovf'); x += w + gap; }
      }
      const ovfd = chips.filter((c) => c.classList.contains('ovf'));
      if (ovfd.length && ovfd.length === vis.length) ovfd[0].classList.remove('ovf'); // never hide every chip
    } else {
      for (const c of chips) c.classList.remove('ovf');
    }
    const ovf = chips.filter((c) => c.classList.contains('ovf'));
    const sig = ovf.map((c) => chips.indexOf(c) + ':' + c.textContent).join('|');
    if (sig !== pop.dataset.sig) {
      pop.dataset.sig = sig;
      pop.innerHTML = '';
      for (const real of ovf) {
        const proxy = document.createElement('button');
        proxy.type = 'button';
        proxy.className = real.className.replace(/\bovf\b/g, '').trim();
        proxy.textContent = real.textContent;
        proxy.addEventListener('click', () => { closeChipsMenu(); real.click(); });
        proxy.addEventListener('mouseenter', () => { if (real._desc) schedulePop(proxy, real._desc); });
        proxy.addEventListener('mouseleave', scheduleHidePop);
        pop.appendChild(proxy);
      }
    }
    if (ovf.length === 0) {
      btn.classList.add('hidden');
      closeChipsMenu();
    } else {
      btn.textContent = '+' + ovf.length;
    }
  }

  function makeChip(desc, owner) {
    const id = 'chip-' + (++state.chipSeq);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip-p' + (desc.variant === 'accent' ? ' accent' : '');
    el.tabIndex = -1;
    el.textContent = desc.label != null ? String(desc.label) : '';
    el._desc = desc;
    if (typeof desc.onClick === 'function') {
      el.addEventListener('click', () => safe(desc.onClick, `chip click ${id}`));
    }
    el.addEventListener('mouseenter', () => schedulePop(el, desc));
    el.addEventListener('mouseleave', scheduleHidePop);
    chipsEl().appendChild(el);
    requestAnimationFrame(relayoutChips);
    return {
      update(label, variant) {
        // No-op guard: plugins like typing-speed poke their chip on a timer;
        // a redundant update must not schedule a relayout (constant UI churn).
        let dirty = false;
        if (label != null) {
          const next = String(label);
          if (el.textContent !== next) {
            el.textContent = next;
            el.classList.remove('ovf'); // re-measure the new label's width
            dirty = true;
          }
        }
        if (variant) {
          const on = variant === 'accent';
          if (el.classList.contains('accent') !== on) {
            el.classList.toggle('accent', on);
            dirty = true; // themes may style .accent with different metrics
          }
        }
        if (dirty) requestAnimationFrame(relayoutChips);
      },
      show() {
        if (!el.classList.contains('gone')) return; // already visible
        el.classList.remove('gone');
        requestAnimationFrame(relayoutChips);
      },
      hide() {
        if (el.classList.contains('gone')) return; // already hidden
        el.classList.add('gone');
        hidePopIf(el);
        requestAnimationFrame(relayoutChips);
      },
      remove() {
        el.remove();
        state.chips = state.chips.filter((c) => c._id !== id);
        relayoutChips();
      },
      _id: id,
      _owner: owner,
    };
  }

  function hidePopIf(el) {
    if (state.activeChip === el) hidePop();
  }

  function safe(fn, what, arg) {
    try { return fn(arg); }
    catch (err) { console.error(`[plugins] ${what}:`, err); }
  }

  function schedulePop(el, desc) {
    clearTimeout(state.popTimer);
    clearTimeout(state.hidePopTimer);
    state.activeChip = el;
    state.popTimer = setTimeout(async () => {
      let text = null;
      if (typeof desc.onHover === 'function') text = await Promise.resolve(safe(desc.onHover, 'onHover'));
      else if (typeof desc.tooltip === 'string') text = desc.tooltip;
      showPop(el, text);
    }, 350);
  }

  function scheduleHidePop() {
    clearTimeout(state.popTimer);
    clearTimeout(state.hidePopTimer);
    state.hidePopTimer = setTimeout(hidePop, 180);
  }

  function showPop(chipEl, text) {
    const pop = $('#chip-pop');
    if (!pop || !text) { hidePop(); return; }
    pop.textContent = text;
    pop.classList.remove('hidden');
    const app = $('#app').getBoundingClientRect();
    const r = chipEl.getBoundingClientRect();
    pop.style.top = (r.bottom - app.top + 8) + 'px';
    const left = Math.max(12, Math.min(r.left - app.left, app.width - pop.offsetWidth - 12));
    pop.style.left = left + 'px';
  }

  function hidePop() {
    const pop = $('#chip-pop');
    if (pop) pop.classList.add('hidden');
    state.activeChip = null;
  }

  function wireChips() {
    const btn = moreBtn();
    const pop = morePop();
    btn.addEventListener('click', () => { hidePop(); pop.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => {
      if (pop.classList.contains('hidden')) return;
      if (e.target.closest('#chips-more') || e.target.closest('#chips-more-pop')) return;
      closeChipsMenu();
    });
    new ResizeObserver(relayoutChips).observe(chipsEl());
    window.addEventListener('resize', relayoutChips);
    relayoutChips();
  }

  // ---- markdown chain -------------------------------------------------------
  window.__tenoteMd = {
    toHtml(html) {
      for (const rule of state.mdRules) {
        const out = safe(rule.toHtml, `md toHtml ${rule.name}`, html);
        if (typeof out === 'string') html = out;
      }
      return html;
    },
    beforeSerialize(root) {
      for (const rule of state.mdRules) safe(rule.beforeSerialize, `md serialize ${rule.name}`, root);
    },
  };

  // ---- keybindings ----------------------------------------------------------
  window.__tenoteKeys = (e) => {
    for (const k of state.keys) {
      if (!matches(k.combo, e)) continue;
      if (safe(k.handler, `key ${k.combo}`, e)) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
    }
    return false;
  };

  function matches(combo, e) {
    const parts = String(combo).toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const mods = new Set(parts.slice(0, -1));
    if ((mods.has('mod')) !== (e.metaKey || e.ctrlKey)) return false;
    if ((mods.has('alt')) !== e.altKey) return false;
    if ((mods.has('shift')) !== e.shiftKey) return false;
    return e.key.toLowerCase() === key;
  }

  // ---- composer bridge ------------------------------------------------------
  window.__tenoteInput = () => {
    clearTimeout(state.inputTimer);
    state.inputTimer = setTimeout(() => dispatchEvent_('composer:input', {}), 250);
  };

  function dispatchEvent_(name, payload) {
    for (const sub of state.listeners[name] || []) safe(sub.fn, `event ${name}`, payload);
  }

  // ---- plugin settings UI ---------------------------------------------------
  function renderPluginsSection() {
    const box = $('#set-plugins');
    if (!box) return;
    box.innerHTML = '';
    if (!state.plugins.length) {
      box.innerHTML = '<div class="plug-empty">No plugins installed</div>';
    } else {
      for (const p of state.plugins) {
        const row = document.createElement('div');
        row.className = 'plug-row';
        const dot = `<span class="plug-dot ${p.state}"></span>`;
        const gear = state.schemas[p.name]
          ? '<button class="plug-gear" data-gear="' + p.name + '" title="Settings">⚙</button>'
          : '';
        row.innerHTML =
          `${dot}<span class="plug-name" title="${p.name}">${p.name}${p.version ? ' <em>' + p.version + '</em>' : ''}</span>` +
          gear +
          `<label class="plug-toggle"><input type="checkbox" data-plug="${p.name}" ${p.state !== 'disabled' ? 'checked' : ''}/><span></span></label>`;
        box.appendChild(row);
      }
    }
    const add = document.createElement('div');
    add.className = 'plug-actions';
    add.innerHTML =
      '<button class="set-btn plug-add" data-install-plugin="1">⤓ Install from file…</button>' +
      '<button class="set-btn plug-add" data-open-plugins="1">Open plugins folder</button>';
    box.appendChild(add);
  }

  function wirePluginsSection() {
    const box = $('#set-plugins');
    if (!box) return;
    box.addEventListener('change', async (e) => {
      const cb = e.target.closest('input[data-plug]');
      if (!cb) return;
      const name = cb.dataset.plug;
      cb.disabled = true; // no double-toggles while the call is in flight — and a
      // concurrent re-render can't make a pending toggle look like it snapped back
      try {
        const r = await hostCall('setEnabled', { name, enabled: cb.checked });
        if (!r) { setStatus('Toggle failed', 3000); return; }
        setStatus(r.active ? `"${name}" is on` : (cb.checked ? `"${name}" failed to activate` : `"${name}" is off`), 3000);
        const st = await hostCall('state');
        if (st) {
          state.plugins = st.plugins || [];
          state.themes = st.themes || [];
          renderThemeRow();
          renderPluginsSection();
        }
      } finally {
        cb.disabled = false;
      }
    });
    box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-install-plugin]')) {
        setStatus('Choose a plugin to install…');
        const r = await hostCall('installPlugin');
        if (!r) { setStatus('Install failed', 3000); return; }
        if (r.canceled) return;
        if (r.ok) setStatus(`Installed "${r.name}" — restart Tenote`, 4000);
        else setStatus(r.error || 'Install failed', 3500);
        return;
      }
      if (e.target.closest('[data-open-plugins]')) {
        await hostCall('openPluginsFolder');
        setStatus('Drop a plugin folder in, then restart Tenote');
        return;
      }
      const gear = e.target.closest('[data-gear]');
      if (!gear) return;
      const name = gear.dataset.gear;
      const schema = state.schemas[name];
      if (!schema) return;
      const values = (await hostCall('getPluginSettings', { name })) || {};
      openModal(name, schema, values);
    });
  }

  function fieldHtml(f, value) {
    const v = value !== undefined ? value : f.default;
    if (f.type === 'toggle') {
      return `<label class="set-toggle"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}/><span class="set-toggle-ui"></span><span class="set-toggle-label">${f.label}</span></label>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('');
      return `<label class="pm-field"><span>${f.label}</span><select data-key="${f.key}">${opts}</select></label>`;
    }
    if (f.type === 'number') {
      return `<label class="pm-field"><span>${f.label}</span><input type="number" data-key="${f.key}" value="${v != null ? v : ''}"/></label>`;
    }
    return `<label class="pm-field"><span>${f.label}</span><input type="text" data-key="${f.key}" value="${v != null ? String(v).replace(/"/g, '&quot;') : ''}"/></label>`;
  }

  function openModal(name, fields, values) {
    const modal = $('#plugin-modal');
    $('#plugin-modal-title').textContent = name;
    const body = $('#plugin-modal-body');
    body.innerHTML = fields.map((f) => fieldHtml(f, values[f.key])).join('');
    modal.classList.remove('hidden');
    body.onchange = async (e) => {
      const el = e.target.closest('[data-key]');
      if (!el) return;
      const f = fields.find((x) => x.key === el.dataset.key);
      const value = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      await hostCall('setPluginSetting', { name, key: el.dataset.key, value });
      if (f && typeof f.onChange === 'function') safe(f.onChange, `onChange ${name}.${f.key}`, value);
    };
    $('#btn-plugin-modal-close').onclick = closeModal;
  }

  function closeModal() {
    const modal = $('#plugin-modal');
    modal.classList.add('hidden');
    $('#plugin-modal-body').onchange = null;
  }

  function handleEscape() {
    if (state.activeView) { closeView(); return true; }
    const modal = $('#plugin-modal');
    if (modal && !modal.classList.contains('hidden')) { closeModal(); return true; }
    const mpop = morePop();
    if (mpop && !mpop.classList.contains('hidden')) { closeChipsMenu(); return true; }
    if (state.activeChip) { hidePop(); return false; }
    return false;
  }
  window.__tenoteEscape = handleEscape;

  // ---- plugin views ---------------------------------------------------------
  function openView(id) {
    const v = state.views[id];
    if (!v) return false;
    const hooks = window.__tenoteUiHooks;
    if (hooks && typeof hooks.beforeView === 'function') safe(() => hooks.beforeView(), 'beforeView');
    try { flushSaveViaHook(); } catch (e) { /* ignore */ }
    const body = $('#pview-body');
    $('#pview-title').textContent = v.title || id;
    body.innerHTML = '';
    document.getElementById('composer').classList.add('hidden');
    document.getElementById('panel').classList.add('hidden');
    $('#pview').classList.remove('hidden');
    state.activeView = id;
    safe(() => v.render(body), `view render ${id}`);
    return true;
  }

  function flushSaveViaHook() {
    const hooks = window.__tenoteUiHooks;
    if (hooks && typeof hooks.flushSave === 'function') hooks.flushSave();
  }

  function closeView() {
    if (!state.activeView) return;
    state.activeView = null;
    $('#pview').classList.add('hidden');
    document.getElementById('composer').classList.remove('hidden');
    const ta = document.getElementById('note');
    if (ta) ta.focus();
  }
  window.__tenoteViews = {
    open: openView,
    close: closeView,
    isOpen: () => !!state.activeView,
    openNote(id) {
      const hooks = window.__tenoteUiHooks;
      closeView();
      if (hooks && typeof hooks.openNote === 'function') safe(() => hooks.openNote(id), 'openNote');
    },
  };
  $('#btn-pview-close').addEventListener('click', closeView);

  // ---- plugin teardown ------------------------------------------------------
  function deactivate(id) {
    for (const chip of [...state.chips]) if (chip._owner === id) chip.remove();
    for (const name of Object.keys(state.listeners)) {
      state.listeners[name] = state.listeners[name].filter((s) => s.owner !== id);
    }
    state.keys = state.keys.filter((k) => k.owner !== id);
    state.mdRules = state.mdRules.filter((r) => r.owner !== id);
    state.styleSheets = state.styleSheets.filter((s) => s.owner !== id);
    syncSheets();
    for (const vid of Object.keys(state.views)) {
      if (state.views[vid].owner !== id) continue;
      if (state.activeView === vid) closeView();
      delete state.views[vid];
    }
    if (state.schemas[id]) delete state.schemas[id];
    // If the disabled plugin owned the active theme, fall back to a theme that
    // still exists — otherwise the swatch row shows nothing active and the old
    // sheet stays applied until restart. state.themes is stale at this point
    // (the toggle handler re-fetches after), so subtract the removed ids.
    const meta = state.plugins.find((p) => p.name === id);
    const removedThemes = new Set((meta && meta.themes) || []);
    if (removedThemes.has(state.themeId)) {
      const remaining = state.themes.filter((t) => !removedThemes.has(t.id));
      const fallback = remaining.find((t) => t.id === 'latte') || remaining[0];
      if (fallback) {
        state.themeId = fallback.id;
        markThemeActive();
        applyThemeSheet(fallback.id);
        jot.setTheme(fallback.id);
      } else {
        state.themeId = null;
        state.themeSheet = null;
        document.body.dataset.theme = '';
        syncSheets();
      }
    }
    renderPluginsSection();
  }

  // ---- plugin activation ----------------------------------------------------
  function makeApi(id, version) {
    const prefix = `[${id}]`;
    const log = {
      debug: (...a) => console.debug(prefix, ...a),
      info: (...a) => console.info(prefix, ...a),
      warn: (...a) => console.warn(prefix, ...a),
      error: (...a) => console.error(prefix, ...a),
    };
    const cache = {};
    const primed = hostCall('getPluginSettings', { name: id }).then((v) => Object.assign(cache, v || {})).catch(() => {});

    return {
      name: id,
      version,
      log,
      ui: {
        chips: {
          add(desc) {
            const d = desc || {};
            const chip = makeChip(d, id);
            state.chips.push(chip);
            return chip;
          },
        },
        views: {
          register(def) { if (def && def.id) state.views[def.id] = { ...def, owner: id }; },
          open: (id) => openView(id),
          close: () => closeView(),
          openNote: (id) => window.__tenoteViews.openNote(id),
        },
        toast: (msg, ms) => setStatus(String(msg), ms),
        themes: {
          apply(themeId) {
            if (!state.themes.some((t) => t.id === themeId)) return false;
            state.themeId = themeId;
            markThemeActive();
            applyThemeSheet(themeId);
            jot.setTheme(themeId);
            return true;
          },
        },
        markdown: { addRule(rule) { if (rule && rule.name) state.mdRules.push({ ...rule, owner: id }); } },
        styles: {
          add(css) {
            if (typeof css !== 'string' || typeof CSSStyleSheet === 'undefined') return;
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            state.styleSheets.push({ sheet, owner: id });
            syncSheets();
          },
        },
        keys: { add(binding) { if (binding && binding.combo && typeof binding.handler === 'function') state.keys.push({ ...binding, owner: id }); } },
        settings: { declare(fields) { if (Array.isArray(fields)) { state.schemas[id] = fields; renderPluginsSection(); } } },
      },
      events: {
        on(name, fn) {
          if (!name || typeof fn !== 'function') return;
          if (!state.listeners[name]) state.listeners[name] = [];
          state.listeners[name].push({ fn, owner: id });
        },
      },
      composer: {
        insertText(str) {
          const c = window.__tenoteComposer;
          if (c && typeof c.insertText === 'function') c.insertText(String(str));
        },
        isEmpty() {
          const c = window.__tenoteComposer;
          return c ? !!c.isEmpty() : true;
        },
      },
      notes: {
        list: () => jot.listNotes(),
        read: (nid) => jot.readNote(nid),
        save: (payload) => jot.saveNote(payload),
        recent: (limit) => jot.recentNotes(limit),
      },
      settings: {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
        },
        set(key, value) {
          cache[key] = value;
          hostCall('setPluginSetting', { name: id, key, value });
        },
      },
      _primed: primed,
    };
  }

  window.__tenoteReady = (id, fn) => {
    state.pendingActivate.push({ id, fn });
    processQueue();
  };

  async function processQueue() {
    while (state.pendingActivate.length && state.ready) {
      const { id, fn } = state.pendingActivate.shift();
      const meta = state.plugins.find((p) => p.name === id);
      const api = makeApi(id, meta && meta.version);
      try {
        await api._primed;
        fn(api);
      } catch (err) { console.error(`[plugins] renderer activation failed: ${id}`, err); }
    }
  }

  // ---- events from main -----------------------------------------------------
  if (jot.onPluginEvent) {
    jot.onPluginEvent(({ event, payload }) => {
      if (event === '__tenote:deactivate' && payload && payload.id) { deactivate(payload.id); return; }
      dispatchEvent_(event, payload);
    });
  }

  // ---- init -----------------------------------------------------------------
  async function init() {
    wireChips();
    wireThemeRow();
    wirePluginsSection();
    const st = await hostCall('state');
    if (!st) return;
    state.plugins = st.plugins || [];
    state.themes = st.themes || [];
    state.themeId = st.themeId || 'latte';
    renderThemeRow();
    renderPluginsSection();
    await applyThemeSheet(state.themeId);
    state.ready = true;
    await processQueue();
  }

  state.initPromise = init();
})();
