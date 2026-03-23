// @ts-check
(function () {
    const MODULE_NAME = 'st_devtools';

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        max_entries: 500,
        capture_log: true,
        capture_warn: true,
        capture_error: true,
        capture_info: true,
        capture_debug: false,
        show_timestamps: true,
        word_wrap: true,
    });

    /** @type {Array<{id: number, level: string, time: string, args: string}>} */
    let logBuffer = [];
    let idCounter = 0;
    let activeFilter = 'all';
    let searchQuery = '';
    let consoleVisible = false;

    // --- Performance: batch DOM updates ---
    /** @type {Array<{id: number, level: string, time: string, args: string}>} */
    let pendingEntries = [];
    let flushScheduled = false;
    let errCount = 0;
    let warnCount = 0;

    // Original console references — saved ONCE
    const _originals = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
    };

    function getSettings() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        if (!ctx.extensionSettings[MODULE_NAME]) {
            ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
        return ctx.extensionSettings[MODULE_NAME];
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function timestamp() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    }

    function stringify(val) {
        if (val === undefined) return 'undefined';
        if (val === null) return 'null';
        if (val instanceof Error) return `${val.name}: ${val.message}\n${val.stack || ''}`;
        if (typeof val === 'object') {
            try { return JSON.stringify(val, null, 2); }
            catch { return String(val); }
        }
        return String(val);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // =========================================================================
    //  INTERCEPT
    // =========================================================================
    function pushEntry(level, args) {
        const settings = getSettings();
        const entry = {
            id: ++idCounter,
            level,
            time: timestamp(),
            args: Array.from(args).map(stringify).join(' '),
        };

        logBuffer.push(entry);
        if (level === 'error') errCount++;
        if (level === 'warn') warnCount++;

        // Trim oldest
        while (logBuffer.length > settings.max_entries) {
            const removed = logBuffer.shift();
            if (removed.level === 'error') errCount--;
            if (removed.level === 'warn') warnCount--;
        }

        // Queue for batch DOM update instead of immediate append
        if (consoleVisible) {
            pendingEntries.push(entry);
            scheduleFlush();
        }
    }

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        requestAnimationFrame(flushPending);
    }

    function flushPending() {
        flushScheduled = false;
        const $list = $('#dt-log-list');
        if (!$list.length || pendingEntries.length === 0) {
            pendingEntries = [];
            return;
        }

        // Build all HTML at once, append once
        const htmlParts = [];
        for (const entry of pendingEntries) {
            if (activeFilter !== 'all' && entry.level !== activeFilter) continue;
            if (searchQuery && !entry.args.toLowerCase().includes(searchQuery)) continue;
            htmlParts.push(buildEntryHtml(entry));
        }
        pendingEntries = [];

        if (htmlParts.length > 0) {
            $list.append(htmlParts.join(''));
            $list[0].scrollTop = $list[0].scrollHeight;
        }

        updateCounters();
    }

    function installHooks() {
        const settings = getSettings();
        const wrap = (level, original) => {
            return function (...args) {
                original(...args);
                if (settings[`capture_${level}`]) pushEntry(level, args);
            };
        };
        if (settings.enabled) {
            console.log   = wrap('log',   _originals.log);
            console.warn  = wrap('warn',  _originals.warn);
            console.error = wrap('error', _originals.error);
            console.info  = wrap('info',  _originals.info);
            console.debug = wrap('debug', _originals.debug);
        }
    }

    function uninstallHooks() {
        console.log   = _originals.log;
        console.warn  = _originals.warn;
        console.error = _originals.error;
        console.info  = _originals.info;
        console.debug = _originals.debug;
    }

    function installGlobalCatchers() {
        window.addEventListener('error', (ev) => {
            const msg = ev.message || 'Unknown error';
            const src = ev.filename ? `\n    at ${ev.filename}:${ev.lineno}:${ev.colno}` : '';
            pushEntry('error', [`[Uncaught] ${msg}${src}`]);
        });
        window.addEventListener('unhandledrejection', (ev) => {
            const reason = ev.reason instanceof Error
                ? `${ev.reason.message}\n${ev.reason.stack || ''}`
                : stringify(ev.reason);
            pushEntry('error', [`[Unhandled Promise] ${reason}`]);
        });
    }

    // =========================================================================
    //  DOM
    // =========================================================================
    function buildEntryHtml(entry) {
        const settings = getSettings();
        const timeStr = settings.show_timestamps
            ? `<span class="dt-time">${entry.time}</span> `
            : '';
        const levelTag = `<span class="dt-badge dt-badge-${entry.level}">${entry.level.toUpperCase()}</span> `;
        return `<div class="dt-entry dt-entry-${entry.level}" data-id="${entry.id}">${timeStr}${levelTag}<span class="dt-msg">${escapeHtml(entry.args)}</span></div>`;
    }

    function renderAllEntries() {
        const $list = $('#dt-log-list');
        if (!$list.length) return;
        const filtered = logBuffer.filter(e => {
            if (activeFilter !== 'all' && e.level !== activeFilter) return false;
            if (searchQuery && !e.args.toLowerCase().includes(searchQuery)) return false;
            return true;
        });
        $list.html(filtered.map(buildEntryHtml).join(''));
        $list[0].scrollTop = $list[0].scrollHeight;
    }

    function updateCounters() {
        const $c = $('#dt-counter');
        if (!$c.length) return;
        let txt = `${logBuffer.length}`;
        if (errCount) txt += ` · <span style="color:#ff6b6b">${errCount} err</span>`;
        if (warnCount) txt += ` · <span style="color:#ffa726">${warnCount} warn</span>`;
        $c.html(txt);
    }

    // =========================================================================
    //  ACTIONS
    // =========================================================================
    function clearLogs() {
        logBuffer = [];
        pendingEntries = [];
        idCounter = 0;
        errCount = 0;
        warnCount = 0;
        $('#dt-log-list').empty();
        updateCounters();
    }

    function exportLogs() {
        const text = logBuffer.map(e => `[${e.time}] [${e.level.toUpperCase()}] ${e.args}`).join('\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `st-devtools-${Date.now()}.log`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    }

    function copyLogs() {
        const filtered = logBuffer.filter(e => {
            if (activeFilter !== 'all' && e.level !== activeFilter) return false;
            if (searchQuery && !e.args.toLowerCase().includes(searchQuery)) return false;
            return true;
        });
        const text = filtered.map(e => `[${e.time}] [${e.level.toUpperCase()}] ${e.args}`).join('\n');
        navigator.clipboard.writeText(text).then(
            () => toastr.success(`Скопировано ${filtered.length} записей`),
            () => toastr.error('Не удалось скопировать')
        );
    }

    // =========================================================================
    //  UI — всё в настройках, как у помидора
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
                    <input id="dt-max-entries" type="number" class="text_pole" value="${settings.max_entries}" min="50" max="5000" step="50" />

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
            settings.max_entries = Math.max(50, Math.min(5000, parseInt($(this).val(), 10) || 500));
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

        // Search
        let searchTimeout;
        $('#dt-search').on('input', function () {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                searchQuery = $(this).val().toLowerCase().trim();
                renderAllEntries();
            }, 200);
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
                _originals.log('[DevTools] Extension loaded.');
            } catch (err) {
                _originals.error('[DevTools] Init failed:', err);
                toastr.error(`DevTools: ${err.message}`, 'Ошибка', { timeOut: 8000 });
            }
        });
    });

})();
