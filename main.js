'use strict';

const utils = require('@iobroker/adapter-core');
const { OpenProjectClient } = require('./lib/openproject-client');
const { buildNotifyPayload } = require('./lib/notify-payload');

// How long the adapter stays alive after finishing its scheduled work, purely so that
// admin's "Verbindung testen" button and the dynamic project list (both implemented via
// sendTo, see admin/jsonConfig.json) have a real window to work in. ioBroker's sendTo UI
// controls are hard-disabled whenever the target instance is not running (verified against
// the ConfigSendto/ConfigSelectSendTo source in the ioBroker/json-config repository), and a
// "schedule" mode adapter is normally not running between scheduled executions.
const GRACE_PERIOD_MS = 3 * 60 * 1000;

/** Maps OpenProjectError codes to the i18n keys in admin/i18n/*.json used for the testConnection reply. */
const ERROR_CODE_TO_I18N_KEY = {
    no_url: 'testConnectionErrorNoUrl',
    no_token: 'testConnectionErrorNoToken',
    auth_failed: 'testConnectionErrorAuth',
    not_found: 'testConnectionErrorNotFound',
    timeout: 'testConnectionErrorTimeout',
    network: 'testConnectionErrorNetwork',
};

/**
 * Full expected object tree under <namespace>.*, keyed by the id relative to the instance.
 *
 * @returns {Record<string, ioBroker.SettableObject>}
 */
function buildObjectDefinitions() {
    return {
        info: {
            type: 'channel',
            common: { name: 'Information' },
            native: {},
        },
        'info.connection': {
            type: 'state',
            common: {
                name: 'Connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        },
        'info.lastRun': {
            type: 'state',
            common: {
                name: 'Last run',
                type: 'string',
                role: 'value.datetime',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        },
        'info.lastError': {
            type: 'state',
            common: {
                name: 'Last error',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        },
        overdue: {
            type: 'channel',
            common: { name: 'Overdue work packages' },
            native: {},
        },
        'overdue.count': {
            type: 'state',
            common: {
                name: 'Number of overdue work packages',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        },
        'overdue.list': {
            type: 'state',
            common: {
                name: 'Overdue work packages',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
            },
            native: {},
        },
        upcoming: {
            type: 'channel',
            common: { name: 'Upcoming work packages' },
            native: {},
        },
        'upcoming.count': {
            type: 'state',
            common: {
                name: 'Number of upcoming work packages',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        },
        'upcoming.list': {
            type: 'state',
            common: {
                name: 'Upcoming work packages',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
            },
            native: {},
        },
        all: {
            type: 'channel',
            common: { name: 'All work packages, regardless of due date' },
            native: {},
        },
        'all.count': {
            type: 'state',
            common: {
                name: 'Number of work packages (all, regardless of due date)',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        },
        'all.list': {
            type: 'state',
            common: {
                name: 'Work packages (all, regardless of due date)',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
            },
            native: {},
        },
        state: {
            type: 'channel',
            common: { name: 'Internal state', expert: true },
            native: {},
        },
        'state.notifiedIds': {
            type: 'state',
            common: {
                name: 'Already notified work packages (internal)',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '{}',
                expert: true,
            },
            native: {},
        },
    };
}

const OBJECT_DEFINITIONS = buildObjectDefinitions();

/**
 * Creates or updates every object in OBJECT_DEFINITIONS, then removes any state/channel/folder
 * under the instance namespace that is no longer part of that set (e.g. left over from an
 * older adapter version).
 *
 * @param {ioBroker.Adapter} adapter
 */
async function ensureObjects(adapter) {
    for (const [id, definition] of Object.entries(OBJECT_DEFINITIONS)) {
        await adapter.extendObjectAsync(id, definition);
    }

    const expectedFullIds = new Set(Object.keys(OBJECT_DEFINITIONS).map(id => `${adapter.namespace}.${id}`));
    const existingObjects = await adapter.getAdapterObjectsAsync();
    for (const [fullId, obj] of Object.entries(existingObjects)) {
        const isManagedType = obj && (obj.type === 'state' || obj.type === 'channel' || obj.type === 'folder');
        if (isManagedType && !expectedFullIds.has(fullId)) {
            adapter.log.info(`Entferne verwaistes Objekt ${fullId}`);
            await adapter.delObjectAsync(fullId);
        }
    }
}

/** @param {Date} [date] @returns {string} local date as YYYY-MM-DD */
function dateToLocalDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * @param {string} dateStr - YYYY-MM-DD @param {number} days @returns {string} YYYY-MM-DD
 * @param days
 */
function addDaysToDateString(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return dateToLocalDateString(date);
}

/**
 * Splits open work packages into "overdue" (due date before today) and "upcoming" (due date
 * within warnDays from today, today included). Work packages without a due date end up in
 * neither - they can't be "overdue" or "soon due" - but are still returned as "all", together
 * with every other work package, for adapter users who track work packages as a plain to-do
 * list and add due dates only later. This runs entirely client-side against the adapter host's
 * local date (see tools/check-api.js output for why OpenProject's own relative dueDate
 * operators are not used for this).
 *
 * @param {{id: number, subject: string, dueDate: string|null, status: string, project: string, url: string}[]} workPackages
 * @param {number} warnDays
 */
function classifyByDueDate(workPackages, warnDays) {
    const today = dateToLocalDateString();
    const warnUntil = addDaysToDateString(today, Math.max(0, Number(warnDays) || 0));

    const overdue = [];
    const upcoming = [];
    for (const wp of workPackages) {
        if (!wp.dueDate) {
            continue;
        }
        if (wp.dueDate < today) {
            overdue.push(wp);
        } else if (wp.dueDate <= warnUntil) {
            upcoming.push(wp);
        }
    }

    const byDueDateAsc = (a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0);
    overdue.sort(byDueDateAsc);
    upcoming.sort(byDueDateAsc);

    // "all": every fetched work package, due-dated ones first (soonest due first), work
    // packages without a due date last.
    const all = [...workPackages].sort((a, b) => {
        if (!a.dueDate && !b.dueDate) {
            return 0;
        }
        if (!a.dueDate) {
            return 1;
        }
        if (!b.dueDate) {
            return -1;
        }
        return byDueDateAsc(a, b);
    });

    return { overdue, upcoming, all };
}

/** @returns {Record<string, {notifiedAt: string, status: string, dueDate: string|null}>} */
function emptyNotifiedState() {
    return {};
}

/**
 * Decides whether a work package should be (re-)reported:
 * - never reported before -> yes
 * - status or dueDate changed since it was last reported -> yes, regardless of the repeat lock
 * - otherwise -> only if onlyOnChange is disabled AND the repeat lock has expired
 *
 * @param {{status: string, dueDate: string|null}} wp
 * @param {{notifiedAt: string, status: string, dueDate: string|null}|undefined} record
 * @param {boolean} onlyOnChange
 * @param {number} repeatIntervalDays
 * @param {number} nowMs
 */
function shouldNotify(wp, record, onlyOnChange, repeatIntervalDays, nowMs) {
    if (!record) {
        return true;
    }
    const changed = record.status !== wp.status || record.dueDate !== wp.dueDate;
    if (changed) {
        return true;
    }
    if (onlyOnChange) {
        return false;
    }
    const elapsedMs = nowMs - Date.parse(record.notifiedAt);
    return elapsedMs >= repeatIntervalDays * 24 * 60 * 60 * 1000;
}

/**
 * @param {{id: number, subject: string, dueDate: string|null, project: string, url: string}[]} overdue
 * @param {{id: number, subject: string, dueDate: string|null, project: string, url: string}[]} upcoming
 */
function buildNotificationText(overdue, upcoming) {
    const lines = [];
    if (overdue.length) {
        lines.push(`Überfällige Arbeitspakete (${overdue.length}):`);
        for (const wp of overdue) {
            lines.push(`- #${wp.id} ${wp.subject} — fällig ${wp.dueDate} (${wp.project})`);
            lines.push(`  ${wp.url}`);
        }
    }
    if (upcoming.length) {
        if (lines.length) {
            lines.push('');
        }
        lines.push(`Bald fällig (${upcoming.length}):`);
        for (const wp of upcoming) {
            lines.push(`- #${wp.id} ${wp.subject} — fällig ${wp.dueDate} (${wp.project})`);
            lines.push(`  ${wp.url}`);
        }
    }
    return lines.join('\n');
}

class Openproject extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'openproject',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this._graceTimer = null;
        this._abortController = new AbortController();
    }

    /** Builds a client for the currently saved/active adapter configuration. */
    _buildConfiguredClient() {
        return new OpenProjectClient({
            url: this.config.url,
            apiToken: this.config.apiToken,
            ignoreCertificateErrors: this.config.ignoreCertificateErrors,
            requestTimeout: this.config.requestTimeout,
            signal: this._abortController.signal,
        });
    }

    /**
     * Sends a notification for the work packages that require one (new, changed, or the repeat
     * lock expired) and updates state.notifiedIds accordingly. Only updates the notified record
     * for a work package after sendTo did not throw, so a delivery failure is retried next run
     * instead of being silently dropped.
     *
     * @param {{id: number, subject: string, dueDate: string|null, status: string, project: string, url: string}[]} overdue
     * @param {{id: number, subject: string, dueDate: string|null, status: string, project: string, url: string}[]} upcoming
     */
    async _notify(overdue, upcoming) {
        if (!this.config.notifyInstance) {
            this.log.warn('Benachrichtigungen sind aktiviert, aber es ist keine Ziel-Adapterinstanz ausgewählt.');
            return;
        }

        const notifiedState = await this._readNotifiedState();
        const nowMs = Date.now();
        const toNotifyOverdue = overdue.filter(wp =>
            shouldNotify(wp, notifiedState[wp.id], this.config.onlyOnChange, this.config.repeatIntervalDays, nowMs),
        );
        const toNotifyUpcoming = upcoming.filter(wp =>
            shouldNotify(wp, notifiedState[wp.id], this.config.onlyOnChange, this.config.repeatIntervalDays, nowMs),
        );

        // Prune ids that are neither overdue nor upcoming anymore (done, moved out, deleted, ...)
        // regardless of whether we send a message this run.
        const currentIds = new Set([...overdue, ...upcoming].map(wp => String(wp.id)));
        const prunedState = emptyNotifiedState();
        for (const [id, record] of Object.entries(notifiedState)) {
            if (currentIds.has(id)) {
                prunedState[id] = record;
            }
        }

        if (!toNotifyOverdue.length && !toNotifyUpcoming.length) {
            await this._writeNotifiedState(prunedState);
            return;
        }

        const text = buildNotificationText(toNotifyOverdue, toNotifyUpcoming);
        const adapterName = this.config.notifyInstance.split('.')[0];
        const payload = buildNotifyPayload(adapterName, text, this.config.notifyRecipient);

        try {
            await this.sendToAsync(this.config.notifyInstance, 'send', payload);
        } catch (err) {
            this.log.warn(`Benachrichtigung an ${this.config.notifyInstance} fehlgeschlagen: ${err.message}`);
            // Do not mark as notified - retry on the next run.
            await this._writeNotifiedState(prunedState);
            return;
        }

        const nowIso = new Date().toISOString();
        for (const wp of [...toNotifyOverdue, ...toNotifyUpcoming]) {
            prunedState[String(wp.id)] = { notifiedAt: nowIso, status: wp.status, dueDate: wp.dueDate };
        }
        await this._writeNotifiedState(prunedState);
    }

    /** @returns {Promise<Record<string, {notifiedAt: string, status: string, dueDate: string|null}>>} */
    async _readNotifiedState() {
        const stateObj = await this.getStateAsync('state.notifiedIds');
        if (!stateObj || !stateObj.val) {
            return emptyNotifiedState();
        }
        try {
            return JSON.parse(String(stateObj.val));
        } catch (err) {
            this.log.warn(`state.notifiedIds enthielt kein gültiges JSON, setze zurück: ${err.message}`);
            return emptyNotifiedState();
        }
    }

    /** @param {Record<string, {notifiedAt: string, status: string, dueDate: string|null}>} state */
    async _writeNotifiedState(state) {
        await this.setStateAsync('state.notifiedIds', JSON.stringify(state), true);
    }

    /** Runs one full poll-classify-notify cycle. Never throws. */
    async _run() {
        try {
            const client = this._buildConfiguredClient();
            const workPackages = await client.getOpenWorkPackages({
                onlyAssignedToMe: this.config.onlyAssignedToMe,
                projectIds: this.config.projects || [],
                maxResults: this.config.maxResults,
            });

            const { overdue, upcoming, all } = classifyByDueDate(workPackages, this.config.warnDays);

            await this.setStateAsync('overdue.count', overdue.length, true);
            await this.setStateAsync('overdue.list', JSON.stringify(overdue), true);
            await this.setStateAsync('upcoming.count', upcoming.length, true);
            await this.setStateAsync('upcoming.list', JSON.stringify(upcoming), true);
            await this.setStateAsync('all.count', all.length, true);
            await this.setStateAsync('all.list', JSON.stringify(all), true);

            if (this.config.notifyEnabled) {
                await this._notify(overdue, upcoming);
            }

            await this.setStateAsync('info.connection', true, true);
            await this.setStateAsync('info.lastError', '', true);
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            this.log.error(`Durchlauf fehlgeschlagen: ${message}`);
            await this.setStateAsync('info.connection', false, true);
            await this.setStateAsync('info.lastError', message, true);
        } finally {
            await this.setStateAsync('info.lastRun', new Date().toISOString(), true);
        }
    }

    /** Is called when databases are connected and adapter received configuration. */
    async onReady() {
        // Reuses admin/i18n/*.json (same files the config UI loads) so onMessage replies for
        // testConnection are translated into the ioBroker system language.
        await utils.I18n.init(`${__dirname}/admin`, this);

        await ensureObjects(this);
        await this.setStateAsync('info.connection', false, true);

        await this._run();

        // Keep the process (and its message handler) alive for a grace period so admin's
        // sendTo-based controls remain usable right after this run. See GRACE_PERIOD_MS above.
        this._graceTimer = setTimeout(() => {
            this._graceTimer = null;
            this.terminate ? this.terminate('Nachlaufzeit beendet') : process.exit(0);
        }, GRACE_PERIOD_MS);
    }

    /**
     * Handles admin config messages: "testConnection" tests the (possibly unsaved) values
     * currently shown in the form, "getProjects" feeds the dynamic project multiselect using
     * the actually saved/active configuration. See admin/jsonConfig.json.
     *
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (!obj || typeof obj !== 'object' || !obj.command) {
            return;
        }

        if (obj.command === 'testConnection') {
            (async () => {
                try {
                    const msg = obj.message || {};
                    const client = new OpenProjectClient({
                        url: msg.url,
                        apiToken: msg.apiToken,
                        ignoreCertificateErrors: msg.ignoreCertificateErrors,
                        requestTimeout: msg.requestTimeout,
                    });
                    const userName = await client.testConnection();
                    const text = utils.I18n.translate('testConnectionSuccess', userName);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { result: text }, obj.callback);
                    }
                } catch (err) {
                    const i18nKey = ERROR_CODE_TO_I18N_KEY[err && err.code] || 'testConnectionErrorNetwork';
                    const text = utils.I18n.translate(i18nKey, err.message);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { error: text }, obj.callback);
                    }
                }
            })().catch(err => this.log.error(`testConnection handler failed: ${err.message}`));
            return;
        }

        if (obj.command === 'getProjects') {
            (async () => {
                let projects = [];
                try {
                    const client = this._buildConfiguredClient();
                    projects = await client.getProjects();
                } catch (err) {
                    this.log.warn(`getProjects fehlgeschlagen: ${err.message}`);
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, projects, obj.callback);
                }
            })().catch(err => this.log.error(`getProjects handler failed: ${err.message}`));
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * Clears the grace-period timer and aborts any in-flight HTTP request so nothing keeps the
     * process alive or logs after unload.
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            if (this._graceTimer) {
                clearTimeout(this._graceTimer);
                this._graceTimer = null;
            }
            this._abortController.abort();
            callback();
        } catch (err) {
            this.log.error(`Error during unloading: ${err.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Openproject(options);
} else {
    // otherwise start the instance directly
    new Openproject();
}
