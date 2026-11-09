# Changelog

Code & Blocks WordPress MCP · Code & Blocks by Marijan

## 1.3.1

Sicherheitsupdate. Plugin bleibt bei 1.3.0.

- **Schutz vor internen Adressen (SSRF):** Alle ausgehenden Anfragen sperren localhost, private Netze, Docker-Netz und Cloud-Metadaten beim Verbindungsaufbau (auch bei DNS-Rebinding). Weiterleitungen von WordPress-Seiten nur auf denselben Host, kein Wechsel von https auf http. `http://`-Seiten nur noch mit `ALLOW_PRIVATE_FETCH=true`.
- **Verbinden mit Code:** Bestätigungsseite mit Zielkonto. Ohne Bestätigung im selben Browser geht es nicht weiter.
- **Freigaben:** Freie REST-Anfragen mit Schreibzugriff (POST, PUT, PATCH, DELETE) sind freigabepflichtig. Damit lassen sich die anderen Freigaben nicht mehr über `rest_request` umgehen. Wird bei bestehenden Konten automatisch aktiviert.
- **Datenschutz:** Sperre für personenbezogene Daten erweitert (`_embed`, Mitglieder-, Abo-, Buchungs- und Formular-Endpunkte, Abilities, Tabellen aus der SQL-Abfrage statt Textsuche, `menu_order` löst nicht mehr fälschlich aus). Dokumentiert als bestmöglich.
- **Betreiber-Ansicht:** Kundenbereiche sind für den Betreiber nur lesend.
- **Tokens:** feste Tokens laufen ab (30 bis 365 Tage) und zeigen, wann sie zuletzt benutzt wurden. Bestehende bekommen 365 Tage.
- **Schlüssel:** `SECRET_KEY` akzeptiert den Inhalt von `secret.key` (64 Hex-Zeichen). Anleitung und Statusanzeige auf der Seite Sicherheit. Warnung beim Start, wenn `SECRET_KEY` und `secret.key` nicht zusammenpassen.
- **Zwei-Faktor:** Schutz gegen doppelt verwendete Codes bleibt über Neustarts erhalten.
- **Performance:** Einstellungen und Grenzen werden pro Anfrage nur einmal gelesen.
- **Tests:** 32 statt 13 (Schutz vor internen Adressen, Bestätigung, Freigaben, Datenschutz-Sperre, Betreiber-Ansicht).

## 1.3.0

Kundenbereiche, Anmeldung mit WordPress, Pseudonymisierung, Löschfristen, Export und Löschung, Zugriffsprotokoll, Zwei-Faktor für den Betreiber, Umstieg auf SQLite.

## 1.2.0

Verwaltungsoberfläche, Ein-Klick-Verbindung, Freigaben, Aktivitätsprotokoll, Updates.

## 1.1.0

Meta-Felder, Datenbank, Abilities, Cron, Test-Mail, Entwurfskopien, Vorschau-Links, Seiten-Audit, Skills, Stockbilder.

## 1.0.0

Erste Version.
