// @ts-check
(function () {

    // =========================================================================
    //  CONSTANTS
    // =========================================================================
    const MODULE_NAME          = 'st_devtools';
    const MAX_STRINGIFY_LEN    = 2000;
    const MAX_VISIBLE_DOM      = 150;
    const MAX_REPL_OUTPUT_ROWS = 40;
    const FLUSH_INTERVAL_MS    = 300;
    const MAX_HISTORY          = 100;
    const LS_HISTORY           = MODULE_NAME + '_history';
    const LS_SNIPPETS          = MODULE_NAME + '_snippets';

    const DEFAULT_SETTINGS = Object.freeze({
        enabled:         true,
        max_entries:     200,
        capture_log:     true,
        capture_warn:    true,
        capture_error:   true,
        capture_info:    true,
        capture_debug:   false,
        show_timestamps: true,
        word_wrap:       true,
    });

    // =========================================================================
    //  STATE
    // =========================================================================

    // — log —
    /** @type {Array<{level:string, time:string, args:string}>} */
    let logBuffer      = [];
    let activeFilter   = 'all';
    let searchQuery    = '';
    let consoleVisible = false;
    /** @type {Array<{level:string, time:string, args:string}>} */
    let pendingEntries = [];
    let flushTimer     = 0;
    let errCount       = 0;
    let warnCount      = 0;

    // — REPL —
    /** @type {string[]} */
    let cmdHistory   = [];
    let historyIndex = -1;   // -1 = not navigating
    let historyDraft = '';   // editor content saved before navigation
    let activeTab    = 'log';

    // — settings —
    /** @type {typeof DEFAULT_SETTINGS | null} */
    let _cachedSettings = null;

    // — original console refs (saved once, before any monkey-patching) —
    const _orig = {
        log:   console.log.bind(console),
        warn:  console.warn.bind(console),
        error: console.error.bind(console),
        info:  console.info.bind(console),
        debug: console.debug.bind(console),
    };

    // =========================================================================
    //  SETTINGS
    // =========================================================================
    function getSettings() {
        if (_cachedSettings) return _cachedSettings;
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        if (!ctx.extensionSettings[MODULE_NAME])
            ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        _cachedSettings = ctx.extensionSettings[MODULE_NAME];
        return _cachedSettings;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    // =========================================================================
    //  HELPERS
    // =========================================================================
    const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const _escapeRe  = /[&<>"]/g;

    /** @param {string} s */
    function escapeHtml(s) {
        return s.replace(_escapeRe, ch => _escapeMap[ch]);
    }

    function timestamp() {
        const d = new Date();
        return (
            String(d.getHours()).padStart(2, '0')        + ':' +
            String(d.getMinutes()).padStart(2, '0')      + ':' +
            String(d.getSeconds()).padStart(2, '0')      + '.' +
            String(d.getMilliseconds()).padStart(3, '0')
        );
    }

    /** @param {any} val */
    function stringify(val) {
        if (val === undefined)  return 'undefined';
        if (val === null)       return 'null';
        if (typeof val === 'string')  return val;
        if (typeof val === 'number'  ||
            typeof val === 'boolean' ||
            typeof val === 'bigint') return String(val);
        if (typeof val === 'function')
            return '[Function: ' + (val.name || 'anonymous') + ']';
        if (val instanceof Error) {
            const s = val.stack || (val.name + ': ' + val.message);
            return s.length > MAX_STRINGIFY_LEN ? s.slice(0, MAX_STRINGIFY_LEN) + '…' : s;
        }
        if (typeof val === 'object') {
            try {
                const seen = new WeakSet();
                const s = JSON.stringify(val, (_, v) => {
                    if (typeof v === 'object' && v !== null) {
                        if (seen.has(v)) return '[Circular]';
                        seen.add(v);
                    }
                    return v;
                }, 2);
                return s.length > MAX_STRINGIFY_LEN
                    ? s.slice(0, MAX_STRINGIFY_LEN) + '…'
                    : s;
            } catch { return String(val); }
        }
        return String(val);
    }

    /** @param {IArguments|any[]} args */
    function argsToString(args) {
        let out = '';
        for (let i = 0; i < args.length; i++) {
            if (i > 0) out += ' ';
            out += stringify(args[i]);
        }
        return out;
    }

    // =========================================================================
    //  CONSOLE INTERCEPT
    // =========================================================================
    function pushEntry(/** @type {string} */ level, /** @type {IArguments|any[]} */ args) {
        const s     = getSettings();
        const entry = { level, time: timestamp(), args: argsToString(args) };

        logBuffer.push(entry);
        if (level === 'error') errCount++;
        if (level === 'warn')  warnCount++;

        const max = s.max_entries;
        while (logBuffer.length > max) {
            const removed = logBuffer.shift();
            if (removed.level === 'error') errCount--;
            if (removed.level === 'warn')  warnCount--;
        }

        // Queue DOM update only when the log panel is visible
        if (consoleVisible && activeTab === 'log') {
            pendingEntries.push(entry);
            if (!flushTimer)
                flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
        }
    }

    function flushPending() {
        flushTimer = 0;
        const el = document.getElementById('dt-log-list');
        if (!el || pendingEntries.length === 0) { pendingEntries = []; return; }

        const s = getSettings();
        let html = '';
        for (let i = 0; i < pendingEntries.length; i++) {
            const e = pendingEntries[i];
            if (activeFilter !== 'all' && e.level !== activeFilter) continue;
            if (searchQuery && e.args.toLowerCase().indexOf(searchQuery) === -1) continue;
            html += entryHtml(e, s);
        }
        pendingEntries = [];

        if (html) {
            el.insertAdjacentHTML('beforeend', html);
            while (el.childElementCount > MAX_VISIBLE_DOM)
                el.removeChild(/** @type {Node} */ (el.firstElementChild));
            el.scrollTop = el.scrollHeight;
        }
        updateCounters();
    }

    function installHooks() {
        const s = getSettings();
        if (!s.enabled) return;

        /** @param {string} level @param {Function} orig */
        const wrap = (level, orig) => function () {
            orig.apply(console, arguments);
            if (s['capture_' + level]) pushEntry(level, arguments);
        };

        console.log   = wrap('log',   _orig.log);
        console.warn  = wrap('warn',  _orig.warn);
        console.error = wrap('error', _orig.error);
        console.info  = wrap('info',  _orig.info);
        console.debug = wrap('debug', _orig.debug);
    }

    function uninstallHooks() {
        console.log   = _orig.log;
        console.warn  = _orig.warn;
        console.error = _orig.error;
        console.info  = _orig.info;
        console.debug = _orig.debug;
    }

    function installGlobalCatchers() {
        window.addEventListener('error', function (ev) {
            const src = ev.filename
                ? '\n    at ' + ev.filename + ':' + ev.lineno + ':' + ev.colno
                : '';
            pushEntry('error', ['[Uncaught] ' + (ev.message || 'Unknown error') + src]);
        });
        window.addEventListener('unhandledrejection', function (ev) {
            const r   = ev.reason;
            const msg = r instanceof Error ? (r.stack || r.message) : stringify(r);
            pushEntry('error', ['[Unhandled Promise] ' + msg]);
        });
    }

    // =========================================================================
    //  DOM — LOG RENDERING
    // =========================================================================
    /** @param {{level:string, time:string, args:string}} e @param {any} s */
    function entryHtml(e, s) {
        const t = s.show_timestamps
            ? '<span class="dt-time">' + e.time + '</span> '
            : '';

        let badgeClass, badgeText, displayText;

        if (e.level === 'repl') {
            const isInput = e.args.startsWith('> ');
            badgeClass   = isInput ? 'dt-badge-repl-in' : 'dt-badge-repl-out';
            badgeText    = isInput ? 'IN' : 'OUT';
            displayText  = escapeHtml(e.args.slice(2));   // strip '> ' or '← '
        } else {
            badgeClass  = 'dt-badge-' + e.level;
            badgeText   = e.level.toUpperCase();
            displayText = escapeHtml(e.args);
        }

        return (
            '<div class="dt-entry dt-entry-' + e.level + '">' +
            t +
            '<span class="dt-badge ' + badgeClass + '">' + badgeText + '</span> ' +
            '<span class="dt-msg">' + displayText + '</span>' +
            '</div>'
        );
    }

    function renderAllEntries() {
        const el = document.getElementById('dt-log-list');
        if (!el) return;
        const s = getSettings();

        let filtered = logBuffer;
        if (activeFilter !== 'all' || searchQuery) {
            filtered = [];
            for (let i = 0; i < logBuffer.length; i++) {
                const e = logBuffer[i];
                if (activeFilter !== 'all' && e.level !== activeFilter) continue;
                if (searchQuery && e.args.toLowerCase().indexOf(searchQuery) === -1) continue;
                filtered.push(e);
            }
        }

        const start = Math.max(0, filtered.length - MAX_VISIBLE_DOM);
        let html = '';
        for (let i = start; i < filtered.length; i++) html += entryHtml(filtered[i], s);
        el.innerHTML = html;
        el.scrollTop = el.scrollHeight;
    }

    function updateCounters() {
        const el = document.getElementById('dt-counter');
        if (!el) return;
        let t = String(logBuffer.length) + ' строк';
        if (errCount)  t += ' · <span style="color:#ef5350">'  + errCount  + ' err</span>';
        if (warnCount) t += ' · <span style="color:#ffa726">' + warnCount + ' warn</span>';
        el.innerHTML = t;
    }

    // =========================================================================
    //  LOG ACTIONS
    // =========================================================================
    function clearLogs() {
        logBuffer      = [];
        pendingEntries = [];
        errCount       = 0;
        warnCount      = 0;
        const logEl = document.getElementById('dt-log-list');
        if (logEl) logEl.innerHTML = '';
        updateReplOutput();
        updateCounters();
    }

    function exportLogs() {
        let text = '';
        for (let i = 0; i < logBuffer.length; i++) {
            const e = logBuffer[i];
            text += '[' + e.time + '] [' + e.level.toUpperCase() + '] ' + e.args + '\n';
        }
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'st-devtools-' + Date.now() + '.log';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    }

    function copyLogs() {
        let text  = '';
        let count = 0;
        for (let i = 0; i < logBuffer.length; i++) {
            const e = logBuffer[i];
            if (activeFilter !== 'all' && e.level !== activeFilter) continue;
            if (searchQuery && e.args.toLowerCase().indexOf(searchQuery) === -1) continue;
            text += '[' + e.time + '] [' + e.level.toUpperCase() + '] ' + e.args + '\n';
            count++;
        }
        navigator.clipboard.writeText(text).then(
            () => toastr.success('Скопировано ' + count + ' записей', 'DevTools'),
            () => toastr.error('Не удалось скопировать', 'DevTools')
        );
    }

    // =========================================================================
    //  REPL — PERSISTENCE
    // =========================================================================
    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); }
        catch { return []; }
    }

    function persistHistory() {
        try {
            localStorage.setItem(LS_HISTORY, JSON.stringify(cmdHistory.slice(-MAX_HISTORY)));
        } catch { /* quota exceeded — silent */ }
    }

    function loadSnippets() {
        try { return JSON.parse(localStorage.getItem(LS_SNIPPETS) || '[]'); }
        catch { return []; }
    }

    /** @param {any[]} arr */
    function persistSnippets(arr) {
        try { localStorage.setItem(LS_SNIPPETS, JSON.stringify(arr)); }
        catch { /* quota exceeded — silent */ }
    }

    // =========================================================================
    //  REPL — EXECUTION
    // =========================================================================
    /** @param {string} code */
    async function executeCode(code) {
        const trimmed = code.trim();
        if (!trimmed) return;

        // Deduplicate history; push to end
        if (cmdHistory[cmdHistory.length - 1] !== trimmed) {
            cmdHistory.push(trimmed);
            if (cmdHistory.length > MAX_HISTORY) cmdHistory.shift();
            persistHistory();
        }
        historyIndex = -1;
        historyDraft = '';
        updateHistoryPos();

        // Echo input to log
        pushEntry('repl', ['> ' + trimmed]);

        const stCtx = SillyTavern.getContext();
        // @ts-ignore — AsyncFunction constructor trick
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

        try {
            let result;

            // Pass 1 — expression mode.
            // Wraps code in return() and injects ctx/chat/char/$ as named params.
            // Works for one-liners: ctx.name, chat.length, 1+2, etc.
            try {
                const fn = new AsyncFn(
                    'ctx', 'chat', 'char', '$',
                    'return (\n' + trimmed + '\n)'
                );
                result = await fn(
                    stCtx,
                    stCtx.chat                              ?? [],
                    stCtx.characters?.[stCtx.character_id] ?? null,
                    window.jQuery                           ?? null
                );
            } catch (e1) {
                // Runtime error in expression mode → real error, don't retry.
                if (!(e1 instanceof SyntaxError)) throw e1;

                // SyntaxError → user wrote statements (const, let, loops, etc).
                // Pass 2 — statement mode, NO injected params so user's own
                // variable declarations (const ctx = ...) never conflict.
                const fn = new AsyncFn(trimmed);
                result = await fn();
            }

            if (result !== undefined) {
                pushEntry('repl', ['← ' + stringify(result)]);
            }

        } catch (/** @type {any} */ e) {
            pushEntry('error', ['[REPL] ' + (e.stack || e.message || String(e))]);
        }

        // Clear editor after run
        const inputEl = /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('dt-repl-input')
        );
        if (inputEl) inputEl.value = '';

        updateReplOutput();
    }

    function updateReplOutput() {
        const el = document.getElementById('dt-repl-output');
        if (!el) return;

        const s       = getSettings();
        const entries = logBuffer.filter(e =>
            e.level === 'repl' ||
            (e.level === 'error' && e.args.startsWith('[REPL]'))
        );

        if (entries.length === 0) {
            el.innerHTML = '<div class="dt-repl-empty">Результаты появятся здесь</div>';
            return;
        }

        const recent = entries.slice(-MAX_REPL_OUTPUT_ROWS);
        el.innerHTML = recent.map(e => entryHtml(e, s)).join('');
        el.scrollTop = el.scrollHeight;
    }

    function copyReplOutput() {
        const entries = logBuffer.filter(e =>
            e.level === 'repl' ||
            (e.level === 'error' && e.args.startsWith('[REPL]'))
        );
        const recent = entries.slice(-MAX_REPL_OUTPUT_ROWS);
        if (recent.length === 0) { toastr.warning('Вывод пуст', 'DevTools'); return; }
        const text = recent.map(e => e.args).join('\n');
        navigator.clipboard.writeText(text).then(
            () => toastr.success('Вывод скопирован', 'DevTools'),
            () => toastr.error('Не удалось скопировать', 'DevTools')
        );
    }

    // =========================================================================
    //  REPL — HISTORY NAVIGATION
    // =========================================================================
    function historyPrev() {
        if (cmdHistory.length === 0) return;
        const inputEl = /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('dt-repl-input')
        );
        if (!inputEl) return;

        if (historyIndex === -1) {
            historyDraft = inputEl.value;            // save current draft
            historyIndex = cmdHistory.length - 1;
        } else if (historyIndex > 0) {
            historyIndex--;
        } else {
            return;  // already at oldest
        }

        inputEl.value = cmdHistory[historyIndex];
        updateHistoryPos();
    }

    function historyNext() {
        const inputEl = /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('dt-repl-input')
        );
        if (!inputEl || historyIndex === -1) return;

        if (historyIndex < cmdHistory.length - 1) {
            historyIndex++;
            inputEl.value = cmdHistory[historyIndex];
        } else {
            historyIndex  = -1;
            inputEl.value = historyDraft;
        }
        updateHistoryPos();
    }

    function updateHistoryPos() {
        const el = document.getElementById('dt-hist-pos');
        if (!el) return;
        el.textContent = historyIndex === -1
            ? ''
            : (historyIndex + 1) + ' / ' + cmdHistory.length;
    }

    // =========================================================================
    //  SNIPPETS
    // =========================================================================
    function renderSnippetsList() {
        const el = document.getElementById('dt-snippets-list');
        if (!el) return;

        const snippets = loadSnippets();
        if (snippets.length === 0) {
            el.innerHTML =
                '<div class="dt-repl-empty">' +
                'Нет сохранённых сниппетов.<br>' +
                'Напиши код во вкладке REPL и нажми «Сохранить».' +
                '</div>';
            return;
        }

        el.innerHTML = snippets.map((/** @type {any} */ sn, i) =>
            '<div class="dt-snippet-item">' +
                '<div class="dt-snippet-name">' + escapeHtml(sn.name) + '</div>' +
                '<div class="dt-snippet-code">' +
                    escapeHtml(sn.code.slice(0, 120)) +
                    (sn.code.length > 120 ? '…' : '') +
                '</div>' +
                '<div class="dt-snippet-actions">' +
                    '<div class="menu_button dt-snippet-load" data-index="' + i + '">' +
                        '<i class="fa-solid fa-arrow-up-right-from-square"></i> Загрузить' +
                    '</div>' +
                    '<div class="menu_button dt-snippet-copy" data-index="' + i + '" title="Скопировать код">' +
                        '<i class="fa-solid fa-copy"></i>' +
                    '</div>' +
                    '<div class="menu_button dt-snippet-del" data-index="' + i + '" title="Удалить">' +
                        '<i class="fa-solid fa-trash-can"></i>' +
                    '</div>' +
                '</div>' +
            '</div>'
        ).join('');
    }

    function saveCurrentAsSnippet() {
        const inputEl = /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('dt-repl-input')
        );
        const code = inputEl ? inputEl.value.trim() : '';
        if (!code) { toastr.warning('Редактор пуст', 'DevTools'); return; }

        const name = prompt('Название сниппета:');
        if (name === null) return;
        if (!name.trim()) { toastr.warning('Введите название', 'DevTools'); return; }

        const snippets = loadSnippets();
        snippets.push({ name: name.trim(), code, createdAt: new Date().toISOString() });
        persistSnippets(snippets);
        toastr.success('Сниппет «' + name.trim() + '» сохранён', 'DevTools');
    }

    /** @param {number} index */
    function deleteSnippet(index) {
        const snippets = loadSnippets();
        const sn = snippets[index];
        if (!sn) return;
        if (!confirm('Удалить сниппет «' + sn.name + '»?')) return;
        snippets.splice(index, 1);
        persistSnippets(snippets);
        renderSnippetsList();
        toastr.info('Сниппет удалён', 'DevTools');
    }

    /** @param {number} index */
    function loadSnippetToEditor(index) {
        const snippets = loadSnippets();
        const sn = snippets[index];
        if (!sn) return;
        const inputEl = /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('dt-repl-input')
        );
        if (!inputEl) return;
        inputEl.value = sn.code;
        switchTab('repl');
        toastr.success('Сниппет «' + sn.name + '» загружен', 'DevTools');
    }

    /** @param {number} index */
    function copySnippetCode(index) {
        const snippets = loadSnippets();
        const sn = snippets[index];
        if (!sn) return;
        navigator.clipboard.writeText(sn.code).then(
            () => toastr.success('Код скопирован', 'DevTools'),
            () => toastr.error('Не удалось скопировать', 'DevTools')
        );
    }

    // =========================================================================
    //  UI — TAB SWITCHING
    // =========================================================================
    /** @param {string} tab */
    function switchTab(tab) {
        activeTab = tab;
        $('.dt-console-tab').removeClass('dt-tab-active');
        $('.dt-console-tab[data-tab="' + tab + '"]').addClass('dt-tab-active');

        // Show/hide panels — use display:flex explicitly so gap works
        ['log', 'repl', 'snippets'].forEach(function (t) {
            const el = document.getElementById('dt-panel-' + t);
            if (el) el.style.display = (t === tab) ? 'flex' : 'none';
        });

        if (tab === 'log')      { renderAllEntries(); updateCounters(); }
        if (tab === 'repl')     { updateReplOutput(); updateHistoryPos(); }
        if (tab === 'snippets') { renderSnippetsList(); }
    }

    // =========================================================================
    //  UI — INIT
    // =========================================================================
    function initUI() {
        const s = getSettings();

        const html = `
<div id="${MODULE_NAME}-settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>DevTools</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:flex;flex-direction:column;gap:8px;">

      <label class="checkbox_label">
        <input id="dt-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>
        перехват консоли включён
      </label>

      <div style="display:flex;flex-wrap:wrap;gap:6px 14px;">
        <label class="checkbox_label"><input id="dt-cap-log"   type="checkbox" ${s.capture_log   ? 'checked' : ''}> log</label>
        <label class="checkbox_label"><input id="dt-cap-warn"  type="checkbox" ${s.capture_warn  ? 'checked' : ''}> warn</label>
        <label class="checkbox_label"><input id="dt-cap-error" type="checkbox" ${s.capture_error ? 'checked' : ''}> error</label>
        <label class="checkbox_label"><input id="dt-cap-info"  type="checkbox" ${s.capture_info  ? 'checked' : ''}> info</label>
        <label class="checkbox_label"><input id="dt-cap-debug" type="checkbox" ${s.capture_debug ? 'checked' : ''}> debug</label>
      </div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <label class="checkbox_label">
          <input id="dt-timestamps" type="checkbox" ${s.show_timestamps ? 'checked' : ''}>
          время
        </label>
        <label class="checkbox_label">
          <input id="dt-wordwrap" type="checkbox" ${s.word_wrap ? 'checked' : ''}>
          перенос строк
        </label>
      </div>

      <div style="display:flex;align-items:center;gap:8px;">
        <label style="font-size:0.85em;white-space:nowrap;opacity:0.7;">лимит записей:</label>
        <input id="dt-max-entries" type="number" class="text_pole"
               value="${s.max_entries}" min="50" max="2000" step="50"
               style="width:80px;" />
      </div>

      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:2px 0;" />

      <div id="dt-btn-toggle" class="menu_button">
        <i class="fa-solid fa-terminal"></i> показать консоль
      </div>

      <!-- ═══ CONSOLE BLOCK ══════════════════════════════════════════════ -->
      <div id="dt-console-block"
           style="display:none;flex-direction:column;gap:0;">

        <!-- Tab bar -->
        <div id="dt-console-tabs">
          <span class="dt-console-tab dt-tab-active" data-tab="log">
            <i class="fa-solid fa-list-ul"></i> Лог
          </span>
          <span class="dt-console-tab" data-tab="repl">
            <i class="fa-solid fa-terminal"></i> REPL
          </span>
          <span class="dt-console-tab" data-tab="snippets">
            <i class="fa-solid fa-bookmark"></i> Сниппеты
          </span>
        </div>

        <!-- ── LOG PANEL ─────────────────────────────────────────────── -->
        <div id="dt-panel-log"
             style="display:flex;flex-direction:column;gap:6px;padding-top:8px;">

          <div id="dt-filters" style="display:flex;flex-wrap:wrap;gap:3px;">
            <span class="dt-filter dt-filter-active" data-level="all">All</span>
            <span class="dt-filter" data-level="error">Error</span>
            <span class="dt-filter" data-level="warn">Warn</span>
            <span class="dt-filter" data-level="log">Log</span>
            <span class="dt-filter" data-level="info">Info</span>
            <span class="dt-filter" data-level="debug">Debug</span>
            <span class="dt-filter" data-level="repl">REPL</span>
          </div>

          <input id="dt-search" type="text" class="text_pole"
                 placeholder="поиск по записям…" />

          <div id="dt-log-list" class="${s.word_wrap ? '' : 'dt-nowrap'}"></div>

          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span id="dt-counter" style="font-size:0.8em;opacity:0.5;flex:1;">0 строк</span>
            <div class="menu_button" id="dt-btn-copy">
              <i class="fa-solid fa-copy"></i> копировать
            </div>
            <div class="menu_button" id="dt-btn-export">
              <i class="fa-solid fa-download"></i> скачать
            </div>
            <div class="menu_button" id="dt-btn-clear">
              <i class="fa-solid fa-trash-can"></i> очистить
            </div>
          </div>
        </div>

        <!-- ── REPL PANEL ─────────────────────────────────────────────── -->
        <div id="dt-panel-repl"
             style="display:none;flex-direction:column;gap:8px;padding-top:8px;">

          <!-- History navigation -->
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
            <div class="menu_button dt-hist-btn" id="dt-hist-prev"
                 title="Предыдущая команда из истории">
              <i class="fa-solid fa-chevron-up"></i> Пред.
            </div>
            <div class="menu_button dt-hist-btn" id="dt-hist-next"
                 title="Следующая команда / вернуть черновик">
              <i class="fa-solid fa-chevron-down"></i> След.
            </div>
            <span id="dt-hist-pos" class="dt-hist-pos-label"></span>
          </div>

          <!-- Editor -->
          <textarea
            id="dt-repl-input"
            class="text_pole dt-repl-textarea"
            placeholder="// Доступны: ctx, chat, char, $&#10;// Ctrl+Enter — выполнить&#10;// Однострочные выражения возвращаются автоматически:&#10;ctx.name"
            rows="6"
            spellcheck="false"
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
          ></textarea>

          <!-- Action buttons -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <div class="menu_button dt-run-btn" id="dt-repl-run">
              <i class="fa-solid fa-play"></i> Run
              <span class="dt-shortcut-hint">Ctrl+↵</span>
            </div>
            <div class="menu_button" id="dt-repl-clear-btn"
                 title="Очистить редактор">
              <i class="fa-solid fa-xmark"></i> Очистить
            </div>
            <div class="menu_button" id="dt-repl-save-snippet"
                 style="margin-left:auto;"
                 title="Сохранить текущий код как сниппет">
              <i class="fa-solid fa-floppy-disk"></i> Сохранить
            </div>
          </div>

          <!-- REPL output -->
          <div class="dt-repl-output-label" style="display:flex;align-items:center;gap:6px;">
            <span><i class="fa-solid fa-angles-right"></i> Результат</span>
            <div class="menu_button" id="dt-repl-copy-output"
                 style="font-size:0.8em;padding:2px 8px;margin-left:auto;"
                 title="Скопировать вывод">
              <i class="fa-solid fa-copy"></i> копировать
            </div>
          </div>
          <div id="dt-repl-output">
            <div class="dt-repl-empty">Результаты появятся здесь</div>
          </div>
        </div>

        <!-- ── SNIPPETS PANEL ─────────────────────────────────────────── -->
        <div id="dt-panel-snippets"
             style="display:none;flex-direction:column;gap:8px;padding-top:8px;">

          <div style="font-size:0.82em;opacity:0.5;line-height:1.4;">
            «Загрузить» — открыть сниппет во вкладке REPL.
          </div>
          <div id="dt-snippets-list"></div>
        </div>

      </div>
      <!-- ═══ END CONSOLE BLOCK ══════════════════════════════════════════ -->

    </div>
  </div>
</div>`;

        $('#extensions_settings').append(html);

        // ── Settings bindings ─────────────────────────────────────────────
        $('#dt-enabled').on('change', function () {
            s.enabled = $(this).is(':checked');
            saveSettings();
            s.enabled ? installHooks() : uninstallHooks();
        });

        /** @type {Record<string,string>} */
        const capMap = {
            '#dt-cap-log':   'capture_log',
            '#dt-cap-warn':  'capture_warn',
            '#dt-cap-error': 'capture_error',
            '#dt-cap-info':  'capture_info',
            '#dt-cap-debug': 'capture_debug',
        };
        for (const [sel, key] of Object.entries(capMap)) {
            $(sel).on('change', function () {
                s[key] = $(this).is(':checked');
                saveSettings();
            });
        }

        $('#dt-timestamps').on('change', function () {
            s.show_timestamps = $(this).is(':checked');
            saveSettings();
            renderAllEntries();
            updateReplOutput();
        });

        $('#dt-wordwrap').on('change', function () {
            s.word_wrap = $(this).is(':checked');
            saveSettings();
            $('#dt-log-list').toggleClass('dt-nowrap', !s.word_wrap);
        });

        $('#dt-max-entries').on('change', function () {
            s.max_entries = Math.max(
                50,
                Math.min(2000, parseInt(/** @type {string} */ ($(this).val()), 10) || 200)
            );
            $(this).val(s.max_entries);
            saveSettings();
        });

        // ── Console show/hide toggle ───────────────────────────────────────
        $('#dt-btn-toggle').on('click', function () {
            consoleVisible = !consoleVisible;
            const block = /** @type {HTMLElement} */ (
                document.getElementById('dt-console-block')
            );
            block.style.display = consoleVisible ? 'flex' : 'none';
            $(this).html(
                consoleVisible
                    ? '<i class="fa-solid fa-terminal"></i> скрыть консоль'
                    : '<i class="fa-solid fa-terminal"></i> показать консоль'
            );
            if (consoleVisible) switchTab(activeTab);
        });

        // ── Tab switching ──────────────────────────────────────────────────
        $('#dt-console-tabs').on('click', '.dt-console-tab', function () {
            switchTab($(this).data('tab'));
        });

        // ── Log panel ─────────────────────────────────────────────────────
        $('#dt-filters').on('click', '.dt-filter', function () {
            $('.dt-filter').removeClass('dt-filter-active');
            $(this).addClass('dt-filter-active');
            activeFilter = $(this).data('level');
            renderAllEntries();
        });

        let searchTimeout = 0;
        $('#dt-search').on('input', function () {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function () {
                searchQuery = /** @type {string} */ ($('#dt-search').val())
                    .toLowerCase()
                    .trim();
                renderAllEntries();
            }, 300);
        });

        $('#dt-btn-copy').on('click', copyLogs);
        $('#dt-btn-export').on('click', exportLogs);
        $('#dt-btn-clear').on('click', clearLogs);

        // ── REPL panel ────────────────────────────────────────────────────
        $('#dt-repl-run').on('click', function () {
            const inputEl = /** @type {HTMLTextAreaElement|null} */ (
                document.getElementById('dt-repl-input')
            );
            if (inputEl) executeCode(inputEl.value);
        });

        // Ctrl+Enter in textarea
        $('#dt-repl-input').on('keydown', function (ev) {
            if (ev.ctrlKey && ev.key === 'Enter') {
                ev.preventDefault();
                executeCode(/** @type {HTMLTextAreaElement} */ (ev.target).value);
            }
        });

        $('#dt-repl-clear-btn').on('click', function () {
            const inputEl = /** @type {HTMLTextAreaElement|null} */ (
                document.getElementById('dt-repl-input')
            );
            if (inputEl) inputEl.value = '';
            historyIndex = -1;
            historyDraft = '';
            updateHistoryPos();
        });

        $('#dt-repl-save-snippet').on('click', saveCurrentAsSnippet);
        $('#dt-hist-prev').on('click', historyPrev);
        $('#dt-hist-next').on('click', historyNext);
        $('#dt-repl-copy-output').on('click', copyReplOutput);

        // ── Snippets panel (event delegation) ─────────────────────────────
        $('#dt-snippets-list').on('click', '.dt-snippet-load', function () {
            loadSnippetToEditor(parseInt($(this).data('index'), 10));
        });
        $('#dt-snippets-list').on('click', '.dt-snippet-copy', function () {
            copySnippetCode(parseInt($(this).data('index'), 10));
        });
        $('#dt-snippets-list').on('click', '.dt-snippet-del', function () {
            deleteSnippet(parseInt($(this).data('index'), 10));
        });
    }

    // =========================================================================
    //  INIT
    // =========================================================================
    $(document).ready(function () {
        cmdHistory = loadHistory();

        installHooks();
        installGlobalCatchers();

        const ctx = SillyTavern.getContext();
        ctx.eventSource.on(ctx.event_types.APP_READY, function () {
            try {
                initUI();
                _orig.log(
                    '[DevTools] v2.0.0 ready.' +
                    (typeof process !== 'undefined' ? ' Node ' + process.version : '')
                );
            } catch (/** @type {any} */ err) {
                _orig.error('[DevTools] Init failed:', err);
                toastr.error('DevTools: ' + err.message, 'Ошибка', { timeOut: 8000 });
            }
        });
    });

})();
