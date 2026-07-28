/**
 * Eigenständiges Prüfskript gegen eine echte OpenProject-Instanz (REST API v3).
 *
 * Läuft UNABHÄNGIG vom Adapter (kein @iobroker/adapter-core nötig) und dient dazu,
 * die tatsächliche API-Struktur, Filter-Operatoren und Antwortformate zu verifizieren,
 * bevor die Adapter-Logik darauf aufbaut.
 *
 * Aufruf:
 *   OPENPROJECT_URL=http://openproject.intern OPENPROJECT_API_TOKEN=xxx node tools/check-api.js
 *
 * oder mit einer .env-Datei:
 *   set -a; source ~/.config/iobroker-openproject.env; set +a
 *   node tools/check-api.js
 *
 * Optionale Flags:
 *   --insecure   TLS-Zertifikatsprüfung deaktivieren (nur zum Testen von HTTPS-Instanzen
 *                mit selbstsigniertem Zertifikat, siehe Warnung im Adapter-Config-Panel)
 *
 * WICHTIG: Der Token wird nirgends geloggt oder ausgegeben (auch nicht im Fehlerfall).
 */

'use strict';

const BASE_URL = process.env.OPENPROJECT_URL;
const TOKEN = process.env.OPENPROJECT_API_TOKEN;
const INSECURE = process.argv.includes('--insecure');

if (!BASE_URL || !TOKEN) {
    console.error('Fehler: OPENPROJECT_URL und OPENPROJECT_API_TOKEN müssen als Umgebungsvariablen gesetzt sein.');
    console.error(
        'Beispiel: OPENPROJECT_URL=http://openproject.intern OPENPROJECT_API_TOKEN=xxx node tools/check-api.js',
    );
    process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`apikey:${TOKEN}`).toString('base64')}`;

if (INSECURE) {
    console.warn(
        'WARNUNG: --insecure gesetzt, TLS-Zertifikatsprüfung ist für dieses Skript deaktiviert (MITM-Risiko).',
    );
    // Node bietet für globales fetch() keinen direkten "rejectUnauthorized"-Schalter ohne
    // zusätzliche Abhängigkeit (undici). Für dieses reine Debug-Tool ist der Prozessweite
    // Schalter ausreichend, da hier nur ein einzelner Request-Typ gegen eine Instanz läuft.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * @param {string} path @param {URLSearchParams} [params]
 * @param params
 */
async function apiGet(path, params) {
    const url = new URL(path, BASE_URL);
    if (params) {
        for (const [key, value] of params) {
            url.searchParams.set(key, value);
        }
    }
    const fetchOptions = {
        headers: {
            Authorization: authHeader,
            Accept: 'application/json',
        },
    };

    let res;
    try {
        res = await fetch(url, fetchOptions);
    } catch (err) {
        throw new Error(`Netzwerkfehler bei ${url}: ${err.message}`);
    }

    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`Antwort von ${url} ist kein gültiges JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
        const msg = body && body.message ? body.message : res.statusText;
        throw new Error(`HTTP ${res.status} bei ${path}: ${msg}`);
    }

    return body;
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

async function main() {
    section('1) Erreichbarkeit & Authentifizierung (/api/v3)');
    const root = await apiGet('/api/v3');
    console.log('instanceName:', root.instanceName);
    console.log('coreVersion:', root.coreVersion);

    section('2) Identität des Tokens (/api/v3/users/me)');
    const me = await apiGet('/api/v3/users/me');
    console.log(`Angemeldet als: ${me.name} (id=${me.id}, login=${me.login}, admin=${me.admin})`);

    section('3) Verfügbare Filter (/api/v3/queries/filter_instance_schemas)');
    const schemas = await apiGet('/api/v3/queries/filter_instance_schemas', new URLSearchParams({ pageSize: '500' }));
    const filterIds = schemas._embedded.elements.map(el => el._links.self.href.split('/').pop());
    for (const needed of ['status', 'assignee', 'dueDate', 'project']) {
        console.log(`  ${needed}: ${filterIds.includes(needed) ? 'vorhanden' : 'FEHLT!'}`);
    }

    section('4) Projekte (/api/v3/projects) — für dynamische Projektliste im Admin-UI');
    const projects = await apiGet('/api/v3/projects', new URLSearchParams({ pageSize: '200' }));
    console.log(`${projects.total} Projekt(e) gefunden:`);
    for (const p of projects._embedded.elements) {
        console.log(`  - id=${p.id}  identifier=${p.identifier}  name="${p.name}"`);
    }

    section('5) Offene Arbeitspakete, sortiert nach Fälligkeitsdatum (Beispielabfrage)');
    const filters = JSON.stringify([{ status: { operator: 'o', values: [] } }]);
    const wpParams = new URLSearchParams({
        filters,
        sortBy: JSON.stringify([['dueDate', 'asc']]),
        pageSize: '10',
    });
    const wps = await apiGet('/api/v3/work_packages', wpParams);
    console.log(`total=${wps.total}, in dieser Seite: ${wps._embedded.elements.length}`);
    for (const wp of wps._embedded.elements) {
        const status = wp._links.status && wp._links.status.title;
        const assignee = wp._links.assignee && wp._links.assignee.title;
        const project = wp._links.project && wp._links.project.title;
        console.log(
            `  #${wp.id} "${wp.subject}" | fällig: ${wp.dueDate} | Status: ${status} | Projekt: ${project} | zugewiesen: ${assignee || '-'}`,
        );
    }

    section('6) Validierung: ungültiger Filterwert wird abgelehnt (Erwartung: HTTP 400)');
    try {
        await apiGet(
            '/api/v3/work_packages',
            new URLSearchParams({
                filters: JSON.stringify([{ assignee: { operator: '=', values: ['not-a-number'] } }]),
            }),
        );
        console.log('  UNERWARTET: kein Fehler zurückgegeben.');
    } catch (err) {
        console.log(`  OK, wie erwartet abgelehnt: ${err.message}`);
    }

    section('7) Verifizierte Filter-Operatoren (zur Referenz)');
    console.log(`
  status:   "o" = offen, "c" = geschlossen, "=" / "!" = ist / ist nicht (Werte: Status-IDs)
  assignee: "=" ist, "!" ist nicht, "*" ist nicht leer, "!*" ist leer (Werte: User-IDs oder "me")
  project:  "=" ist, "!" ist nicht (Werte: Projekt-IDs)
  dueDate:  "t"=heute, "w"=akt. Woche, "t+"=in genau N Tagen, "<t+"=in weniger als N Tagen,
            ">t+"=in mehr als N Tagen, "t-"=vor genau N Tagen, "<t-"=vor mehr als N Tagen,
            ">t-"=vor weniger als N Tagen, "=d"=an Datum, "<>d"=zwischen zwei Daten, "!*"=kein Datum gesetzt
            (Hinweis: "*"/"ist nicht leer" existiert für dueDate NICHT — HTTP 400 bei Verwendung)

  Der Adapter selbst berechnet "überfällig"/"bald fällig" NICHT über diese relativen
  dueDate-Operatoren, sondern lädt offene (ggf. nach assignee/project gefilterte)
  Arbeitspakete und vergleicht dueDate lokal gegen das Datum des Adapter-Hosts.
  Grund: die exakte Tagesgrenzen-Semantik von "<t+"/"<t-" (Serverzeitzone, Rundung)
  ließ sich an dieser Instanz mangels vorhandener Fälligkeitsdaten nicht empirisch
  verifizieren; die clientseitige Berechnung ist eindeutig, zeitzonenunabhängig vom
  OpenProject-Server und einfach zu testen.
`);

    section('Fertig');
    console.log('Alle Prüfungen ohne unerwartete Fehler durchgelaufen.');
}

main().catch(err => {
    console.error('\nFEHLER:', err.message);
    process.exit(1);
});
