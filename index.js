// @ts-check
(function () {
    const MODULE_NAME = 'st_devtools';

    // =========================================================================
    //  CONFIGURATION
    // =========================================================================
    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        max_entries: 500,
        capture_log: true,
        capture_warn: true,
        capture_error: true,
        capture_info: true,
        capture_debug: false,
        show_timestamps: true,
        auto_scroll: true,
        word_wrap: true,
        panel_open: false,
    });

    // =========================================================================
    //  STATE
    // =========================================================================
    /** @type {Array<{id: number, level: string, time: string, args: string}>} */
    let logBuffer = [];
    let idCounter = 0;
    let isPanelVisible = false;
    let activeFilter = 'all';
    let searchQuery = '';

    // Original console references — saved ONCE, never overwritten
    const _originals = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
    };

    // =========================================================================
    //  HELPERS
    // =========================================================================
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

    /** Turn any value into a readable string */
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

    /** Escape HTML to prevent XSS in the log viewer */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // =========================================================================
    //  CORE: INTERCEPT
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

        // Trim oldest entries when over limit
        while (logBuffer.length > settings.max_entries) {
            logBuffer.shift();
        }

        // Live-update the DOM if panel is visible
        if (isPanelVisible) {
            appendEntryToDOM(entry);
        }

        updateBadge();
    }

    function installHooks() {
        const settings = getSettings();

        const wrap = (level, original) => {
            return function (...args) {
                // Always call the real console method first
                original(...args);
                // Then capture
                const key = `capture_${level}`;
                if (settings[key]) {
                    pushEntry(level, args);
                }
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

    // =========================================================================
    //  GLOBAL ERROR CATCHER (uncaught errors + promise rejections)
    // =========================================================================
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
    //  DOM RENDERING
    // =========================================================================
    function buildEntryHtml(entry) {
        const settings = getSettings();
        const timeStr = settings.show_timestamps
            ? `<span class="dt-time">${entry.time}</span>`
            : '';
        const levelBadge = `<span class="dt-level dt-${entry.level}">${entry.level.toUpperCase()}</span>`;
        const content = `<span class="dt-msg">${escapeHtml(entry.args)}</span>`;
        return `<div class="dt-entry dt-entry-${entry.level}" data-id="${entry.id}">${timeStr}${levelBadge}${content}</div>`;
    }

    function appendEntryToDOM(entry) {
        const $container = $('#dt-log-list');
        if (!$container.length) return;

        // Check filters
        if (activeFilter !== 'all' && entry.level !== activeFilter) return;
        if (searchQuery && !entry.args.toLowerCase().includes(searchQuery)) return;

        $container.append(buildEntryHtml(entry));

        if (getSettings().auto_scroll) {
            const el = $container[0];
            el.scrollTop = el.scrollHeight;
        }
    }

    function renderAllEntries() {
        const $container = $('#dt-log-list');
        if (!$container.length) return;

        const filtered = logBuffer.filter((e) => {
            if (activeFilter !== 'all' && e.level !== activeFilter) return false;
            if (searchQuery && !e.args.toLowerCase().includes(searchQuery)) return false;
            return true;
        });

        $container.html(filtered.map(buildEntryHtml).join(''));

        if (getSettings().auto_scroll) {
            const el = $container[0];
            el.scrollTop = el.scrollHeight;
        }
    }

    function updateBadge() {
        const errCount = logBuffer.filter(e => e.level === 'error').length;
        const warnCount = logBuffer.filter(e => e.level === 'warn').length;
        const $badge = $('#dt-fab-badge');
        if (!$badge.length) return;

        if (errCount > 0) {
            $badge.text(errCount).css('background', '#e03131').show();
        } else if (warnCount > 0) {
            $badge.text(warnCount).css('background', '#e8590c').show();
        } else {
            $badge.hide();
        }
    }

    // =========================================================================
    //  PANEL TOGGLE
    // =========================================================================
    function showPanel() {
        isPanelVisible = true;
        $('#dt-console-panel').addClass('dt-visible');
        renderAllEntries();
        updateBadge();
    }

    function hidePanel() {
        isPanelVisible = false;
        $('#dt-console-panel').removeClass('dt-visible');
    }

    function togglePanel() {
        isPanelVisible ? hidePanel() : showPanel();
    }

    // =========================================================================
    //  ACTIONS
    // =========================================================================
    function clearLogs() {
        logBuffer = [];
        idCounter = 0;
        $('#dt-log-list').empty();
        updateBadge();
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
        const filtered = logBuffer.filter((e) => {
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
    //  UI: SETTINGS PANEL (inside Extensions drawer)
    // =========================================================================
    function initSettingsUI() {
        const settings = getSettings();

        const html = `
        <div id="${MODULE_NAME}-settings" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>DevTools</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display: flex; flex-direction: column; gap: 8px;">
                    <span class="dt-hint">Перехватывает console.log / warn / error и показывает прямо в ST.</span>

                    <label class="checkbox_label">
                        <input id="dt-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                        Перехват включён
                    </label>

                    <div class="dt-settings-row">
                        <label class="checkbox_label"><input id="dt-cap-log"   type="checkbox" ${settings.capture_log   ? 'checked' : ''}> log</label>
                        <label class="checkbox_label"><input id="dt-cap-warn"  type="checkbox" ${settings.capture_warn  ? 'checked' : ''}> warn</label>
                        <label class="checkbox_label"><input id="dt-cap-error" type="checkbox" ${settings.capture_error ? 'checked' : ''}> error</label>
                        <label class="checkbox_label"><input id="dt-cap-info"  type="checkbox" ${settings.capture_info  ? 'checked' : ''}> info</label>
                        <label class="checkbox_label"><input id="dt-cap-debug" type="checkbox" ${settings.capture_debug ? 'checked' : ''}> debug</label>
                    </div>

                    <label>Лимит записей:</label>
                    <input id="dt-max-entries" type="number" class="text_pole" value="${settings.max_entries}" min="50" max="5000" step="50" />

                    <label class="checkbox_label">
                        <input id="dt-timestamps" type="checkbox" ${settings.show_timestamps ? 'checked' : ''}>
                        Показывать время
                    </label>
                    <label class="checkbox_label">
                        <input id="dt-autoscroll" type="checkbox" ${settings.auto_scroll ? 'checked' : ''}>
                        Автопрокрутка
                    </label>
                    <label class="checkbox_label">
                        <input id="dt-wordwrap" type="checkbox" ${settings.word_wrap ? 'checked' : ''}>
                        Перенос строк
                    </label>

                    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;">
                        <div id="dt-btn-open" class="menu_button"><i class="fa-solid fa-terminal"></i> Открыть консоль</div>
                        <div id="dt-btn-clear-all" class="menu_button"><i class="fa-solid fa-trash"></i> Очистить всё</div>
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

        $('#dt-max-entries').on('change', function () {
            settings.max_entries = Math.max(50, Math.min(5000, parseInt($(this).val(), 10) || 500));
            $(this).val(settings.max_entries);
            saveSettings();
        });

        $('#dt-timestamps').on('change', function () { settings.show_timestamps = $(this).is(':checked'); saveSettings(); renderAllEntries(); });
        $('#dt-autoscroll').on('change', function () { settings.auto_scroll = $(this).is(':checked'); saveSettings(); });
        $('#dt-wordwrap').on('change', function () {
            settings.word_wrap = $(this).is(':checked');
            saveSettings();
            $('#dt-log-list').toggleClass('dt-nowrap', !settings.word_wrap);
        });

        $('#dt-btn-open').on('click', togglePanel);
        $('#dt-btn-clear-all').on('click', clearLogs);
    }

    // =========================================================================
    //  UI: FLOATING CONSOLE PANEL
    // =========================================================================
    function initConsolePanel() {
        const settings = getSettings();

        const panel = `
        <div id="dt-console-panel">
            <div id="dt-panel-header">
                <div id="dt-panel-title"><i class="fa-solid fa-terminal"></i> DevTools</div>
                <div id="dt-panel-toolbar">
                    <div id="dt-filter-bar">
                        <button class="dt-filter-btn dt-active" data-level="all">All</button>
                        <button class="dt-filter-btn" data-level="error">Errors</button>
                        <button class="dt-filter-btn" data-level="warn">Warn</button>
                        <button class="dt-filter-btn" data-level="log">Log</button>
                        <button class="dt-filter-btn" data-level="info">Info</button>
                        <button class="dt-filter-btn" data-level="debug">Debug</button>
                    </div>
                    <div id="dt-action-bar">
                        <input id="dt-search" type="text" placeholder="Фильтр..." />
                        <button id="dt-btn-copy" class="dt-icon-btn" title="Копировать"><i class="fa-solid fa-copy"></i></button>
                        <button id="dt-btn-export" class="dt-icon-btn" title="Скачать"><i class="fa-solid fa-download"></i></button>
                        <button id="dt-btn-clear" class="dt-icon-btn" title="Очистить"><i class="fa-solid fa-trash-can"></i></button>
                        <button id="dt-btn-close" class="dt-icon-btn" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
            </div>
            <div id="dt-log-list" class="${settings.word_wrap ? '' : 'dt-nowrap'}"></div>
            <div id="dt-status-bar">
                <span id="dt-status-count">0 записей</span>
            </div>
        </div>

        <div id="dt-fab" title="DevTools">
            <i class="fa-solid fa-bug"></i>
            <span id="dt-fab-badge" style="display:none;">0</span>
        </div>`;

        $('body').append(panel);

        // --- Panel interactions ---
        $('#dt-fab').on('click', togglePanel);
        $('#dt-btn-close').on('click', hidePanel);
        $('#dt-btn-clear').on('click', clearLogs);
        $('#dt-btn-export').on('click', exportLogs);
        $('#dt-btn-copy').on('click', copyLogs);

        // Filter tabs
        $('#dt-filter-bar').on('click', '.dt-filter-btn', function () {
            $('.dt-filter-btn').removeClass('dt-active');
            $(this).addClass('dt-active');
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

        // Draggable header for panel repositioning
        makeDraggable($('#dt-console-panel')[0], $('#dt-panel-header')[0]);

        // Resize handle
        makeResizable($('#dt-console-panel')[0]);
    }

    // =========================================================================
    //  DRAG & RESIZE (touch-friendly)
    // =========================================================================
    function makeDraggable(panel, handle) {
        let startX, startY, startLeft, startTop;

        function onStart(e) {
            // Don't drag when interacting with buttons/inputs inside the header
            if ($(e.target).closest('button, input, .dt-filter-btn, .dt-icon-btn').length) return;
            e.preventDefault();

            const touch = e.touches ? e.touches[0] : e;
            const rect = panel.getBoundingClientRect();
            startX = touch.clientX;
            startY = touch.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            panel.classList.add('dt-dragging');
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }

        function onMove(e) {
            e.preventDefault();
            const touch = e.touches ? e.touches[0] : e;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            panel.style.left = `${startLeft + dx}px`;
            panel.style.top = `${startTop + dy}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        function onEnd() {
            panel.classList.remove('dt-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        }

        handle.addEventListener('mousedown', onStart);
        handle.addEventListener('touchstart', onStart, { passive: false });
    }

    function makeResizable(panel) {
        const resizer = document.createElement('div');
        resizer.id = 'dt-resize-handle';
        panel.appendChild(resizer);

        let startX, startY, startW, startH;

        function onStart(e) {
            e.preventDefault();
            e.stopPropagation();
            const touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX;
            startY = touch.clientY;
            startW = panel.offsetWidth;
            startH = panel.offsetHeight;

            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }

        function onMove(e) {
            e.preventDefault();
            const touch = e.touches ? e.touches[0] : e;
            const newW = Math.max(280, startW + (touch.clientX - startX));
            const newH = Math.max(200, startH + (touch.clientY - startY));
            panel.style.width = `${newW}px`;
            panel.style.height = `${newH}px`;
        }

        function onEnd() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
        }

        resizer.addEventListener('mousedown', onStart);
        resizer.addEventListener('touchstart', onStart, { passive: false });
    }

    // =========================================================================
    //  STATUS BAR UPDATER
    // =========================================================================
    setInterval(() => {
        const $count = $('#dt-status-count');
        if (!$count.length) return;

        const total = logBuffer.length;
        const errors = logBuffer.filter(e => e.level === 'error').length;
        const warns  = logBuffer.filter(e => e.level === 'warn').length;

        let parts = [`${total} записей`];
        if (errors > 0) parts.push(`${errors} ошибок`);
        if (warns > 0) parts.push(`${warns} предупреждений`);
        $count.text(parts.join(' · '));
    }, 1000);

    // =========================================================================
    //  INIT
    // =========================================================================
    $(document).ready(function () {
        const context = SillyTavern.getContext();

        // Install hooks ASAP — before APP_READY — to capture early logs
        installHooks();
        installGlobalCatchers();

        context.eventSource.on(context.event_types.APP_READY, function () {
            try {
                initSettingsUI();
                initConsolePanel();
                _originals.log('[DevTools] Extension loaded. Capturing console output.');
            } catch (err) {
                _originals.error('[DevTools] Failed to init UI:', err);
                toastr.error(`DevTools init error: ${err.message}`, 'DevTools', { timeOut: 8000 });
            }
        });
    });

})();
