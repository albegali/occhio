# HDMI Vision

Cattura su Mac lo stream di una capture card HDMI, lo mostra a schermo e, quando lo chiedi, invia un fotogramma a Claude. Anteprima e risultati stanno nella stessa schermata; `/output` mostra gli stessi risultati su altri dispositivi in rete.

| Pagina | Indirizzo | A cosa serve |
|---|---|---|
| Capture + Output | `http://localhost:3000/` | Anteprima, controlli a hover e tabella domande/risposte |
| Output | `http://<nome-mac>.local:3000/output` | Output dell'AI, aggiornato a ogni elaborazione |
| Voce | `http://localhost:3000/voice` | Assistente vocale: ascolta l'audio e risponde subito alle domande orali |
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
# modifica .env: ANTHROPIC_API_KEY e ADMIN_PASSWORD (OPENAI_API_KEY opzionale, per il fallback)
npm start
```

Poi, sul Mac con la capture card:

1. Apri `http://localhost:3000/` e consenti l'accesso alla fotocamera. La capture card viene vista come una webcam.
2. Scegli la capture card dal menu dei dispositivi.
3. Tieni il mouse su **Avvia analisi** per 3 secondi: viene catturata la schermata corrente e analizzata. Per una nuova analisi esci con il mouse e rientra. Stesso meccanismo per **Riavvia stream**.
4. Apri `/output` su un altro schermo, tablet o telefono della stessa rete.

> Se il browser non chiede il permesso: Impostazioni di Sistema → Privacy e sicurezza → Fotocamera → abilita il browser.

### Assistente vocale (`/voice`)

1. Aggiungi `ASSEMBLYAI_API_KEY` al file `.env` e riavvia.
2. Apri `http://localhost:3000/voice` sul Mac, scegli l'ingresso audio (microfono o audio della capture card) e premi **Avvia ascolto**.
3. L'audio viene trascritto in tempo reale da AssemblyAI (modello `universal-3-6-pro`, supporta l'italiano). A ogni frase conclusa, Claude decide se contiene una domanda e, in caso affermativo, risponde in streaming: la risposta appare mentre viene generata. Le frasi senza domande vengono scartate.
4. Aperta da un altro dispositivo in LAN, `/voice` mostra le risposte in sola lettura (l'ascolto si avvia solo dal Mac).

Usa il modello e i max token impostati in admin; il prompt dell'assistente vocale è fisso in `server.js` (`VOICE_SYSTEM`). Funziona in Chrome, Edge e Safari (non in Firefox).

## Configurazione

Da `/admin` (utente qualsiasi, password = `ADMIN_PASSWORD`):

| Campo | Default | Note |
|---|---|---|
| System prompt | lettura di quiz su schermate scrollate, in italiano | Ruolo e regole del modello |
| Prompt di default | rispondi alla domanda | Inviato con il testo di ogni singola domanda |
| Modello | `claude-haiku-4-5-20251001` | Il più economico; passa a `claude-sonnet-5` per analisi più ricche |
| Modello di fallback | `gpt-5-mini` | Usato via API OpenAI se Claude non risponde (serve `OPENAI_API_KEY`) |
| Max token output | 1000 | Limita lunghezza e costo di ogni risposta |
| Larghezza immagine | 1280 px | Più bassa = meno token di input |
| Qualità JPEG | 0.7 | Incide sul peso del file, non sui token |

Le modifiche valgono dalla chiamata successiva, senza riavviare.

## Consumi indicativi

Ogni analisi fa una chiamata di estrazione con l'immagine (un frame a 1280×720 costa circa 1.200 token di input) che trascrive le domande visibili, formule comprese, e poi una chiamata solo testo per ciascuna domanda nuova (max 1000 token di risposta ciascuna). Le risposte appaiono sempre in ordine di numero di domanda. Per ridurre i costi, abbassa la larghezza dell'immagine (960 px ≈ 700 token), accorcia i prompt o analizza meno spesso. Non si rimanda la conversazione al modello: si aggiunge solo l'elenco delle domande già elaborate, così scrollando quelle ancora visibili non vengono rielaborate.

## Sicurezza

- Solo il Mac stesso può inviare frame (`/api/frame` rifiuta richieste da altri host), quindi nessuno in rete può consumare i tuoi token.
- `/output` è in sola lettura e visibile a chiunque sia sulla stessa rete: non usarla su reti pubbliche.
- La API key resta in `.env` e non arriva mai al browser.

## Limiti noti

- Le sorgenti protette da HDCP (Netflix, alcune console, alcuni decoder) arrivano nere alla capture card: è una limitazione hardware, non dell'app.
- Nessuna registrazione, nessuno storico persistente (gli ultimi 10 risultati restano in memoria finché il server è attivo).

## Sviluppo con Claude Code

Le specifiche sono in `AGENTS.md`, le istruzioni operative per Claude Code in `CLAUDE.md`. Per generare l'app:

```bash
claude "Implementa l'MVP seguendo CLAUDE.md"
```
