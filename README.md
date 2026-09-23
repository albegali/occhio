# HDMI Vision

Cattura su Mac lo stream di una capture card HDMI, lo mostra a schermo e ogni 30 secondi invia un fotogramma a Claude. L'analisi appare in tempo reale su una pagina dedicata, consultabile da qualsiasi dispositivo in rete.

| Pagina | Indirizzo | A cosa serve |
|---|---|---|
| Capture | `http://localhost:3000/` | Stream live + invio dei frame a Claude |
| Output | `http://<nome-mac>.local:3000/output` | Output dell'AI, aggiornato a ogni elaborazione |
| Admin | `http://localhost:3000/admin` | Prompt e parametri (protetta da password) |

## Requisiti

- macOS con Node.js 20 o superiore (`brew install node`)
- Capture card HDMI UVC (Elgato Cam Link, capture card USB 3.0 generiche, ecc.)
- Chrome, Edge o Safari aggiornati
- Una API key Anthropic: https://console.anthropic.com

## Installazione

```bash
npm install
cp .env.example .env
# modifica .env: ANTHROPIC_API_KEY e ADMIN_PASSWORD
npm start
```

Poi, sul Mac con la capture card:

1. Apri `http://localhost:3000/` e consenti l'accesso alla fotocamera. La capture card viene vista come una webcam.
2. Scegli la capture card dal menu dei dispositivi.
3. Premi **Avvia analisi**. Il primo frame parte subito, poi uno ogni 30 secondi.
4. Apri `/output` su un altro schermo, tablet o telefono della stessa rete.

> Se il browser non chiede il permesso: Impostazioni di Sistema → Privacy e sicurezza → Fotocamera → abilita il browser.

## Configurazione

Da `/admin` (utente qualsiasi, password = `ADMIN_PASSWORD`):

| Campo | Default | Note |
|---|---|---|
| System prompt | lettura di quiz su schermate scrollate, in italiano | Ruolo e regole del modello |
| Prompt di default | rispondi a ogni domanda visibile | Inviato insieme a ogni frame |
| Modello | `claude-haiku-4-5-20251001` | Il più economico; passa a `claude-sonnet-5` per analisi più ricche |
| Max token output | 1000 | Limita lunghezza e costo di ogni risposta |
| Intervallo (s) | 30 | Tempo tra un frame e il successivo |
| Larghezza immagine | 1280 px | Più bassa = meno token di input |
| Qualità JPEG | 0.7 | Incide sul peso del file, non sui token |

Le modifiche valgono dalla chiamata successiva, senza riavviare.

## Consumi indicativi

Un frame a 1280×720 costa circa 1.200 token di input, più prompt e risposta (max 1000). A 30 secondi fanno 120 chiamate l'ora. Per ridurre i costi, abbassa la larghezza dell'immagine (960 px ≈ 700 token), accorcia i prompt o allunga l'intervallo. Non si rimanda la conversazione al modello: si aggiunge solo l'elenco delle domande già elaborate, così scrollando quelle ancora visibili non vengono rielaborate.

## Sicurezza

- Solo il Mac stesso può inviare frame (`/api/frame` rifiuta richieste da altri host), quindi nessuno in rete può consumare i tuoi token.
- `/output` è in sola lettura e visibile a chiunque sia sulla stessa rete: non usarla su reti pubbliche.
- La API key resta in `.env` e non arriva mai al browser.

## Limiti noti

- Le sorgenti protette da HDCP (Netflix, alcune console, alcuni decoder) arrivano nere alla capture card: è una limitazione hardware, non dell'app.
- Nessun audio, nessuna registrazione, nessuno storico persistente (gli ultimi 10 risultati restano in memoria finché il server è attivo).
- La pagina Capture deve restare aperta e in primo piano: alcuni browser rallentano i timer delle schede in background.

## Sviluppo con Claude Code

Le specifiche sono in `AGENTS.md`, le istruzioni operative per Claude Code in `CLAUDE.md`. Per generare l'app:

```bash
claude "Implementa l'MVP seguendo CLAUDE.md"
```
