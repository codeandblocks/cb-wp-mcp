# Code & Blocks WordPress MCP

Selbst gehosteter MCP-Server für WordPress. Claude verwaltet damit Inhalte, Medien, Plugins, Themes, Page-Builder-Seiten, SEO-Felder, Plugin-Daten, Theme-Dateien, PHP-Snippets und Updates deiner WordPress-Seiten. Keine Aufruf-Limits, keine Fremdanbieter dazwischen.

Autor: **Code & Blocks by Marijan**

---

## Aufbau

```
Claude ──HTTPS──► MCP-Server (Coolify, Docker) ──REST API + Anwendungspasswort──► WordPress
                   ├─ /mcp     Endpunkt für Claude                               └─ Bridge-Plugin (cbmcp/v1)
                   └─ /admin   Verwaltungsoberfläche
```

- **MCP-Server** (`src/`): Node.js/TypeScript. `/mcp` für Claude, `/admin` für dich.
- **Bridge-Plugin** (`wordpress-plugin/code-blocks-mcp-bridge/`): Ein-Klick-Verbindung, Dateien, Meta-Felder, Datenbank, Cron, Vorschau-Links, Backups, Aktivitätsprotokoll, Live-Hinweise und Updates.
- **Skills** (`skills/`): Arbeitsanleitungen für Claude (Elementor, andere Page-Builder, Block-Themes, SEO-Plugins, Plugin-Daten, WooCommerce, sicherer Ablauf). Eigene Skills legst du in der Oberfläche an.

---

## Verwaltungsoberfläche (`/admin`)

Anmeldung mit dem `ADMIN_PASSWORD`.

| Bereich | Was du dort machst |
|---|---|
| Übersicht | Connector-Adresse kopieren, Status aller Seiten, offene Freigaben, letzte Aktivität |
| Seiten | Seiten per Klick verbinden, umbenennen, Standardseite festlegen, trennen (widerruft das Anwendungspasswort) |
| Freigaben | Riskante Aktionen von Claude prüfen und freigeben oder ablehnen |
| Aktivität | Jede Änderung mit Zeit, Seite und Ergebnis |
| Updates | Plugin-, Theme- und WordPress-Updates aller Seiten auf einen Blick, per Klick installieren |
| Skills | Mitgelieferte Skills ansehen, eigene schreiben |
| Einstellungen | Nur-Lesen-Modus, welche Aktionen eine Freigabe brauchen, Pexels-/Unsplash-Keys, Token für Claude Code, Claude-Sitzungen abmelden |

Zugangsdaten der Seiten und API-Keys liegen AES-256-GCM-verschlüsselt in `/data/store.json`. Der Schlüssel liegt in `/data/secret.key` (oder kommt aus `SECRET_KEY`).

### Freigaben

Ist eine Aktion freigabepflichtig (z. B. Theme wechseln, Entwurfskopie live schalten, Plugins installieren, SQL schreiben), passiert Folgendes:

1. Claude ruft das Tool auf. Der Server legt eine Freigabe an und meldet sie zusätzlich als Hinweis in wp-admin.
2. Der Server wartet bis zu 40 Sekunden (`APPROVAL_WAIT_SECONDS`) auf deine Entscheidung unter **Freigaben**.
3. Gibst du in dieser Zeit frei, läuft die Aktion sofort. Sonst bekommt Claude den Link und wiederholt den Aufruf, sobald du im Chat Bescheid gibst.

Jede Freigabe gilt genau einmal und nur für exakt diese Parameter.

---

## WordPress-Plugin

Das Plugin `code-blocks-mcp-bridge.zip` unter **Plugins → Installieren → Plugin hochladen** installieren und aktivieren. Danach gibt es im Menü **Code & Blocks MCP** mit diesen Reitern:

- **Verbindung**: Server-Adresse eintragen, „Mit MCP-Server verbinden“, Status (wann zuletzt benutzt, von welcher IP), Verbindung trennen
- **Sicherheit**: Schalter für Dateien bearbeiten, PHP-Snippets, Datenbank schreiben, Notfallmodus, Live-Hinweise
- **Aktivität**: Was Claude geändert hat, mit Links zum Ansehen und Bearbeiten
- **Snippets**: Code ansehen, aktivieren, deaktivieren, löschen
- **Backups**: Frühere Stände von Dateien und Meta-Feldern wiederherstellen

Live-Hinweise erscheinen für Administratoren unten rechts im Backend und in der Admin-Leiste („Claude“ mit Zähler).

Die Schalter lassen sich weiterhin per `wp-config.php` festnageln. Dann sind sie im Plugin gesperrt:

```php
define( 'CBMCP_DISABLE_FILE_WRITE', true );
define( 'CBMCP_DISABLE_SNIPPETS', true );
define( 'CBMCP_SAFE_MODE', true );
define( 'CBMCP_ALLOW_DB_WRITE', true );
```

---

## Installation

### 1. Code in ein Git-Repository

Coolify baut aus einem Git-Repository, z. B. einem öffentlichen GitHub-Repo. Der Code enthält keine Passwörter.

```bash
git init
git add .
git commit -m "Code & Blocks WordPress MCP"
git branch -M main
git remote add origin https://github.com/DEIN-NAME/cb-wp-mcp.git
git push -u origin main
```

### 2. In Coolify deployen

1. **+ New → Application**, Repository wählen, **Build Pack: Dockerfile**, **Port 3000**.
2. **Domain** setzen, z. B. `https://wp-mcp.deinedomain.de` (DNS-A-Record auf den Server).
3. **Environment Variables**:

   | Variable | Wert |
   |---|---|
   | `PUBLIC_URL` | `https://wp-mcp.deinedomain.de` |
   | `ADMIN_PASSWORD` | langes Passwort (mind. 12 Zeichen) für `/admin` und die Anmeldung aus Claude |

   Mehr braucht es nicht. Seiten, API-Keys und Tokens verwaltest du in der Oberfläche.

4. **Persistent Storage**: Volume mit Mount-Pfad **`/data`**. Ohne Volume gehen Seiten und Anmeldungen bei jedem Deploy verloren.
5. **Healthcheck**: Pfad `/health`, Host **`127.0.0.1`**, Port 3000. Mit `localhost` schlägt der Check fehl, weil der Container dabei IPv6 versucht.
6. **Deploy**, dann `https://wp-mcp.deinedomain.de/health` aufrufen.

### 3. Seite verbinden

Im WordPress-Plugin unter **Code & Blocks MCP → Verbindung** die Server-Adresse eintragen und **Mit MCP-Server verbinden** klicken. Alternativ in `/admin` unter **Seiten** die Adresse eingeben. In beiden Fällen bestätigst du die Freigabe in WordPress. Das Anwendungspasswort landet direkt verschlüsselt auf deinem Server.

### 4. Mit Claude verbinden

**Claude (Web, Desktop, Mobil):** In den Einstellungen unter Connectors einen eigenen Connector mit `https://wp-mcp.deinedomain.de/mcp` anlegen. Bei der Anmeldung das `ADMIN_PASSWORD` eingeben.

**Claude Code:** In `/admin` unter Einstellungen einen Token erzeugen, dann:

```bash
claude mcp add --transport http wordpress https://wp-mcp.deinedomain.de/mcp \
  --header "Authorization: Bearer DEIN_TOKEN"
```

---

## Tools

| Bereich | Tools |
|---|---|
| Seiten | `list_sites`, `site_info`, `site_settings` |
| Inhalte | `list_content_types`, `list_content`, `get_content`, `create_content`, `update_content`, `delete_content` |
| Taxonomien | `list_terms`, `manage_term` |
| Medien | `list_media`, `upload_media`, `search_images` (Pexels, Unsplash) |
| Plugins & Themes | `list_plugins`, `manage_plugin`, `list_themes`, `manage_updates` (alle Seiten) |
| Allgemein | `rest_request`, `fetch_page`, `audit_page`, `list_abilities`, `run_ability` |
| Skills | `skill_list`, `skill_load`, `skill_save`, `skill_delete` |
| Bridge: Dateien | `file_list`, `file_read`, `file_write`, `file_edit`, `file_delete`, `file_search`, `file_restore` |
| Bridge: Daten | `manage_meta`, `db_schema`, `db_query`, `manage_option` |
| Bridge: Entwürfe | `duplicate_content`, `apply_copy`, `create_preview`, `copy_theme`, `create_child_theme`, `activate_theme` |
| Bridge: Betrieb | `manage_snippet`, `manage_cron`, `send_test_email`, `flush_cache` |

Neue Beiträge und Seiten entstehen standardmäßig als Entwurf.

### Sicherer Ablauf für Live-Seiten

1. `duplicate_content` legt eine Entwurfskopie mit allen Page-Builder-Daten an und liefert einen Vorschau-Link ohne Login.
2. Claude ändert die Kopie und prüft sie mit `audit_page`.
3. Du schaust dir die Vorschau an.
4. `apply_copy` überträgt die Kopie aufs Original. Vorher entsteht ein Backup-Entwurf des Originals.

---

## Weitere Umgebungsvariablen (optional)

| Variable | Zweck |
|---|---|
| `MCP_TOKEN` | Fester Token zusätzlich zu dem aus der Oberfläche |
| `SECRET_KEY` | Eigener Schlüssel für die Verschlüsselung statt `/data/secret.key` |
| `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`, `WP_SITES` | Seiten per Variable. Werden beim Start einmalig in die Oberfläche übernommen |
| `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` | Bild-Keys, falls nicht in der Oberfläche gesetzt |
| `READ_ONLY` | `true` erzwingt den Nur-Lesen-Modus |
| `APPROVAL_WAIT_SECONDS` | Wie lange ein Tool auf deine Freigabe wartet (Standard 40) |
| `ALLOW_TOKEN_IN_URL` | `true` erlaubt `/mcp/<MCP_TOKEN>` als Notlösung |
| `MAX_UPLOAD_MB`, `MAX_OUTPUT_CHARS`, `ACCESS_TOKEN_TTL_HOURS`, `REFRESH_TOKEN_TTL_DAYS`, `TRUST_PROXY`, `ALLOW_PRIVATE_FETCH` | Feineinstellungen |

---

## Stockbilder

**Pexels:** Konto anlegen, auf https://www.pexels.com/api/ einen Key anfordern. Kostenlos, 200 Anfragen pro Stunde, 20.000 pro Monat.

**Unsplash:** Auf https://unsplash.com/developers registrieren, unter „Your apps“ eine Application anlegen, den **Access Key** verwenden. Im Demo-Modus 50 Anfragen pro Stunde.

Beide Keys trägst du in `/admin` unter Einstellungen ein. `search_images` liefert fertige Bildunterschriften mit Nennung von Fotograf und Plattform. Bei Unsplash wird der vorgeschriebene Download-Zähler automatisch ausgelöst.

---

## Sicherheit

- Ohne `ADMIN_PASSWORD` oder `MCP_TOKEN` startet der Server nicht.
- Anmeldeversuche sind begrenzt (10 pro 15 Minuten und IP).
- Formulare der Oberfläche sind gegen CSRF geschützt, Sitzungen laufen nach 12 Stunden ab.
- Tokens werden nur als SHA-256-Hash gespeichert, Seiten-Passwörter und API-Keys verschlüsselt.
- Verbinden geht nur mit Bestätigung in WordPress. Rückleitungen sind nur auf die verbundene Seite erlaubt.
- `upload_media` lädt nichts von internen Adressen. `fetch_page` und `audit_page` rufen nur verbundene Seiten ab.
- Das Bridge-Plugin
  - lässt nur Administratoren zu,
  - beschränkt Dateien auf `themes`, `plugins`, `mu-plugins` und `languages`,
  - prüft PHP und JSON vor dem Speichern,
  - sichert Dateien und Meta-Felder vor jeder Änderung,
  - schaltet fehlerhafte Snippets automatisch ab,
  - erlaubt SQL standardmäßig nur lesend,
  - kann sich selbst nicht verändern.

---

## Fehlerbehebung

**401 „rest_not_logged_in“**
Manche Apache-Hoster entfernen den `Authorization`-Header. In der `.htaccess` oberhalb von `# BEGIN WordPress`:

```apache
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```

**„Anwendungspasswörter sind deaktiviert“ beim Verbinden**
Ein Sicherheits-Plugin blockiert sie (z. B. Wordfence, Solid Security, 2FA-Plugins). Dort Anwendungspasswörter erlauben.

**403 von Cloudflare oder einer Firewall**
Die IP des Servers freigeben oder den User-Agent `CodeBlocks-WP-MCP` erlauben.

**Seite nach einem Snippet kaputt**
Fehlerhafte Snippets schalten sich beim nächsten Aufruf selbst ab. Sonst im Plugin den Notfallmodus aktivieren oder `define( 'CBMCP_SAFE_MODE', true );` in die `wp-config.php` schreiben.

**Theme-Vorschau bleibt im eigenen Browser hängen**
Die Vorschau setzt das Cookie `cbmcp_preview` bis zum Schließen des Browsers. Privates Fenster nutzen oder das Cookie löschen.

**Updates schlagen fehl**
WordPress muss Dateien direkt schreiben können (`FS_METHOD` = `direct`). Die Updates-Seite zeigt, wenn das nicht der Fall ist.

---

## Lokal entwickeln

```bash
npm install
npm run build
PUBLIC_URL=http://localhost:3000 ADMIN_PASSWORD=lokales-passwort DATA_DIR=./data npm start
```

---

© 2026 Code & Blocks by Marijan. MCP-Server: MIT-Lizenz. WordPress-Plugin: GPL-2.0-or-later.
