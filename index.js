// @ts-check
(function () {
    const MODULE_NAME = 'st_devtools';
    const MAX_STRINGIFY_LEN = 1000;  // truncate fat objects
    const MAX_VISIBLE_DOM = 150;     // cap DOM nodes in the log list
    const FLUSH_INTERVAL = 300;      // ms between DOM flushes

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        max_entries: 200,
        capture_log: true,
        capture_warn: true,
        capture_error: true,
        capture_info: true,
        capture_debug: false,
        show_timestamps: true,
        word_wrap: true,
    });

    /** @type {Array<{level: string, time: string, args: string}>} */
    let logBuffer = [];
    let activeFilter = 'all';
    let searchQuery = '';
    let consoleVisible = false;

    // Performance state
    /** @type {Array<{level: string, time: string, args: string}>} */
    let pendingEntries = [];
    let flushTimer = 0;
    let errCount = 0;
    let warnCount = 0;

    /** @type {ReturnType<typeof getSettings>|null} */
    let _cachedSettings = null;

    // Original console — saved ONCE
    const _orig = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
    };

    // =========================================================================
    //  SETTINGS (cached)
    // =========================================================================
    function getSettings() {
        if (_cachedSettings) return _cachedSettings;
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        if (!ctx.extensionSettings[MODULE_NAME]) {
            ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
        _cachedSettings = ctx.extensionSettings[MODULE_NAME];
        return _cachedSettings;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    // =========================================================================
    //  FAST HELPERS (no DOM, no allocations)
    // =========================================================================
    const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const _escapeRe = /[&<>"]/g;

    function escapeHtml(s) {
        return s.replace(_escapeRe, ch => _escapeMap[ch]);
    }

    function timestamp() {
        const d = new Date();
        return (
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0') + ':' +
            String(d.getSeconds()).padStart(2, '0') + '.' +
            String(d.getMilliseconds()).padStart(3, '0')
        );
    }

    function stringify(val) {
        if (val === undefined) return 'undefined';
        if (val === null) return 'null';
        if (typeof val === 'string') return val;
        if (typeof val === 'number' || typeof val === 'boolean') return String(val);
        if (val instanceof Error) {
            const s = val.stack || `${val.name}: ${val.message}`;
            return s.length > MAX_STRINGIFY_LEN ? s.slice(0, MAX_STRINGIFY_LEN) + '…' : s;
        }
        if (typeof val === 'object') {
            try {
                const s = JSON.stringify(val);
                return s.length > MAX_STRINGIFY_LEN ? s.slice(0, MAX_STRINGIFY_LEN) + '…' : s;
            } catch { return String(val); }
        }
        return String(val);
    }

    function argsToString(args) {
        let out = '';
        for (let i = 0; i < args.length; i++) {
            if (i > 0) out += ' ';
            out += stringify(args[i]);
        }
        return out;
    }

    // =========================================================================
    //  INTERCEPT CORE
    // =========================================================================
    function pushEntry(level, args) {
        const s = getSettings();
        const entry = { level, time: timestamp(), args: argsToString(args) };

        logBuffer.push(entry);
        if (level === 'error') errCount++;
        if (level === 'warn') warnCount++;

        // Trim — pop from front
        const max = s.max_entries;
        while (logBuffer.length > max) {
            const r = logBuffer.shift();
            if (r.level === 'error') errCount--;
            if (r.level === 'warn') warnCount--;
        }

        if (consoleVisible) {
            pendingEntries.push(entry);
            if (!flushTimer) {
                flushTimer = setTimeout(flushPending, FLUSH_INTERVAL);
            }
        }
    }

    function flushPending() {
        flushTimer = 0;
        const el = document.getElementById('dt-log-list');
        if (!el || pendingEntries.length === 0) {
            pendingEntries = [];
            return;
        }

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

            // Cap visible DOM nodes — remove from top
            while (el.childElementCount > MAX_VISIBLE_DOM) {
                el.removeChild(el.firstElementChild);
            }

            el.scrollTop = el.scrollHeight;
        }

        updateCounters();
    }

    // =========================================================================
    //  HOOKS
    // =========================================================================
    function installHooks() {
        const s = getSettings();
        if (!s.enabled) return;

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
            const msg = ev.message || 'Unknown error';
            const src = ev.filename ? '\n    at ' + ev.filename + ':' + ev.lineno + ':' + ev.colno : '';
            pushEntry('error', ['[Uncaught] ' + msg + src]);
        });
        window.addEventListener('unhandledrejection', function (ev) {
            const r = ev.reason;
            const msg = r instanceof Error ? (r.stack || r.message) : stringify(r);
            pushEntry('error', ['[Unhandled Promise] ' + msg]);
        });
    }

    // =========================================================================
    //  DOM — minimal, fast
    // =========================================================================
    function entryHtml(e, s) {
        const t = s.show_timestamps ? '<span class="dt-time">' + e.time + '</span> ' : '';
        return '<div class="dt-entry dt-entry-' + e.level + '">' +
            t +
            '<span class="dt-badge dt-badge-' + e.level + '">' + e.level.toUpperCase() + '</span> ' +
            '<span class="dt-msg">' + escapeHtml(e.args) + '</span>' +
            '</div>';
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

        // Only render last MAX_VISIBLE_DOM entries
        const start = Math.max(0, filtered.length - MAX_VISIBLE_DOM);
        let html = '';
        for (let i = start; i < filtered.length; i++) {
            html += entryHtml(filtered[i], s);
        }
        el.innerHTML = html;
        el.scrollTop = el.scrollHeight;
    }

    function updateCounters() {
        const el = document.getElementById('dt-counter');
        if (!el) return;
        let t = String(logBuffer.length);
        if (errCount) t += ' · <span style="color:#ff6b6b">' + errCount + ' err</span>';
        if (warnCount) t += ' · <span style="color:#ffa726">' + warnCount + ' warn</span>';
        el.innerHTML = t;
    }

    // =========================================================================
    //  ACTIONS
    // =========================================================================
    function clearLogs() {
        logBuffer = [];
        pendingEntries = [];
        errCount = 0;
        warnCount = 0;
        const el = document.getElementById('dt-log-list');
        if (el) el.innerHTML = '';
        updateCounters();
    }

    function exportLogs() {
        let text = '';
        for (let i = 0; i < logBuffer.length; i++) {
            const e = logBuffer[i];
            text += '[' + e.time + '] [' + e.level.toUpperCase() + '] ' + e.args + '\n';
        }
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'st-devtools-' + Date.now() + '.log';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 200);
    }

    function copyLogs() {
        let text = '';
        let count = 0;
        for (let i = 0; i < logBuffer.length; i++) {
            const e = logBuffer[i];
            if (activeFilter !== 'all' && e.level !== activeFilter) continue;
            if (searchQuery && e.args.toLowerCase().indexOf(searchQuery) === -1) continue;
            text += '[' + e.time + '] [' + e.level.toUpperCase() + '] ' + e.args + '\n';
            count++;
        }
        navigator.clipboard.writeText(text).then(
            function () { toastr.success('Скопировано ' + count + ' записей'); },
            function () { toastr.error('Не удалось скопировать'); }
        );
    }

    // =========================================================================
    //  UI
    // =========================================================================
    function initUI() {
        const settings = getSettings();

        const html = `
        <div id="${MODULE_NAME}-settings" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>DevTools</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display: flex; flex-direction: column; gap: 8px;">

                    <label class="checkbox_label">
                        <input id="dt-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                        перехват включён
                    </label>

                    <div style="display:flex; flex-wrap:wrap; gap:6px 14px;">
                        <label class="checkbox_label"><input id="dt-cap-log"   type="checkbox" ${settings.capture_log   ? 'checked' : ''}> log</label>
                        <label class="checkbox_label"><input id="dt-cap-warn"  type="checkbox" ${settings.capture_warn  ? 'checked' : ''}> warn</label>
                        <label class="checkbox_label"><input id="dt-cap-error" type="checkbox" ${settings.capture_error ? 'checked' : ''}> error</label>
                        <label class="checkbox_label"><input id="dt-cap-info"  type="checkbox" ${settings.capture_info  ? 'checked' : ''}> info</label>
                        <label class="checkbox_label"><input id="dt-cap-debug" type="checkbox" ${settings.capture_debug ? 'checked' : ''}> debug</label>
                    </div>

                    <label class="checkbox_label">
                        <input id="dt-timestamps" type="checkbox" ${settings.show_timestamps ? 'checked' : ''}>
                        показывать время
                    </label>
                    <label class="checkbox_label">
                        <input id="dt-wordwrap" type="checkbox" ${settings.word_wrap ? 'checked' : ''}>
                        перенос строк
                    </label>

                    <label>лимит записей:</label>
                    <input id="dt-max-entries" type="number" class="text_pole" value="${settings.max_entries}" min="50" max="2000" step="50" />

                    <hr style="border-color: rgba(255,255,255,0.08); width:100%; margin:4px 0;" />

                    <div id="dt-btn-toggle" class="menu_button"><i class="fa-solid fa-terminal"></i> показать консоль</div>

                    <div id="dt-console-block" style="display:none;">

                        <div id="dt-filters" style="display:flex; flex-wrap:wrap; gap:3px; margin-bottom:6px;">
                            <span class="dt-filter dt-filter-active" data-level="all">All</span>
                            <span class="dt-filter" data-level="error">Errors</span>
                            <span class="dt-filter" data-level="warn">Warn</span>
                            <span class="dt-filter" data-level="log">Log</span>
                            <span class="dt-filter" data-level="info">Info</span>
                            <span class="dt-filter" data-level="debug">Debug</span>
                        </div>

                        <input id="dt-search" type="text" class="text_pole" placeholder="поиск..." style="margin-bottom:6px;" />

                        <div id="dt-log-list" class="${settings.word_wrap ? '' : 'dt-nowrap'}"></div>

                        <div style="display:flex; align-items:center; gap:8px; margin-top:6px; flex-wrap:wrap;">
                            <span id="dt-counter" style="font-size:0.85em; opacity:0.6;">0</span>
                            <div class="menu_button" id="dt-btn-copy"><i class="fa-solid fa-copy"></i> копировать</div>
                            <div class="menu_button" id="dt-btn-export"><i class="fa-solid fa-download"></i> скачать</div>
                            <div class="menu_button" id="dt-btn-clear"><i class="fa-solid fa-trash-can"></i> очистить</div>
                        </div>
                    </div>

                </div>
            </div>
        </div>`;

        $('#extensions_settings').append(html);

        // --- Bindings ---
        $('#dt-enabled').on('change', function () {
            settings.enabled = $(this).is(':checked');
            saveSettings();
            settings.enabled ? installHooks() : uninstallHooks();
        });

        const capMap = {
            '#dt-cap-log': 'capture_log',
            '#dt-cap-warn': 'capture_warn',
            '#dt-cap-error': 'capture_error',
            '#dt-cap-info': 'capture_info',
            '#dt-cap-debug': 'capture_debug',
        };
        for (const [sel, key] of Object.entries(capMap)) {
            $(sel).on('change', function () { settings[key] = $(this).is(':checked'); saveSettings(); });
        }

        $('#dt-timestamps').on('change', function () {
            settings.show_timestamps = $(this).is(':checked');
            saveSettings();
            renderAllEntries();
        });
        $('#dt-wordwrap').on('change', function () {
            settings.word_wrap = $(this).is(':checked');
            saveSettings();
            $('#dt-log-list').toggleClass('dt-nowrap', !settings.word_wrap);
        });
        $('#dt-max-entries').on('change', function () {
            settings.max_entries = Math.max(50, Math.min(2000, parseInt($(this).val(), 10) || 200));
            $(this).val(settings.max_entries);
            saveSettings();
        });

        // Console toggle
        $('#dt-btn-toggle').on('click', function () {
            consoleVisible = !consoleVisible;
            if (consoleVisible) {
                $('#dt-console-block').slideDown(150);
                $(this).html('<i class="fa-solid fa-terminal"></i> скрыть консоль');
                renderAllEntries();
                updateCounters();
            } else {
                $('#dt-console-block').slideUp(150);
                $(this).html('<i class="fa-solid fa-terminal"></i> показать консоль');
            }
        });

        // Filter tabs
        $('#dt-filters').on('click', '.dt-filter', function () {
            $('.dt-filter').removeClass('dt-filter-active');
            $(this).addClass('dt-filter-active');
            activeFilter = $(this).data('level');
            renderAllEntries();
        });

        // Search (debounced 300ms)
        let searchTimeout;
        $('#dt-search').on('input', function () {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function () {
                searchQuery = $('#dt-search').val().toLowerCase().trim();
                renderAllEntries();
            }, 300);
        });

        // Actions
        $('#dt-btn-copy').on('click', copyLogs);
        $('#dt-btn-export').on('click', exportLogs);
        $('#dt-btn-clear').on('click', clearLogs);
    }

    // =========================================================================
    //  INIT
    // =========================================================================
    $(document).ready(function () {
        const context = SillyTavern.getContext();

        installHooks();
        installGlobalCatchers();

        context.eventSource.on(context.event_types.APP_READY, function () {
            try {
                initUI();
                _orig.log('[DevTools] Extension loaded.');
            } catch (err) {
                _orig.error('[DevTools] Init failed:', err);
                toastr.error('DevTools: ' + err.message, 'Ошибка', { timeOut: 8000 });
            }
        });
    });

})();
