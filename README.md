# Summitline City Roleplay – Teamzentrale

**Fertige, deutschsprachige Team- und Aufgabenverwaltung** mit echten Accounts, Datenbank, Rechteprüfung, Einladungen, gemeinsamem Aufgabenboard, drei Schichten, Kommentaren, Uploads und Hell-/Dunkelmodus.

Die Website ist eine eigenständig lauffähige **Node.js-Anwendung mit SQLite-Datenbank**. **Du benötigst weder Supabase noch Vercel**, wenn du sie auf deinem eigenen Windows- oder Linux-Server hostest. Auf Vercel mit flüchtigem Dateisystem kann diese Variante **nicht** unverändert betrieben werden. 

## 1. Installation (Windows-Rootserver)

1. Installiere **Node.js 22.13 oder neuer** (am besten eine aktuelle LTS-Ausgabe): <https://nodejs.org/>.
2. Entpacke die ZIP-Datei, beispielsweise nach `C:\Summitline-Teamzentrale`.
3. Kopiere `.env.example` im Projektordner und benenne die Kopie in `.env` um. Unter Windows im Explorer ggf. „Dateinamenerweiterungen“ aktivieren.
4. Öffne `.env` mit dem Editor. Bei `OWNER_EMAIL=` muss **deine eigene Admin-E-Mail-Adresse** eingetragen sein. Die Beispieladresse kannst du ändern.
5. Starte `start-windows.bat` per Doppelklick **oder** öffne im Ordner ein Terminal und führe `node server.js` aus.
6. Öffne im Browser **http://localhost:3000**. Beim ersten Start wird in der Serverkonsole ein **geheimer Startcode** angezeigt (wenn `OWNER_SETUP_TOKEN` in `.env` leer ist). Gib deine Eigentümer-E-Mail, deinen gewünschten Anzeigenamen, ein selbstgewähltes Passwort (mindestens 12 Zeichen) und den Startcode ein.
7. Fertig: Du bist der unveränderliche Hauptadministrator. Danach erscheint die normale Anmeldung, und die Ersteinrichtung kann nicht wiederholt werden.

**Wichtig:** Du gibst dein Passwort **nur auf deiner eigenen Website** ein, niemals hier im Chat. Der Startcode ist streng geheim und muss nicht an Mitarbeiter weitergegeben werden. Wenn du den Server nach erfolgter Einrichtung neu startest, bleibt dein Account in der Datenbank bestehen.

## 2. Funktionen

- **Accounts:** E-Mail, selbstgewähltes Passwort; Passwort wird mit scrypt und zufälligem Salt gehasht.
- **Erste Einrichtung:** Eigentümer-E-Mail + geheimer Startcode; der erste Account wird automatisch Hauptadministrator.
- **Mitglieder:** Nur einmalige, zeitlich befristete Einladungscodes erlauben neue Accounts. Optional kann ein Code an eine E-Mail-Adresse gebunden sein.
- **Rollen:** Projektinhaber, STV-Projektinhaber, Projektleitung, STV-Projektleitung, Management, STV-Management, Teamleitung, STV-Teamleitung, Head-Admin, Admin, Test Admin, Mitglied.
- **Administration:** Individuelle Berechtigungen und Administratorstatus unabhängig von der Teamrolle; Konten bearbeiten und sperren. Die Verwaltung wird **auch auf dem Server** geprüft.
- **Aufgaben:** Gemeinsames Board mit Nicht zugeteilt, Zu erledigen, In Bearbeitung, Im Test, Erledigt; mehrere Projekte, Priorität, Beschreibung, Zuständigkeit, Fälligkeitsdatum sowie Früh-, Spät- und Nachtschicht.
- **Regel:** Ohne Mitarbeiter **oder** ohne Schicht bleibt eine Aufgabe bei „Nicht zugeteilt“.
- **Teamarbeit:** Kommentare, Uploads bis 5 MB (PNG/JPG/WEBP/PDF/TXT/DOCX/XLSX/ZIP), Bearbeitungsverlauf, persönliche Benachrichtigungen.
- **Synchronisation:** SQLite speichert serverseitig. Andere angemeldete Browser erhalten beim manuellen Aktualisieren oder automatisch etwa alle 25 Sekunden neue Daten. **Kein echtes WebSocket-Live-Push**.
- **Design:** Responsiv, komplett deutsch, dunkles und helles Design.

## 3. Teammitglieder einladen

1. Als Hauptadministrator auf **Einladungen → Einladung erstellen** klicken.
2. Optional die E-Mail-Adresse des Mitarbeiters eintragen, Rolle und Gültigkeit festlegen.
3. Den angezeigten Code kopieren. Achtung: Der Code ist danach **nicht erneut abrufbar**.
4. Mitarbeiter öffnet deine Website → **Account erstellen** → Code, Namen, E-Mail und eigenes Passwort eingeben.
5. Als Hauptadministrator unter **Administration** einzelne Berechtigungen oder den Administratorzugang aktivieren.

**Hinweis:** In dieser Version werden E-Mail-Adressen nicht automatisch durch eine Bestätigungs-Mail verifiziert. Für besonders vertrauliche Projekte ist die Bindung der Einladung an eine bekannte E-Mail-Adresse und die Weitergabe über einen privaten Kanal wichtig.

## 4. Online veröffentlichen

Damit andere aus dem Internet zugreifen können, muss der Node-Prozess dauerhaft auf deinem Server laufen und eine öffentliche Domain mit HTTPS darauf zeigen.

**Empfohlen:** Eine Domain, ein Reverse Proxy (zum Beispiel Caddy oder Nginx) und ein gültiges TLS-Zertifikat. Beispiel für eine Caddy-Konfiguration:

```caddyfile
team.deinedomain.de {
    reverse_proxy 127.0.0.1:3000
}
```

- `team.deinedomain.de` durch deine eigene Domain ersetzen; DNS-A-Record auf die öffentliche Server-IP setzen.
- Ports 80 und 443 der Firewall für den Reverse Proxy freigeben. **Port 3000 nicht direkt öffentlich freigeben**, wenn der Proxy auf demselben Server läuft.
- In `.env` dann `HOST=127.0.0.1` und `SECURE_COOKIES=true` setzen; danach Node-Prozess neu starten.
- Für dauerhaftes Hosting unter Windows einen Prozessmanager oder Windows-Dienst mit automatischem Neustart einrichten. Das Batch-Skript ist nur zum manuellen Start gedacht.
- **Nur mit HTTPS öffentlich verwenden!** Plain HTTP über das Internet überträgt Anmeldedaten ungeschützt.

Diese ZIP kann **nicht selbst** eine Domain reservieren, einen Internetserver bereitstellen oder die Ports deines Windows-Servers ändern. Dazu musst du die beschriebenen Einstellungen auf deinem eigenen Server ausführen.

## 5. Sicherung & Wartung

- Die Datenbank liegt in `data/summitline.sqlite`, Dateianhänge unter `data/uploads/`.
- **Backups:** Server sicher stoppen und danach die gesamte `data/`-Ordnerstruktur sichern. SQLite arbeitet mit WAL, deshalb beim laufenden Server nicht einfach nur die einzelne `.sqlite`-Datei kopieren. Besser die SQLite-Online-Backup-API verwenden, falls Sicherungen ohne Abschaltung erforderlich sind.
- `.env`, die SQLite-Datenbank und die Anhänge **nie in ein öffentliches GitHub-Repository laden**.
- Löschen eines Mitglieds mit Aufgaben-/Kommentarhistorie wird bewusst blockiert: Solche Mitglieder stattdessen sperren.
- Passwörter können in **Einstellungen → Passwort ändern** aktualisiert werden; danach wird man aus allen Sitzungen abgemeldet.
- Updates und Sicherheitsupdates für Node.js einspielen.

## 6. Entwicklung & Tests

Voraussetzung: Node.js >= 22.13. Für den Start ist **kein npm install** erforderlich (keine Fremdpakete).

```bash
npm start
npm test
```

Die automatisierten Tests legen Datenbank und Konten in einem temporären Verzeichnis an. Es werden keine echten Accounts verändert.

### Konfigurationsdatei

`.env.example` enthält die wichtigsten Felder:

| Variable | Bedeutung |
|---|---|
| `OWNER_EMAIL` | E-Mail des unveränderlichen Hauptadministrators bei der ersten Einrichtung |
| `OWNER_SETUP_TOKEN` | Optionaler fester geheime Startcode, mindestens 24 Zeichen; bei Leerfeld Ausgabe des zufälligen Codes in der Serverkonsole |
| `PORT` | HTTP-Port, Standard `3000` |
| `HOST` | Listener; lokal/Reverse Proxy `127.0.0.1`, ansonsten `0.0.0.0` |
| `SECURE_COOKIES` | Bei HTTPS unbedingt `true` |

## 7. Architektur

`server.js` enthält REST-API, Authentifizierung, SQLite, Passwort-Hashing, Rechte, Validierung, Uploads und Sicherheitsheaders. `public/` enthält die Oberfläche, vollständig ohne Build-Schritt. `tests/` enthält die API-Integrationstests. Die hochgeladene Vite-Demoversion wurde durch diese Serverversion ersetzt, weil `localStorage` alleine keine echten gemeinsamen Accounts ermöglicht.
