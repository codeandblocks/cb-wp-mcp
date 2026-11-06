# Code & Blocks WordPress MCP

Selbst gehosteter MCP-Server für WordPress mit Kundenverwaltung. Kunden verbinden ihre WordPress-Seiten und arbeiten mit ihrer eigenen KI (z. B. Claude) daran: Inhalte, Medien, Page-Builder, SEO-Felder, Plugin-Daten, Theme-Dateien, Snippets und Updates. Jeder Kunde ist vollständig von den anderen getrennt.

Autor: **Code & Blocks by Marijan**

---

## Aufbau

```
KI des Kunden ──HTTPS──► MCP-Server (Coolify, Docker) ──REST API + Anwendungspasswort──► WordPress des Kunden
                          ├─ /mcp     Endpunkt für KI-Clients                              └─ Bridge-Plugin
                          ├─ /admin   Betreiber-Oberfläche und Kundenportal
                          ├─ /sso     Anmeldung mit WordPress
                          └─ /connect Seite mit Verbindungscode verbinden
```

- **MCP-Server** (`src/`): Node.js/TypeScript, SQLite in `/data`.
- **Bridge-Plugin** (`wordpress-plugin/code-blocks-mcp-bridge/`): Verbindung, Anmeldung mit WordPress, Dateien, Meta-Felder, Datenbank, Cron, Vorschau-Links, Backups, Aktivität, Live-Hinweise, Updates.
- **Skills** (`skills/`): Arbeitsanleitungen, die jede KI bei Bedarf lädt. Nur der Betreiber kann sie ändern, die KI nicht.

---

## Rollen

| Rolle | Anmeldung | Sieht und verwaltet |
|---|---|---|
| Betreiber | `ADMIN_PASSWORD` + Zwei-Faktor-Code | Kunden anlegen und löschen, Grenzen pro Kunde, Skills, Zugriffsprotokoll aller Bereiche, eigener Bereich „Code & Blocks (intern)“ |
| Kunde | mit seinem WordPress-Administratorkonto | nur den eigenen Bereich: Seiten, Freigaben, Aktivität, Updates, Einstellungen, Datenschutz, Tokens, Export, Konto löschen |

Kunden brauchen kein eigenes Passwort. Jeder Administrator einer verbundenen Seite kann sich am Portal und aus seiner KI anmelden.

---

## Kunden einrichten

1. **Betreiber:** In `/admin` unter **Kunden** einen Kunden anlegen. Es erscheint ein Verbindungscode (`CBX-…`), nur einmal sichtbar.
2. Dem Kunden schicken: Server-Adresse, Verbindungscode und das Plugin `code-blocks-mcp-bridge.zip`.
3. **Kunde:** Plugin installieren, unter **Code & Blocks MCP → Verbindung** Server-Adresse und Code eintragen, **Verbinden** klicken und in WordPress die Freigabe bestätigen.
4. **Kunde:** Im Plugin **Portal öffnen** klicken. Dort Datenschutz, Freigaben und ggf. eigene Pexels-/Unsplash-Keys einstellen.
5. **Kunde verbindet seine KI:**
   - Claude (Web, Desktop, Mobil): eigener Connector mit `https://<server>/mcp`, Anmeldung „Mit WordPress anmelden“ und die Adresse seiner Seite eingeben.
   - Claude Code: im Portal unter Einstellungen einen Token erzeugen, der fertige Befehl wird angezeigt.

Weitere Seiten desselben Kunden: im Portal unter **Seiten** oder mit demselben Code im Plugin der anderen Seite. Den Code kann der Betreiber jederzeit erneuern oder abschalten.

---

## Trennung der Kunden

- Jede Anfrage läuft in genau einem Bereich. Tokens, Seiten, Keys, Aktivität, Freigaben und Platzhalter gehören fest zu einem Bereich.
- Eine Seite kann nur mit einem Kunden verbunden sein.
- Pexels- und Unsplash-Keys sind pro Kunde. Keys aus Umgebungsvariablen gelten nur für den Betreiber.
- **Grenzen pro Kunde** (Betreiber): „Nur lesen“ erzwingen und einzelne Tools sperren. Gesperrte Tools sieht die KI gar nicht erst. Der Kunde kann zusätzlich verschärfen, aber nicht lockern.
- Skills sind reine Textanleitungen. Sie werden nie ausgeführt, die KI kann sie nicht ändern, und sie heben keine Grenze und keine Freigabe auf. Das setzt der Server durch.
- `npm test` prüft die Trennung automatisch mit zwei nachgebauten WordPress-Seiten (13 Tests).

---

## Datenschutz

Details für Auftragsverarbeitungsverträge (Datenarten, Speicherorte, Fristen, technische und organisatorische Maßnahmen) stehen in [`docs/DATENSCHUTZ.md`](docs/DATENSCHUTZ.md). Kurz:

- **Pseudonymisierung** (Standard: an): E-Mail-Adressen, Telefonnummern und IP-Adressen gehen nur als Platzhalter `[[pii:…]]` an die KI. Schreibt die KI einen Platzhalter zurück, setzt der Server den Originalwert ein. Die Zuordnung ist verschlüsselt, gilt pro Kunde und 24 Stunden.
- **Sperre für personenbezogene Daten** (Standard: gesperrt): Benutzerlisten, Kommentare, Bestellungen, Kunden- und Formulardaten sind für die KI gesperrt, bis der Kunde sie freigibt.
- **Datensparsame Protokolle:** keine Inhalte, keine Empfänger, keine SQL-Werte.
- **Löschfristen:** Aktivität 30/90/180/365 Tage (Kunde wählt), Freigaben 30 Tage, Zugriffsprotokoll 365 Tage, Platzhalter 24 Stunden. Abgelaufenes wird täglich gelöscht.
- **Zugriffsprotokoll:** Anmeldungen, verbundene KI-Clients, Exporte und jeder Zugriff des Betreibers auf einen Kundenbereich. Der Kunde sieht seinen Teil im Portal.
- **Export und Löschung:** Der Kunde kann seine Daten als JSON exportieren und sein Konto selbst löschen. Dabei werden die Anwendungspasswörter in WordPress widerrufen, und es gibt eine Löschbestätigung.
- **Verschlüsselung:** Anwendungspasswörter, API-Keys, Freigabe-Details und Platzhalter mit AES-256-GCM. Tokens nur als SHA-256-Hash.

---

## Installation und Update

### Coolify

1. Application aus dem Git-Repository, **Build Pack: Dockerfile**, **Port 3000**, Domain setzen.
2. Umgebungsvariablen:

   | Variable | Wert |
   |---|---|
   | `PUBLIC_URL` | `https://wp-mcp.deinedomain.de` |
   | `ADMIN_PASSWORD` | langes Passwort (mind. 12 Zeichen) |

3. **Persistent Storage** auf `/data`. Dort liegen Datenbank und Schlüssel.
4. **Healthcheck**: Pfad `/health`, Host `127.0.0.1`, Port 3000.
5. Nach dem ersten Login unter **Sicherheit** die Zwei-Faktor-Anmeldung einschalten.

### Update von 1.2

Beim ersten Start übernimmt 1.3 automatisch alle Daten aus 1.2 (Seiten, Keys, Token, Claude-Verbindungen, Aktivität) in den Bereich „Code & Blocks (intern)“. Bestehende Claude-Verbindungen bleiben angemeldet. Die alten Dateien werden in `*.migrated` umbenannt.

Plugin auf den Seiten auf **1.3** aktualisieren. Ohne 1.3 funktioniert „Anmelden mit WordPress“ nicht.

### Sicherung

`/data` regelmäßig sichern, z. B. mit der Volume-Sicherung von Coolify. `secret.key` getrennt aufbewahren: Ohne den Schlüssel sind die gespeicherten Zugangsdaten nicht lesbar. Alternativ `SECRET_KEY` setzen und den Wert im Passwortmanager hinterlegen.

---

## Umgebungsvariablen (optional)

| Variable | Zweck |
|---|---|
| `SECRET_KEY` | Eigener Schlüssel statt `/data/secret.key` |
| `MCP_TOKEN` | Fester Token für den Betreiber-Bereich |
| `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`, `WP_SITES` | Seiten per Variable, werden einmalig in den Betreiber-Bereich übernommen |
| `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` | Bild-Keys, nur für den Betreiber-Bereich |
| `READ_ONLY` | `true` erzwingt „Nur lesen“ für alle |
| `APPROVAL_WAIT_SECONDS` | Wartezeit auf Freigaben (Standard 40) |
| `ACCESS_TOKEN_TTL_HOURS`, `REFRESH_TOKEN_TTL_DAYS`, `MAX_UPLOAD_MB`, `MAX_OUTPUT_CHARS`, `TRUST_PROXY`, `ALLOW_PRIVATE_FETCH`, `ALLOW_TOKEN_IN_URL` | Feineinstellungen |

---

## Tools

| Bereich | Tools |
|---|---|
| Seiten | `list_sites`, `site_info`, `site_settings` |
| Inhalte | `list_content_types`, `list_content`, `get_content`, `create_content`, `update_content`, `delete_content` |
| Taxonomien | `list_terms`, `manage_term` |
| Medien | `list_media`, `upload_media`, `search_images` |
| Plugins & Themes | `list_plugins`, `manage_plugin`, `list_themes`, `manage_updates` |
| Allgemein | `rest_request`, `fetch_page`, `audit_page`, `list_abilities`, `run_ability` |
| Skills | `skill_list`, `skill_load` (nur lesen) |
| Bridge: Dateien | `file_list`, `file_read`, `file_write`, `file_edit`, `file_delete`, `file_search`, `file_restore` |
| Bridge: Daten | `manage_meta`, `db_schema`, `db_query`, `manage_option` |
| Bridge: Entwürfe | `duplicate_content`, `apply_copy`, `create_preview`, `copy_theme`, `create_child_theme`, `activate_theme` |
| Bridge: Betrieb | `manage_snippet`, `manage_cron`, `send_test_email`, `flush_cache` |

---

## Fehlerbehebung

**401 „rest_not_logged_in“:** Manche Apache-Hoster entfernen den `Authorization`-Header. In der `.htaccess` oberhalb von `# BEGIN WordPress`: `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`

**„Anwendungspasswörter sind deaktiviert“:** Ein Sicherheits- oder 2FA-Plugin blockiert sie. Dort erlauben.

**Anmeldung mit WordPress schlägt fehl:** Plugin auf 1.3 aktualisieren und prüfen, dass im Plugin die richtige Server-Adresse steht.

**403 von Cloudflare oder einer Firewall:** IP des Servers oder User-Agent `CodeBlocks-WP-MCP` erlauben.

**Seite nach einem Snippet kaputt:** Im Plugin den Notfallmodus aktivieren oder `define( 'CBMCP_SAFE_MODE', true );` in die `wp-config.php` schreiben.

---

## Entwicklung

```bash
npm install
npm run build
npm test
PUBLIC_URL=http://localhost:3000 ADMIN_PASSWORD=lokales-passwort DATA_DIR=./data npm start
```

Benötigt Node.js 22.13 oder neuer (eingebautes SQLite).

---

© 2026 Code & Blocks by Marijan. MCP-Server: MIT-Lizenz. WordPress-Plugin: GPL-2.0-or-later.
