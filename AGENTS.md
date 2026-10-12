# AGENTS.md — HDMI Vision

Regole per qualsiasi agente di coding che lavora su questo repo. Sono la fonte di verità: `CLAUDE.md` le importa.

## Cosa stiamo costruendo

App locale per un Mac che riceve il video di una **capture card HDMI** (dispositivo UVC, visto dal browser come una webcam).

- **Pagina Capture** (`/`): mostra lo stream live. Ogni `intervalSec` secondi (default **30**) cattura un fotogramma e lo invia a Claude con un system prompt e un prompt di default.
- **Pagina Output** (`/output`): indirizzo dedicato, raggiungibile anche da altri dispositivi in LAN. Mostra l'output dell'AI e si aggiorna da sola a ogni nuova elaborazione.
- **Pagina Admin** (`/admin`): protetta da password. Modifica system prompt, prompt di default e parametri.

## Stack (non negoziabile per l'MVP)

- Node.js ≥ 20, ES modules, **nessun build step**.
- Dipendenze runtime ammesse: `express`, `@anthropic-ai/sdk`, `katex` (servito da `/katex` per le formule in capture e output). Nient'altro senza chiederlo.
- Frontend: HTML + JS vanilla inline, nessun framework, nessuna libreria CDN.
- Persistenza: un file `config.json`. Nessun database.
- Aggiornamenti live: Server-Sent Events (SSE). Niente WebSocket.

## Struttura dei file

```
server.js            # tutto il backend (~200 righe)
public/capture.html  # pagina 1: video + cattura frame
public/output.html   # pagina 2: output AI live
public/admin.html    # area di amministrazione
public/voice.html    # assistente vocale (AssemblyAI + Claude)
public/screen.html   # stream della capture card a tutta pagina
config.default.json  # valori di default (versionato)
config.json          # config attiva (gitignored, creata al primo avvio)
.env.example
```

Non creare altri file o cartelle se non strettamente necessari.

## Configurazione (`config.json`)

```json
{
  "systemPrompt": "Sei un esperto che risponde a domande di questionari, quiz ed esami su qualsiasi materia (matematica, fisica, statistica, economia, informatica, diritto, cultura generale…), lette da schermate di una sorgente video HDMI. Conta prima di tutto l'affidabilità: leggi la domanda con attenzione, simbolo per simbolo, prima di rispondere. Non inventare e non dare per scontato nulla che non sia scritto: se un dato non si legge, dillo invece di indovinarlo. Nei problemi matematici svolgi i calcoli con cura e verifica il risultato prima di scegliere l'opzione. Rispondi in italiano, in modo conciso.",
  "defaultPrompt": "Rispondi alla domanda. Se è a scelta multipla indica l'opzione corretta (lettera e testo completo dell'opzione) e una motivazione breve; per i calcoli riporta solo i passaggi essenziali e la verifica. Se è aperta, rispondi in 1-3 frasi.",
  "model": "claude-sonnet-5-5",
  "fallbackModel": "gpt-5-mini",
  "maxTokens": 16000,
  "imageMaxWidth": 1920,
  "jpegQuality": 0.85
}
```

Variabili d'ambiente (`.env`): `ANTHROPIC_API_KEY` (obbligatoria), `ADMIN_PASSWORD` (obbligatoria), `OPENAI_API_KEY` (opzionale, fallback), `ASSEMBLYAI_API_KEY` (opzionale, assistente vocale), `PORT` (default 3000), `HOST` (default `0.0.0.0`).

## API

| Metodo | Path | Accesso | Funzione |
|---|---|---|---|
| GET | `/` | pubblico | `capture.html` |
| GET | `/output` | pubblico | `output.html` |
| GET | `/admin` | Basic Auth | `admin.html` |
| GET | `/api/client-config` | pubblico | `{ intervalSec, imageMaxWidth, jpegQuality }` |
| POST | `/api/frame` | **solo loopback** | body `{ image: "<base64 jpeg senza prefisso>" }` → chiama Claude, risponde con il risultato e lo trasmette via SSE |
| POST | `/api/reset` | **solo loopback** | svuota i blocchi già elaborati (chiamato da Capture a ogni "Avvia analisi") |
| GET | `/api/events` | pubblico | stream SSE; all'apertura invia le domande della sessione (`block`) e gli ultimi errori di frame |
| GET | `/screen` | pubblico | `screen.html`: stream a tutta pagina |
| GET | `/voice` | pubblico | `voice.html`: assistente vocale |
| GET | `/api/voice/token` | **solo loopback** | token temporaneo AssemblyAI (60 s) per il WebSocket di streaming |
| POST | `/api/voice/turn` | **solo loopback** | body `{ text }` (frase conclusa) → `202`; Claude risponde in streaming via evento SSE `voice` se c'è una domanda |
| POST | `/api/voice/reset` | **solo loopback** | svuota il contesto delle frasi (chiamato a ogni "Avvia ascolto") |
| GET | `/api/latest` | pubblico | ultimo risultato (o `null`) |
| GET | `/api/config` | Basic Auth | config completa |
| PUT | `/api/config` | Basic Auth | aggiorna e salva `config.json`, invia evento SSE `config` |

Evento SSE `block`: `{ key, question, answer (null = in attesa), model?, error?, ts }`, emesso all'estrazione e alla risposta. Evento SSE `result` (riepilogo frame): `{ id, ts, model, newKeys, usage: { input_tokens, output_tokens }, fallback?, error? }`. Se una risposta si ferma per `maxTokens` è un errore. Evento SSE `voice`: `{ id, ts, question, answer, done, model, fallback?, error? }`, emesso a ogni pezzo di risposta; le ultime 20 vengono reinviate all'apertura.

## Comportamenti obbligatori

1. **Pipeline**: (a) estrazione: una chiamata con `[image, prompt fisso di trascrizione]` → JSON `{ blocks: [{ key, question, dependsOn }] }`, formule in LaTeX; una domanda con più parti (chiusa + aperta, sotto-punti) è un solo blocco con tutte le parti, e `dependsOn` collega una domanda che ne cita un'altra; (b) risposta: una chiamata per ogni domanda nuova con `[image, defaultPrompt + regole fisse + question]` (l'immagine corregge eventuali errori di trascrizione; rispondere a tutte le parti in modo coerente, prima riga "Risposta: …", verificare l'opzione, niente ipotesi inventate), in parallelo; chi ha `dependsOn` aspetta la risposta collegata e la riceve come contesto. `system = systemPrompt`, `max_tokens = maxTokens`. Fallback: se Claude lancia un errore API e c'è `OPENAI_API_KEY`, la stessa chiamata va a OpenAI (`fallbackModel`, via `fetch`). Anche un rifiuto (`stop_reason: refusal`) fa scattare il fallback; il troncamento no. I client ordinano le domande per chiave (numerica), non per arrivo.
2. **Nessuna sovrapposizione**: se un'elaborazione è in corso, il server risponde `409` al frame successivo e il client lo salta. Mai due chiamate in parallelo.
3. **Risparmio token**: il client ridimensiona il frame a `imageMaxWidth` (mantenendo le proporzioni) e lo codifica JPEG a `jpegQuality` prima dell'invio. 1280×720 ≈ 1.200 token di input per immagine. Nessuna cronologia di conversazione: ogni chiamata è indipendente.
4. **Protezione dei costi**: `/api/frame` accetta solo richieste da `127.0.0.1` / `::1` / `::ffff:127.0.0.1`; altrimenti `403`. Limite body JSON 5 MB.
5. **Errori**: un errore dell'API non fa crashare il server; viene trasmesso come evento `result` con campo `error` e mostrato in entrambe le pagine.
6. **Cronologia**: il server tiene in memoria solo gli ultimi 10 risultati (`GET /api/latest` restituisce l'ultimo). Nessuna persistenza su disco dei risultati.
7. **Blocchi incrementali**: l'estrazione considera solo i blocchi visibili per intero, `key` = numero della domanda, e trascrive anche le domande già viste. Il server scarta quelle già viste con lo stesso testo (spazi ignorati); se il testo è cambiato (es. opzioni prima mancanti) la domanda viene sovrascritta e ririsposta. Se non resta nessuna domanda nuova o cambiata non parte nessuna chiamata di risposta e `/api/frame` risponde con `duplicate: true`.
8. **Config a caldo**: le modifiche dall'admin valgono dalla chiamata successiva, senza riavvio. Il client Capture, ricevendo l'evento SSE `config`, riallinea l'intervallo.

## Requisiti UI

**Capture (`/`)**
- Select dei dispositivi video (`enumerateDevices`), scelta ricordata in `localStorage` (con try/catch).
- `getUserMedia({ video: { deviceId, width: 1920, height: 1080 }, audio: false })`, video a tutto schermo, pulsante fullscreen.
- Pulsante **Avvia / Ferma analisi**, countdown al prossimo frame, stato dell'ultima chiamata (ok / in corso / errore), token consumati nell'ultima chiamata.
- Primo frame inviato subito all'avvio, poi ogni `intervalSec`.

**Output (`/output`)**
- Testo grande e leggibile (anche su TV/tablet), `white-space: pre-wrap`, orario dell'ultima elaborazione, indicatore "live / disconnesso".
- `EventSource` con riconnessione automatica. Nessun rendering Markdown.

**Admin (`/admin`)**
- Form con tutti i campi di `config.json`, textarea ampie per i due prompt, pulsante Salva con conferma, pulsante "Ripristina default" (da `config.default.json`).
- Validazione server: `intervalSec` 5–3600, `maxTokens` 50–32000, `imageMaxWidth` 320–1920, `jpegQuality` 0.3–0.95, stringhe non vuote.

Stile: CSS minimo inline, dark mode di default, nessuna libreria.

## Fuori scope (MVP)

Registrazione audio/video, storico persistente, multi-utente, login con sessione, HTTPS, test framework, Docker, TypeScript, rilevamento dei cambiamenti tra frame.

## Criteri di accettazione

- [ ] `npm install && npm start` avvia l'app; senza `ANTHROPIC_API_KEY` o `ADMIN_PASSWORD` il server esce con un messaggio chiaro.
- [ ] Su `/` si vede lo stream della capture card e si può scegliere il dispositivo.
- [ ] Con l'analisi attiva parte un frame subito e poi uno ogni 30 s (o `intervalSec`), mai in parallelo.
- [ ] `/output`, aperta da un altro dispositivo in LAN, si aggiorna entro 1 s dalla risposta di Claude.
- [ ] Da `/admin` (dietro password) si modificano i prompt; la chiamata successiva usa i nuovi valori.
- [ ] `POST /api/frame` da un altro host risponde `403`.
- [ ] Un errore dell'API (es. chiave errata) appare nelle due pagine e il server resta attivo.

## Stile del codice

- Codice breve e leggibile, commenti solo dove il perché non è ovvio.
- Nessuna astrazione "per il futuro". Se una funzione ha un solo chiamante, probabilmente non serve.
- Log su console: una riga per frame (`ts`, durata, token in/out) e gli errori.
