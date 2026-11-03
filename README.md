# Code & Blocks WordPress MCP

Selbst gehosteter MCP-Server für WordPress. Claude kann damit Inhalte, Medien, Plugins, Themes, Page-Builder-Seiten, SEO-Felder, Plugin-Daten, Theme-Dateien und PHP-Snippets deiner WordPress-Seiten verwalten. Keine Aufruf-Limits, keine Fremdanbieter dazwischen.

Autor: **Code & Blocks by Marijan**

---

## Aufbau

```
Claude  ──HTTPS──►  MCP-Server (Coolify, Docker)  ──REST API + Application Password──►  WordPress
                                                   └─ optional: Bridge-Plugin (cbmcp/v1)
```

- **MCP-Server** (`src/`): Node.js/TypeScript, Endpunkt `/mcp` (Streamable HTTP, zustandslos)
- **Anmeldung**: OAuth mit Passwortseite (für Claude im Web, Desktop und Mobil) und/oder statischer Bearer-Token (für Claude Code, Skripte)
- **Bridge-Plugin** (`wordpress-plugin/code-blocks-mcp-bridge/`): optional, für alles, was die REST API nicht kann (Dateien, Meta-Felder, Datenbank, Cron, Vorschau-Links …)
- **Skills** (`skills/`): Arbeitsanleitungen für Claude (Elementor, andere Page-Builder, Block-Themes, SEO-Plugins, Plugin-Daten, WooCommerce, sicherer Ablauf). Eigene Skills speichert Claude in `/data/skills`.

## Tools

| Bereich | Tools |
|---|---|
| Seiten | `list_sites`, `site_info`, `site_settings` |
| Inhalte | `list_content_types`, `list_content`, `get_content`, `create_content`, `update_content`, `delete_content` |
| Taxonomien | `list_terms`, `manage_term` |
| Medien | `list_media`, `upload_media` (per URL oder Base64, inkl. Beitragsbild setzen) |
| Plugins & Themes | `list_plugins`, `manage_plugin` (aktivieren, deaktivieren, installieren, löschen), `list_themes` |
| Allgemein | `rest_request` (beliebige REST-Route, z. B. WooCommerce, Menüs, Block-Templates), `fetch_page`, `audit_page` (SEO, Überschriften, Alt-Texte, tote Links, Platzhaltertexte) |
| Abilities API | `list_abilities`, `run_ability` (WordPress 6.9+, z. B. ACF und andere Plugins) |
| Stockbilder | `search_images` (Pexels, Unsplash), Ergebnis direkt an `upload_media` übergeben |
| Skills | `skill_list`, `skill_load`, `skill_save`, `skill_delete` |
| Bridge: Dateien | `file_list`, `file_read`, `file_write`, `file_edit`, `file_delete`, `file_search`, `file_restore` |
| Bridge: Meta & Daten | `manage_meta` (auch geschützte Felder wie `_elementor_data`, Yoast/Rank Math, ACF; mit Outline, Element-Suche, Teil-Updates, Backups), `db_schema`, `db_query`, `manage_option` |
| Bridge: Entwürfe & Vorschau | `duplicate_content`, `apply_copy`, `create_preview`, `copy_theme`, `create_child_theme`, `activate_theme` |
| Bridge: Betrieb | `manage_snippet`, `manage_cron`, `send_test_email`, `flush_cache` |

Neue Beiträge und Seiten werden standardmäßig als **Entwurf** angelegt.

### Sicherer Ablauf für Live-Seiten

1. `duplicate_content` legt eine Entwurfskopie an (inklusive Page-Builder-Daten) und liefert einen Vorschau-Link, der ohne Login funktioniert.
2. Claude ändert die Kopie und prüft sie mit `audit_page`.
3. Du schaust dir den Vorschau-Link an.
4. Erst nach deinem OK überträgt `apply_copy` die Kopie auf die Originalseite. Vom Original wird vorher ein Backup-Entwurf angelegt.

Für Themes gilt das Gleiche: `copy_theme` oder `create_child_theme`, Dateien ändern, Vorschau-Link ansehen, erst dann `activate_theme`.

---

## 1. WordPress vorbereiten

### Benutzer und Application Password

1. In WordPress einen eigenen Benutzer anlegen, z. B. `claude`.
   - Rolle **Administrator**, wenn Plugins, Themes, Dateien und Einstellungen verwaltet werden sollen.
   - Rolle **Redakteur**, wenn nur Inhalte und Medien bearbeitet werden sollen.
2. Als dieser Benutzer: **Benutzer → Profil → Anwendungspasswörter**, Name z. B. `MCP-Server`, auf **Neues Anwendungspasswort hinzufügen** klicken.
3. Das angezeigte Passwort (`xxxx xxxx xxxx …`) kopieren. Es wird nur einmal angezeigt.

Hinweis: Anwendungspasswörter funktionieren nur, wenn die Seite über HTTPS läuft.

### Bridge-Plugin installieren (optional, empfohlen)

1. Den Ordner `wordpress-plugin/code-blocks-mcp-bridge` als ZIP packen (oder die mitgelieferte `code-blocks-mcp-bridge.zip` nehmen).
2. In WordPress unter **Plugins → Installieren → Plugin hochladen** hochladen und aktivieren.

Ohne Bridge-Plugin funktionieren nur die Tools ohne „Bridge“ in der Tabelle oben.

Optionale Konstanten in der `wp-config.php`:

```php
define( 'CBMCP_DISABLE_FILE_WRITE', true ); // Dateien nur lesen
define( 'CBMCP_DISABLE_SNIPPETS', true );   // Snippets komplett aus
define( 'CBMCP_SAFE_MODE', true );          // Notfall: keine Snippets ausführen
define( 'CBMCP_ALLOW_DB_WRITE', true );     // SQL INSERT/UPDATE/DELETE/REPLACE erlauben (Standard: nur lesen)
```

Auch mit `CBMCP_ALLOW_DB_WRITE` sind keine Schemaänderungen (DROP, ALTER, TRUNCATE …) möglich, und UPDATE/DELETE brauchen immer ein WHERE.

---

## 2. Code in ein Git-Repository legen

Coolify baut aus einem Git-Repository. Den Projektordner (ohne `node_modules`) in ein privates Repository auf GitHub, GitLab oder Gitea pushen:

```bash
git init
git add .
git commit -m "Code & Blocks WordPress MCP"
git branch -M main
git remote add origin git@github.com:DEIN-NAME/cb-wp-mcp.git
git push -u origin main
```

---

## 3. In Coolify deployen

1. **+ New → Application** und das Repository wählen (privat über die GitHub App oder einen Deploy Key).
2. **Build Pack: Dockerfile**.
3. **Ports Exposes: `3000`**.
4. **Domains:** `https://mcp.deinedomain.de` (DNS-A-Record auf den VPS zeigen lassen). Coolify holt das Let's-Encrypt-Zertifikat automatisch.
5. **Environment Variables** setzen:

   | Variable | Wert |
   |---|---|
   | `PUBLIC_URL` | `https://mcp.deinedomain.de` |
   | `ADMIN_PASSWORD` | langes Passwort für die Anmeldeseite (mind. 12 Zeichen) |
   | `MCP_TOKEN` | optional, für Claude Code: `openssl rand -hex 32` |
   | `WP_URL` | `https://deine-wordpress-seite.de` |
   | `WP_USER` | `claude` |
   | `WP_APP_PASSWORD` | das Anwendungspasswort |

   Optional für Stockbilder: `PEXELS_API_KEY` und/oder `UNSPLASH_ACCESS_KEY` (siehe unten). Alle Optionen stehen in `.env.example`.

6. **Persistent Storage** hinzufügen: Volume, Mount-Pfad **`/data`**. Dort liegen die OAuth-Anmeldungen. Ohne Volume musst du dich nach jedem Redeploy neu verbinden.
7. **Deploy**. Danach muss `https://mcp.deinedomain.de/health` mit `{"ok":true,…}` antworten.

### Mehrere WordPress-Seiten

Statt `WP_URL`/`WP_USER`/`WP_APP_PASSWORD` die Variable `WP_SITES` als JSON in einer Zeile setzen:

```json
[{"id":"blog","url":"https://blog.de","user":"claude","appPassword":"xxxx xxxx xxxx xxxx xxxx xxxx"},
 {"id":"shop","url":"https://shop.de","user":"claude","appPassword":"yyyy yyyy yyyy yyyy yyyy yyyy"}]
```

Claude wählt die Seite dann über den Parameter `site` (z. B. „im Shop …“). Die erste Seite ist die Standardseite.

---

## 4. Mit Claude verbinden

### Claude (Web, Desktop, Mobil)

1. In den Claude-Einstellungen unter **Connectors** einen eigenen (Custom) Connector hinzufügen.
2. URL: `https://mcp.deinedomain.de/mcp`
3. Auf **Verbinden** klicken. Es öffnet sich die Anmeldeseite des Servers, dort das `ADMIN_PASSWORD` eingeben.

Danach den Connector im Chat aktivieren und z. B. fragen: „Zeig mir die letzten 5 Beiträge auf meiner Seite.“

### Claude Code

```bash
claude mcp add --transport http wordpress https://mcp.deinedomain.de/mcp \
  --header "Authorization: Bearer DEIN_MCP_TOKEN"
```

### Notlösung ohne OAuth

Falls ein Client weder OAuth noch eigene Header kann: `ALLOW_TOKEN_IN_URL=true` setzen und `https://mcp.deinedomain.de/mcp/DEIN_MCP_TOKEN` als URL verwenden. Der Token steht dann in der URL und damit eventuell in Logs. Nur verwenden, wenn es nicht anders geht.

---

## Stockbilder (optional)

**Pexels**
1. Konto auf pexels.com anlegen.
2. Auf https://www.pexels.com/api/ einen API-Key anfordern. Er wird sofort angezeigt.
3. In Coolify als `PEXELS_API_KEY` eintragen.

Kostenlos, 200 Anfragen pro Stunde und 20.000 pro Monat.

**Unsplash**
1. Auf https://unsplash.com/developers als Developer registrieren.
2. Unter https://unsplash.com/oauth/applications eine neue Application anlegen und die Nutzungsbedingungen bestätigen.
3. Den **Access Key** (nicht den Secret Key) in Coolify als `UNSPLASH_ACCESS_KEY` eintragen.

Im Demo-Modus 50 Anfragen pro Stunde. Für mehr kannst du bei Unsplash die Freigabe für den Produktionsbetrieb beantragen.

Beide verlangen eine Nennung von Fotograf und Plattform. `search_images` liefert dafür fertige Bildunterschriften, und bei Unsplash wird der vorgeschriebene Download-Zähler automatisch ausgelöst. Hinweis: Unsplash sieht für API-Apps eigentlich das Einbinden über ihre Bild-URLs vor. Das Hochladen in die Mediathek ist eine Grauzone, für einzelne Bilder auf eigenen Seiten aber üblich (so arbeiten auch bekannte WordPress-Plugins). Pexels ist hier unkomplizierter.

---

## Sicherheit

- Der Server startet nicht ohne `ADMIN_PASSWORD` oder `MCP_TOKEN`.
- Anmeldeversuche sind begrenzt (10 pro 15 Minuten und IP), fehlgeschlagene Token-Prüfungen ebenfalls.
- Tokens werden nur als SHA-256-Hash gespeichert (`/data/oauth.json`).
- `upload_media` lädt keine Dateien von internen Adressen (localhost, private Netze, Cloud-Metadaten), damit über den Server nichts aus deinem VPS-Netz abgegriffen werden kann.
- `fetch_page` ruft nur Adressen der eingetragenen WordPress-Seiten ab.
- Das Bridge-Plugin
  - erlaubt nur Administratoren den Zugriff,
  - beschränkt Dateien auf `themes`, `plugins`, `mu-plugins` und `languages` (kein `wp-config.php`, kein `uploads`, keine Symlinks nach außen),
  - prüft PHP-Dateien vor dem Speichern auf Syntaxfehler und JSON-Dateien auf gültiges JSON,
  - legt vor jeder Änderung ein Backup an (`wp-content/cbmcp-backups`, letzte 10 je Datei),
  - deaktiviert Snippets automatisch, wenn sie einen Fehler werfen,
  - kann sich selbst nicht verändern,
  - sichert Meta-Felder vor jeder Änderung (letzte 10 Stände je Feld),
  - erlaubt SQL standardmäßig nur lesend, ohne mehrere Anweisungen, ohne Dateizugriffe aus SQL,
  - erstellt Vorschau-Links mit Ablaufzeit, die Seiten-Caches umgehen und nicht indexiert werden.
- `READ_ONLY=true` blendet alle schreibenden Tools aus.
- Für einen produktiven Shop: vor größeren Änderungen ein Backup der Seite machen.

---

## Fehlerbehebung

**401 „rest_not_logged_in“ obwohl das Passwort stimmt**
Manche Apache-Hoster entfernen den `Authorization`-Header. In der `.htaccess` von WordPress oberhalb von `# BEGIN WordPress` ergänzen:

```apache
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```

**403 von Cloudflare, Wordfence oder anderer Firewall**
Die IP des VPS freigeben oder den User-Agent `CodeBlocks-WP-MCP` erlauben.

**Seite nach einem Snippet kaputt**
Snippets mit Fehlern werden beim nächsten Aufruf automatisch deaktiviert. Falls nicht: `define( 'CBMCP_SAFE_MODE', true );` in die `wp-config.php` schreiben, Snippet löschen oder korrigieren, Konstante wieder entfernen.

**Nach jedem Deploy neu verbinden nötig**
Persistent Storage auf `/data` fehlt (siehe Coolify-Schritt 6).

**„PUBLIC_URL is required“**
`PUBLIC_URL` in Coolify setzen, ohne `/mcp` und ohne Schrägstrich am Ende.

**Theme-Vorschau bleibt im eigenen Browser hängen**
Ein Theme-Vorschau-Link setzt ein Cookie, damit du dich in der Vorschau bewegen kannst. Es gilt bis zum Schließen des Browsers oder bis der Link abläuft. Privates Fenster nutzen oder Cookie `cbmcp_preview` löschen.

**Serverseitiger Cache (z. B. Nginx FastCGI Cache, Cloudflare APO) zeigt Vorschau oder alten Stand**
Vorschau-Anfragen senden `no-cache`-Header und setzen `DONOTCACHEPAGE`. Caches auf Server- oder CDN-Ebene, die das ignorieren, für URLs mit `cbmcp_preview` ausnehmen.

**Logs**
In Coolify unter **Theme-Vorschau bleibt im eigenen Browser hängen**
Ein Theme-Vorschau-Link setzt ein Cookie, damit du dich in der Vorschau bewegen kannst. Es gilt bis zum Schließen des Browsers oder bis der Link abläuft. Privates Fenster nutzen oder Cookie `cbmcp_preview` löschen.

**Serverseitiger Cache (z. B. Nginx FastCGI Cache, Cloudflare APO) zeigt Vorschau oder alten Stand**
Vorschau-Anfragen senden `no-cache`-Header und setzen `DONOTCACHEPAGE`. Caches auf Server- oder CDN-Ebene, die das ignorieren, für URLs mit `cbmcp_preview` ausnehmen.

**Logs** wird jeder Tool-Aufruf mit Dauer und Ergebnis protokolliert (ohne Inhalte und Passwörter).

---

## Lokal entwickeln

```bash
npm install
npm run build
PUBLIC_URL=http://localhost:3000 ADMIN_PASSWORD=lokales-passwort DATA_DIR=./data \
WP_URL=https://deine-seite.de WP_USER=claude WP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
npm start
```

---

© 2026 Code & Blocks by Marijan. MCP-Server: MIT-Lizenz. WordPress-Plugin: GPL-2.0-or-later.
