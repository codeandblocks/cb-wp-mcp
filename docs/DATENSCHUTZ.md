# Datenschutz: Code & Blocks WordPress MCP

Autor: Code & Blocks by Marijan · Stand: Version 1.3

Diese Beschreibung dient als Grundlage für den Auftragsverarbeitungsvertrag (Art. 28 DSGVO) mit Kunden und für das Verzeichnis der Verarbeitungstätigkeiten (Art. 30 Abs. 2 DSGVO). Sie ersetzt keine Rechtsberatung. Vertragstexte bitte rechtlich prüfen lassen.

---

## 1. Rollen

| Beteiligter | Rolle |
|---|---|
| Kunde (Betreiber der WordPress-Seite) | Verantwortlicher für die Daten seiner Seite |
| Code & Blocks (Betreiber des MCP-Servers) | Auftragsverarbeiter: stellt den Server bereit, der zwischen der KI des Kunden und seiner Seite vermittelt |
| Hosting-Anbieter des Servers | Unterauftragsverarbeiter von Code & Blocks |
| KI-Anbieter des Kunden (z. B. Anthropic für Claude) | **kein** Unterauftragsverarbeiter von Code & Blocks. Der Kunde wählt seine KI selbst und schließt den Vertrag mit dem KI-Anbieter selbst ab. |

Hinweis für Kunden: Daten, die die KI über den Server liest, gehen an den KI-Anbieter des Kunden. Für Kundenarbeit mit Claude ist ein Tarif mit Auftragsverarbeitungsvertrag nötig (kommerzielle Produkte wie Team, Enterprise oder API). Free und Pro gelten als Verbraucherprodukte.

---

## 2. Welche Daten der Server speichert

| Daten | Zweck | Schutz | Frist |
|---|---|---|---|
| Name des Kundenkontos, ID | Zuordnung | – | bis zur Löschung des Kontos |
| Adresse und Name der Seite, WordPress-Benutzername der Verbindung | Zugriff auf die Seite | – | bis zum Trennen der Seite |
| Anwendungspasswort der Seite | Zugriff auf die Seite | AES-256-GCM | bis zum Trennen, wird dann in WordPress widerrufen |
| Pexels-/Unsplash-Key des Kunden | Bildsuche | AES-256-GCM | bis der Kunde ihn löscht |
| Tokens für KI-Clients | Anmeldung der KI | nur SHA-256-Hash | Zugriff 7 Tage, Erneuerung 180 Tage (einstellbar), feste Tokens bis zum Löschen |
| Registrierte KI-Clients (Name, Rückleitungsadresse) | OAuth | – | solange genutzt |
| Aktivitätsprotokoll (Zeit, Seite, Aktion, Objekt-ID, Titel, Ergebnis, wer) | Nachvollziehbarkeit für den Kunden | ohne Inhalte, Empfänger und SQL-Werte | 30, 90, 180 oder 365 Tage (Kunde wählt, Standard 90) |
| Freigaben (Aktion und Parameter) | Bestätigung riskanter Aktionen | Parameter AES-256-GCM | 30 Tage |
| Platzhalter-Zuordnung (Originalwert zu `[[pii:…]]`) | Pseudonymisierung | AES-256-GCM, pro Kunde | 24 Stunden |
| Zugriffsprotokoll (Zeit, wer, was, IP-Adresse) | Sicherheit, Nachweis von Zugriffen | – | 365 Tage |
| Löschnachweis (Kontoname, ID, Zeitpunkt) | Nachweis der Löschung | – | dauerhaft |
| Container-Logs (Tool-Name, Seite, Dauer, Fehler) | Betrieb | ohne Inhalte | Rotation durch Coolify/Docker |

Inhalte der Seiten (Beiträge, Kommentare, Bestellungen, Formulardaten …) werden **nicht** gespeichert. Sie laufen nur im Moment der Anfrage durch den Server zur KI des Kunden.

Daten im WordPress-Plugin (Backups von Dateien und Meta-Feldern, Aktivität, Snippets) liegen auf dem Server des Kunden und unterliegen seiner Verantwortung.

---

## 3. Schutz personenbezogener Daten auf dem Weg zur KI

1. **Pseudonymisierung (Standard: an):** E-Mail-Adressen, Telefonnummern und IP-Adressen in Antworten an die KI werden durch Platzhalter ersetzt. Schreibt die KI einen Platzhalter zurück, setzt der Server den Originalwert wieder ein. Ausgenommen sind Code-Dateien (Themes, Plugins, Snippets). Die Erkennung arbeitet mit Mustern und erkennt nicht jede Schreibweise.
2. **Sperre (Standard: gesperrt):** Benutzerlisten, Kommentare, WooCommerce-Bestellungen und -Kunden, Formulareinträge und ähnliche Tabellen sind für die KI gesperrt, bis der Kunde sie im Portal freigibt.
3. **Grenzen und Freigaben:** Der Betreiber kann Werkzeuge pro Kunde sperren oder „Nur lesen“ erzwingen. Der Kunde legt fest, welche Aktionen erst nach seiner Bestätigung ausgeführt werden.

---

## 4. Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

**Vertraulichkeit**
- Transportverschlüsselung: HTTPS (Let's Encrypt über Coolify/Traefik), Anwendungspasswörter funktionieren nur über HTTPS.
- Verschlüsselung gespeicherter Zugangsdaten und Keys mit AES-256-GCM. Der Schlüssel liegt getrennt in `secret.key` oder in `SECRET_KEY`.
- Trennung der Kunden: Jede Anfrage ist an genau ein Kundenkonto gebunden. Automatische Tests prüfen das bei jeder Änderung.
- Zugriff der Kunden nur mit ihrem WordPress-Administratorkonto. Einmal-Codes (2 Minuten), an den Browser gebunden, Einlösung nur über die authentifizierte Serververbindung.
- Betreiber-Zugang mit Passwort und Zwei-Faktor-Anmeldung (TOTP).
- Begrenzung von Anmeldeversuchen (10 pro 15 Minuten und IP-Adresse), Schutz vor gefälschten Formularen (CSRF), Sitzungen enden nach 12 Stunden.
- Der Server lädt keine Dateien von internen Adressen (Schutz vor SSRF).

**Integrität**
- Vor jeder Änderung an Dateien und Meta-Feldern legt das Plugin ein Backup an. PHP- und JSON-Dateien werden vor dem Speichern geprüft.
- Aktivitäts- und Zugriffsprotokoll.

**Verfügbarkeit und Belastbarkeit**
- Container mit Healthcheck und automatischem Neustart.
- Sicherung des Volumes `/data` (vom Betreiber einzurichten, z. B. Volume-Sicherung in Coolify, verschlüsselt und an einem anderen Ort).

**Verfahren zur Überprüfung**
- Automatische Tests für Kundentrennung, Pseudonymisierung und Löschung (`npm test`).
- Regelmäßige Updates der Abhängigkeiten (`npm audit`) und des Basis-Images.

---

## 5. Rechte der Betroffenen und Vertragsende

- **Auskunft und Export:** Der Kunde exportiert alle zu seinem Konto gespeicherten Daten im Portal (Datenschutz → Daten exportieren).
- **Löschung:** Der Kunde löscht sein Konto im Portal oder der Betreiber löscht es. Dabei werden die Anwendungspasswörter in WordPress widerrufen und alle Daten des Kontos sofort entfernt. Es entsteht eine Löschbestätigung zum Ausdrucken. Einträge im Zugriffsprotokoll laufen nach ihrer Frist ab. In Sicherungen von `/data` bleiben Daten bis zum Ablauf der Sicherungsfrist.
- **Transparenz:** Der Kunde sieht im Portal jeden Zugriff des Betreibers auf sein Konto.

---

## 6. Offene Punkte für den Betreiber

- [ ] Standort und Auftragsverarbeitungsvertrag des Hosting-Anbieters prüfen. Am einfachsten: Server in der EU bei einem EU-Anbieter.
- [ ] Auftragsverarbeitungsvertrag mit jedem Kunden abschließen und diese Beschreibung als Anlage verwenden.
- [ ] Liste der Unterauftragsverarbeiter pflegen (aktuell nur der Hosting-Anbieter).
- [ ] Verzeichnis der Verarbeitungstätigkeiten als Auftragsverarbeiter führen.
- [ ] Ablauf für Datenpannen festlegen: Kunde unverzüglich informieren (er hat 72 Stunden für die Meldung an die Behörde).
- [ ] Sicherung von `/data` einrichten und Wiederherstellung testen.
- [ ] Zwei-Faktor-Anmeldung für den Betreiber aktivieren.
- [ ] Hinweis an Kunden: Datenschutzerklärung der Seite um Betreuung durch Dienstleister und Einsatz von KI-Werkzeugen ergänzen. Für die eigene KI einen Tarif mit Auftragsverarbeitungsvertrag nutzen.
