![Logo](admin/openproject.png)
# ioBroker.openproject

[![NPM version](https://img.shields.io/npm/v/iobroker.openproject.svg)](https://www.npmjs.com/package/iobroker.openproject)
[![Downloads](https://img.shields.io/npm/dm/iobroker.openproject.svg)](https://www.npmjs.com/package/iobroker.openproject)

**Tests:** ![Test and Release](https://github.com/m-arv/ioBroker.openproject/workflows/Test%20and%20Release/badge.svg)

## Über diesen Adapter

Überwacht überfällige und bald fällige Arbeitspakete in einer selbst gehosteten [OpenProject](https://www.openproject.org/) Community-Edition-Instanz, stellt sie als States bereit und kann optional über eine andere ioBroker-Adapterinstanz (Telegram, Pushover, E-Mail, …) benachrichtigen.

Der Adapter läuft im **schedule**-Modus: Er startet zur konfigurierten Zeit (Standard: werktags 07:30 Uhr), fragt OpenProject einmal ab, aktualisiert die States, verschickt bei Bedarf eine Benachrichtigung und beendet sich danach wieder selbst.

## Voraussetzungen

- Eine erreichbare OpenProject-Instanz (entwickelt und getestet gegen Community Edition 17.4.0, REST API v3)
- Ein API-Token: in OpenProject unter **Mein Konto → Zugriffstoken → API** erzeugen
- ioBroker js-controller ≥ 6.0.11, Admin ≥ 7.6.20
- Node.js ≥ 22 (nur relevant für die Node-Version deines js-controller-Hosts bzw. für die Entwicklung selbst; siehe unten)

## Installation

Der Adapter ist (noch) nicht im offiziellen ioBroker-Repository und nicht auf npm veröffentlicht. Installation erfolgt über **"Eigene Installation aus URL"** in der Admin-Oberfläche (Reiter "Adapter" → Symbol oben rechts):

```
https://github.com/m-arv/ioBroker.openproject/tarball/main
```

**Wichtig, da das Repository aktuell privat ist:** Diese URL lässt sich nur laden, wenn dein ioBroker-Host Zugriff darauf hat. Entweder machst du das Repository auf GitHub öffentlich (es enthält keine Geheimnisse — Token/URL werden ausschließlich verschlüsselt in der ioBroker-Objektdatenbank gespeichert, nie im Code), oder du nutzt eine URL mit eingebettetem GitHub-Token, z. B. `https://<TOKEN>@github.com/m-arv/ioBroker.openproject.git`. Letzteres bitte nur mit einem eng begrenzten, jederzeit widerrufbaren Token tun.

Nach der Installation die Instanz `openproject.0` anlegen und konfigurieren (siehe unten).

## Konfiguration in der Admin-UI

Die Konfiguration ist auf drei Reiter aufgeteilt:

### Verbindung

| Feld | Bedeutung |
|---|---|
| Basis-URL | z. B. `http://openproject.intern` oder `https://projekte.example.com` |
| API-Token | wird verschlüsselt gespeichert (`encryptedNative`) und ist nur Administratoren/dem Adapter selbst zugänglich (`protectedNative`) |
| Zertifikatsprüfung deaktivieren | nur bei selbstsigniertem Zertifikat aktivieren — deaktiviert TLS-Validierung, ermöglicht Man-in-the-Middle-Angriffe, nur im vertrauenswürdigen internen Netz verwenden |
| Timeout (Sekunden) | Standard 15 |
| Verbindung testen | prüft Auth + Erreichbarkeit gegen die aktuell eingetragenen (auch ungespeicherten) Werte |

### Abfrage

| Feld | Bedeutung |
|---|---|
| Vorwarnzeit (Tage) | Arbeitspakete, die innerhalb dieser Frist fällig werden, gelten als "bald fällig" |
| Nur mir zugewiesene Arbeitspakete | bezieht sich auf den Benutzer, dem das API-Token gehört |
| Auf Projekte einschränken | Mehrfachauswahl, lädt die Projektliste live aus OpenProject |
| Maximale Anzahl Arbeitspakete | begrenzt die pro Lauf abgerufene Menge |

Der **Zeitplan selbst** (wann der Adapter läuft) wird nicht hier, sondern im separaten Reiter **"Zeitplan"** der Instanz eingestellt — das ist eine eingebaute Admin-Funktion für `schedule`-Adapter, keine eigene Einstellung dieses Adapters. Voreingestellt ist `30 7 * * 1-5` (werktags 07:30).

### Benachrichtigung

| Feld | Bedeutung |
|---|---|
| Benachrichtigungen aktivieren | schaltet den ganzen Block frei |
| Ziel-Adapterinstanz | Instanz eines Messaging-Adapters (Telegram, Pushover, E-Mail, Signal, …) |
| Empfänger/Chat-ID | optional, überschreibt den Standard-Empfänger der Zielinstanz, falls unterstützt |
| Nur bei Änderungen erneut benachrichtigen | siehe Logik weiter unten |
| Wiederholungssperre (Tage) | Standard 7 |

**Wichtige Einschränkung, adapterspezifisch:** "Verbindung testen" und die Projektliste funktionieren nur, während die Instanz tatsächlich läuft. Das ist keine Einschränkung dieses Adapters, sondern eingebautes Verhalten der ioBroker-Admin-Oberfläche (der zugehörige `sendTo`-Button ist grundsätzlich deaktiviert, solange `system.adapter.openproject.0.alive` nicht `true` ist). Da ein `schedule`-Adapter normalerweise nur kurz zur geplanten Zeit läuft, ist `common.allowInit` aktiviert: Beim Speichern der Konfiguration startet die Instanz automatisch und bleibt danach noch ca. 3 Minuten aktiv (bewusste Design-Entscheidung, siehe „Annahmen" unten) — in diesem Fenster funktionieren beide Buttons.

## Entstehende States

Alle States liegen unter `openproject.0.*`:

| State | Typ | Rolle | Bedeutung |
|---|---|---|---|
| `info.connection` | boolean | `indicator.connected` | letzter Lauf erfolgreich verbunden |
| `info.lastRun` | string | `value.datetime` | Zeitpunkt (ISO 8601) des letzten Laufs, egal ob erfolgreich |
| `info.lastError` | string | `text` | Fehlertext des letzten fehlgeschlagenen Laufs, sonst leer |
| `overdue.count` | number | `value` | Anzahl überfälliger Arbeitspakete |
| `overdue.list` | string | `json` | JSON-Array überfälliger Arbeitspakete |
| `upcoming.count` | number | `value` | Anzahl bald fälliger Arbeitspakete |
| `upcoming.list` | string | `json` | JSON-Array bald fälliger Arbeitspakete |
| `state.notifiedIds` | string | `json` | intern, für die Wiederholungssperre — nur im Experten-Modus des Objektbaums sichtbar |

Jeder Eintrag in `overdue.list`/`upcoming.list` hat die Form:
```json
{ "id": 123, "subject": "Terrasse fertigstellen", "dueDate": "2026-08-01", "status": "Neu", "project": "Garten", "url": "http://openproject.intern/work_packages/123" }
```

**Zum Konzept „Rolle":** Die `role` eines States sagt Visualisierungen (VIS) und anderen Adaptern, *wie* ein Wert zu interpretieren ist — unabhängig vom technischen Datentyp. `value` ist z. B. eine generische Zahl, `indicator.connected` speziell ein Verbindungsstatus (den VIS z. B. automatisch mit einem Ampel-Symbol darstellen kann), `json` markiert einen String als maschinenlesbare Struktur. VIS-Widgets filtern beim Auswählen eines Datenpunkts oft nach Rolle, deshalb lohnt es sich, keine erfundenen Rollennamen zu verwenden, sondern die [offizielle Liste](https://www.iobroker.net/#en/documentation/dev/stateroles.md).

Verwaiste States (z. B. nach einem künftigen Umbau des Objektbaums) werden bei jedem Adapterstart automatisch entfernt.

## Beispiel für eine VIS-Nutzung

- Ein Text-/Wert-Widget auf `openproject.0.overdue.count` zeigt die Anzahl überfälliger Arbeitspakete als einfache Kachel/Badge.
- Für eine Liste: `overdue.list` ist ein JSON-String (kein natives VIS-Array-Binding). Zwei praktikable Wege:
  1. Ein Widget-Typ, der JSON-Strings direkt rendern kann (z. B. ein "JSON-Table"/"Raw HTML"-Widget deiner VIS-Variante, sofern vorhanden), oder
  2. Ein kleines Skript in ioBroker.javascript, das `overdue.list` bei Änderung parst und in einzelne, nummerierte States (`0.subject`, `0.dueDate`, …) zerlegt, die klassische VIS-Widgets direkt binden können.

Ich habe hierfür keine laufende VIS-Instanz zur Verfügung gehabt und konnte keinen konkreten Widget-Typ live verifizieren — siehe „Annahmen" unten.

## Troubleshooting

- **`info.connection` ist `false`, `info.lastError` gefüllt:** Fehlertext lesen — deckt fehlende/falsche URL, fehlenden/falschen Token, Timeout und HTTP-Fehler ab.
- **"Verbindung testen" bzw. Projektliste sind ausgegraut / zeigen "instance is offline":** Instanz läuft gerade nicht. Konfiguration einmal speichern (startet sie automatisch für ~3 Minuten) oder auf den nächsten planmäßigen Lauf warten.
- **URL wird als ungültig markiert:** Es wird `http://` oder `https://` vorangestellt erwartet.
- **`openproject.intern` (o. ä. interner Hostname) nicht erreichbar:** DNS-Auflösung vom ioBroker-Host aus prüfen (`.intern`-Namen funktionieren nur, wenn der Host denselben internen DNS-Resolver nutzt wie dein Entwicklungsrechner).
- **Selbstsigniertes Zertifikat:** "Zertifikatsprüfung deaktivieren" aktivieren — nur im vertrauenswürdigen internen Netz, siehe Warnhinweis im Feld.
- **Keine Benachrichtigung trotz überfälliger Arbeitspakete:** Prüfen, ob "Benachrichtigungen aktivieren" an ist, eine Ziel-Adapterinstanz gewählt wurde, und ob die Wiederholungssperre noch aktiv ist (bereits gemeldete, unveränderte Arbeitspakete werden erst nach Ablauf der Sperrfrist oder bei Status-/Datumsänderung erneut gemeldet).
- **Log prüfen:** Log-Level der Instanz ggf. auf `debug` stellen; der API-Token erscheint dabei nie im Log (auch nicht im Fehlerfall).

## Entwicklung mit dev-server

Dieses Projekt wird ausschließlich gegen [`@iobroker/dev-server`](https://github.com/ioBroker/dev-server) entwickelt und getestet — nicht gegen eine echte ioBroker-Installation.

```bash
npm install
npx dev-server setup --adminPort 8091   # einmalig; Port frei wählen, falls 8081 o.ä. bereits von einem produktiven Admin belegt ist
npx dev-server watch
```

- Die Admin-Oberfläche läuft danach unter `http://localhost:8091/` (bzw. dem gewählten Port).
- Logs erscheinen direkt im Terminal, in dem `dev-server watch` läuft.
- Änderungen an `main.js`/`lib/*.js` lädt `dev-server watch` automatisch neu (nodemon-Watcher).
- Änderungen an `admin/jsonConfig.json` oder `admin/i18n/*.json` werden per Browsersync in den geöffneten Admin-Tab injiziert; falls das UI nicht reagiert, Seite manuell neu laden (F5).
- `tools/check-api.js` prüft unabhängig vom Adapter direkt gegen die OpenProject-API (siehe Kommentar im Datei-Kopf für Aufruf mit Umgebungsvariablen).

Nützliche Scripts (`npm run <name>`):

| Script | Zweck |
|---|---|
| `check` | TypeScript-Typprüfung auf dem JS-Code (`checkJs`) |
| `lint` | ESLint |
| `test` | Paket-/Strukturtests (`test:js` + `test:package`) |
| `dev-server` | Kurzform für `npx dev-server` |

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.0.1 (2026-07-28)
* (m-arv) Initial release

## Annahmen und offene Punkte

Ehrlich und vollständig, damit nichts stillschweigend erfunden wurde:

1. **Fälligkeits-Klassifizierung läuft clientseitig**, nicht über OpenProjects relative `dueDate`-Operatoren (`<t+`/`<t-`). Die Operatoren selbst wurden über den Filter-Schema-Endpunkt verifiziert (siehe `tools/check-api.js`), ihre genaue Tagesgrenzen-Semantik (Zeitzone, Rundung) ließ sich mangels vorhandener Fälligkeitsdaten in der Testinstanz aber nicht empirisch verifizieren. Die clientseitige Berechnung ist eindeutig und wurde stattdessen gewählt.
2. **Keine Testdaten mit echten Fälligkeitsdaten verfügbar:** Die zum Testen verwendete OpenProject-Instanz hatte zum Zeitpunkt der Entwicklung 59 offene Arbeitspakete, aber keines mit gesetztem Fälligkeitsdatum. Die komplette Abfrage-, Klassifizierungs- und State-Pipeline wurde live gegen die echte API verifiziert (Auth, Filter, Fehlerfälle, Projektliste, Admin-UI); die konkrete Überfällig/Bald-fällig-Aufteilung selbst beruht auf Code-Review der reinen Datumsvergleichs-Funktion, nicht auf einem echten Positiv-Treffer. Ich habe bewusst keine Test-Arbeitspakete in der echten Instanz angelegt, um keine Produktivdaten zu verändern.
3. **3-minütige „Nachlaufzeit" nach jedem Lauf** (`GRACE_PERIOD_MS` in `main.js`) sowie `common.allowInit: true` (Start bei Config-Speicherung) sind eigene Design-Entscheidungen, um die geforderten `sendTo`-Buttons ("Verbindung testen", Projektliste) in einem `schedule`-Adapter überhaupt nutzbar zu machen — das stand nicht explizit in der Anforderung, war aber ohne diese Ergänzung nicht sinnvoll umsetzbar.
4. **Nachrichtenformat für Ziel-Adapter** (`lib/notify-payload.js`): Feldnamen wie `text` vs. `message` und der Empfänger-Schlüssel je Zieladapter (Telegram, Pushover, E-Mail, …) folgen der dokumentierten/allgemein bekannten Konvention der jeweiligen Adapter, konnten aber nicht live getestet werden — in dieser Umgebung war keine Messaging-Adapterinstanz installiert. Bei Bedarf dort anpassen.
5. **"Nur bei Änderungen erneut benachrichtigen"**: eigene Interpretation, da die Anforderung Wiederholungssperre und Änderungserkennung im selben Absatz beschreibt. Umgesetzt als: aktiviert → Wiederholungssperre wird komplett ignoriert, ein Arbeitspaket wird nur bei geändertem Status/Datum erneut gemeldet. Deaktiviert (Standard) → zusätzlich greift die reguläre Wiederholungssperre wie im Auftrag beschrieben.
6. **Liste der Ziel-Adapter** in der Instanzauswahl (`admin/jsonConfig.json`, `notifyInstance`) ist eine kuratierte Auswahl gängiger Messaging-Adapter, keine vollständige Liste aller existierenden. Bei Bedarf im Quelltext ergänzen.
7. **Übersetzungen:** Nur Deutsch und Englisch sind inhaltlich gepflegt (wie beauftragt). Die übrigen neun von `@iobroker/create-adapter` angelegten Sprachen enthalten den englischen Text als Platzhalter statt kaputter Maschinenübersetzung.
8. **Adapter-Checker:** Alle behebbaren Befunde wurden behoben (siehe Commit-Historie). Bewusst offen gelassen, weil für ein privates, nicht veröffentlichtes Projekt nicht zutreffend: Paket nicht auf npm, kein Git-Tag für 0.0.1, kein `deploy`-Job im CI-Workflow.
9. **Repository ist privat** (wie besprochen). Für "Eigene Installation aus URL" ist das eine echte Einschränkung, siehe Abschnitt „Installation" oben — Entscheidung (öffentlich machen vs. Token-URL) liegt bei dir.
10. Keine erfundenen API-Parameter, Versionsnummern oder JSON-Config-Felder — alles in dieser README und im Code Genannte wurde entweder gegen die echte OpenProject-API, den echten dev-server/Admin oder den offiziellen `ioBroker/json-config`-Quellcode verifiziert; die einzigen Ausnahmen sind explizit oben als Annahme gekennzeichnet.

## License
MIT License

Copyright (c) 2026 m-arv <79217104+m-arv@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
