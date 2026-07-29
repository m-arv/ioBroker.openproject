'use strict';

const axios = require('axios');
const https = require('node:https');

/**
 * Error thrown by OpenProjectClient. `code` is one of the keys used in the
 * "error" map of admin/jsonConfig.json's testConnection button, so the UI
 * can show a translated, specific message instead of a raw error string.
 */
class OpenProjectError extends Error {
    /**
     * @param {string} code - one of: no_url, no_token, auth_failed, not_found, timeout, network
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'OpenProjectError';
        this.code = code;
    }
}

/**
 * Thin wrapper around the OpenProject REST API v3, using only the filters
 * verified with tools/check-api.js against a real instance.
 */
class OpenProjectClient {
    /**
     * @param {object} options
     * @param {string} options.url - base URL, e.g. http://openproject.intern
     * @param {string} options.apiToken
     * @param {boolean} [options.ignoreCertificateErrors]
     * @param {number} [options.requestTimeout] - seconds
     * @param {AbortSignal} [options.signal] - aborts in-flight requests, e.g. on adapter unload
     */
    constructor({ url, apiToken, ignoreCertificateErrors, requestTimeout, signal }) {
        if (!url) {
            throw new OpenProjectError('no_url', 'No URL configured');
        }
        if (!apiToken) {
            throw new OpenProjectError('no_token', 'No API token configured');
        }

        this.baseUrl = url.replace(/\/+$/, '');
        this.signal = signal;
        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: Math.max(1, Number(requestTimeout) || 15) * 1000,
            auth: { username: 'apikey', password: apiToken },
            headers: { Accept: 'application/json' },
            // Only affects requests made through this instance, not the whole process.
            httpsAgent: new https.Agent({ rejectUnauthorized: !ignoreCertificateErrors }),
        });
    }

    /**
     * @param {string} path @param {Record<string, string>} [params]
     * @param params
     */
    async get(path, params) {
        try {
            const res = await this.http.get(path, { params, signal: this.signal });
            return res.data;
        } catch (err) {
            throw this._toOpenProjectError(err);
        }
    }

    /** @param {import('axios').AxiosError} err */
    _toOpenProjectError(err) {
        if (err instanceof OpenProjectError) {
            return err;
        }
        if (err.code === 'ECONNABORTED') {
            return new OpenProjectError('timeout', `Request timed out: ${err.message}`);
        }
        if (err.response) {
            const status = err.response.status;
            if (status === 401 || status === 403) {
                return new OpenProjectError('auth_failed', `Authentication failed (HTTP ${status})`);
            }
            if (status === 404) {
                return new OpenProjectError('not_found', `Not found (HTTP ${status}): ${err.config?.url}`);
            }
            const responseData = err.response.data;
            const opMessage =
                responseData && typeof responseData === 'object' && 'message' in responseData
                    ? String(responseData.message)
                    : undefined;
            return new OpenProjectError('network', `HTTP ${status}${opMessage ? `: ${opMessage}` : ''}`);
        }
        return new OpenProjectError('network', err.message);
    }

    /** Verifies reachability and authentication. Returns the display name of the authenticated user. */
    async testConnection() {
        const me = await this.get('/api/v3/users/me');
        return me && me.name ? me.name : 'OK';
    }

    /** @returns {Promise<{value: string, label: string}[]>} */
    async getProjects() {
        const data = await this.get('/api/v3/projects', { pageSize: '500' });
        const elements = (data && data._embedded && data._embedded.elements) || [];
        return elements.map(p => ({ value: String(p.id), label: p.name }));
    }

    /**
     * Fetches open work packages, optionally restricted to the current user and/or a set of
     * projects. Filters mirror the ones verified via tools/check-api.js (status "o" = open,
     * assignee "=" with "me", project "="). Due-date classification happens in the caller.
     *
     * @param {object} opts
     * @param {boolean} opts.onlyAssignedToMe
     * @param {string[]} opts.projectIds
     * @param {number} opts.maxResults
     */
    async getOpenWorkPackages({ onlyAssignedToMe, projectIds, maxResults }) {
        const filters = [
            { status: { operator: 'o', values: [] } },
            ...(onlyAssignedToMe ? [{ assignee: { operator: '=', values: ['me'] } }] : []),
            ...(projectIds && projectIds.length ? [{ project: { operator: '=', values: projectIds } }] : []),
        ];

        const data = await this.get('/api/v3/work_packages', {
            filters: JSON.stringify(filters),
            sortBy: JSON.stringify([['dueDate', 'asc']]),
            pageSize: String(Math.max(1, Number(maxResults) || 100)),
        });

        const elements = (data && data._embedded && data._embedded.elements) || [];
        return elements.map(wp => ({
            id: wp.id,
            subject: wp.subject,
            // Empty string, not null: some consumers (e.g. VIS-2's JSON-table widgets) render a
            // JSON `null` as the literal text "null", but treat an empty string as blank/unset
            // and correctly apply their own "empty" placeholder - verified live against a real
            // vis-2 instance.
            dueDate: wp.dueDate || '',
            status: (wp._links && wp._links.status && wp._links.status.title) || '',
            project: (wp._links && wp._links.project && wp._links.project.title) || '',
            url: `${this.baseUrl}/work_packages/${wp.id}`,
        }));
    }
}

module.exports = { OpenProjectClient, OpenProjectError };
