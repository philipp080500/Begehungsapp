# Begehungs-App

Browser-App für Arbeitsschutz-Begehungen – Punkte schnell erfassen (Text, Diktat, Foto), optional mit KI zu einem formellen Befund inkl. Risikoeinstufung und Maßnahmenvorschlag aufwerten, und am Ende als PDF-Protokoll exportieren.

## Starten

Doppelklick auf **`Begehungs-App starten.bat`**. Das öffnet die App im Standardbrowser unter `http://localhost:5321`.

Kein `npm install`, keine Installation – das Skript nutzt nur in Windows enthaltene Bordmittel (PowerShell), um die Datei lokal bereitzustellen. Das ist nötig, damit Spracheingabe und der KI-Abruf zuverlässig funktionieren (Browser verlangen dafür einen "sicheren Kontext", den ein reines Doppelklick-Öffnen der `index.html` nicht immer erfüllt).

Zum Beenden des lokalen Servers einfach das zugehörige (versteckte) PowerShell-Fenster über den Task-Manager beenden, oder den PC/die Sitzung neu starten.

## Daten & Datenschutz

- Alle Begehungen, Punkte und Fotos werden **ausschließlich lokal im Browser** gespeichert (IndexedDB). Es gibt keinen eigenen Server, der Daten sammelt.
- Nutzt du die KI-Aufwertung, werden **nur die Stichpunkte des jeweiligen Punkts** (Kategorie, Standort, Notiz) an den gewählten Anbieter (Anthropic oder OpenAI) gesendet – keine Fotos, keine anderen Begehungsdaten.
- Der API-Key wird nur lokal im Browser (`localStorage`) gespeichert.

## KI-Anbindung einrichten

1. Zahnrad-Symbol oben rechts klicken.
2. Anbieter wählen (Anthropic oder OpenAI), Modellnamen und eigenen API-Key eintragen.
3. Ohne API-Key funktioniert die App weiterhin komplett manuell – der Button "Mit KI aufwerten" übernimmt dann einfach deine Notiz unverändert in das Befund-Feld.

## Unternehmen verwalten

Im Reiter **"Unternehmen"** (oben neben "Begehungen") kannst du beliebig viele Unternehmen anlegen: Name, Adresse, Ansprechpartner, Kontakt und ein eigenes Logo pro Unternehmen.

Bei jeder Begehung kannst du im Feld "Unternehmen" eines davon auswählen. Das PDF-Protokoll übernimmt dann automatisch dessen Logo (statt des globalen `logo.jpg`), Namen, Adresse und Ansprechpartner in der Kopfzeile – ohne die Daten erneut eintippen zu müssen. Ohne Auswahl ("— Kein Unternehmen / manuell —") funktioniert die App wie zuvor mit freier Texteingabe.

## Ablauf einer Begehung

1. "Neue Begehung starten", Unternehmen auswählen (optional) sowie Datum/Begeher eintragen.
2. Pro Mangel: Kategorie + Standort wählen, Notiz eintippen oder per Mikrofon diktieren, Foto(s) hinzufügen.
3. Optional "Mit KI aufwerten" – Befund, Risiko, Maßnahme und Frist werden vorgeschlagen und bleiben editierbar.
4. "Punkt hinzufügen", so oft wie nötig wiederholen.
5. Am Ende "PDF-Protokoll erstellen" – die PDF wird direkt heruntergeladen.

## Browser-Hinweise

- Spracheingabe funktioniert am besten in Chrome/Edge.
- Für die Kamera-Aufnahme öffnet sich auf Mobilgeräten die native Kamera-App (über den Datei-Auswahl-Dialog).

## Logo

Die Datei `logo.jpg` im Hauptordner wird automatisch in die Kopfzeile des PDF-Protokolls eingebunden. Zum Austauschen einfach eine andere Bilddatei unter demselben Namen `logo.jpg` ablegen (Seitenverhältnis wird automatisch übernommen). Fehlt die Datei, wird das PDF trotzdem ohne Logo erstellt.
