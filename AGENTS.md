# AGENTS.md — HDMI Vision

Regole per qualsiasi agente di coding che lavora su questo repo. Sono la fonte di verità: `CLAUDE.md` le importa.

## Cosa stiamo costruendo

App locale per un Mac che riceve il video di una **capture card HDMI** (dispositivo UVC, visto dal browser come una webcam).

- **Pagina Capture** (`/`): mostra lo stream live. Ogni `intervalSec` secondi (default **30**) cattura un fotogramma e lo invia a Claude con un system prompt e un prompt di default.
- **Pagina Output** (`/output`): indirizzo dedicato, raggiungibile anche da altri dispositivi in LAN. Mostra l'output dell'AI e si aggiorna da sola a ogni nuova elaborazione.
- **Pagina Admin** (`/admin`): protetta da password. Modifica system prompt, prompt di default e parametri.

## Stack (non negoziabile per l'MVP)

- Node.js ≥ 20, ES modules, **nessun build step**.
- Dipendenze runtime ammesse: `express`, `@anthropic-ai/sdk`. Nient'altro senza chiederlo.
- Frontend: HTML + JS vanilla inline, nessun framework, nessuna libreria CDN.
- Persistenza: un file `config.json`. Nessun database.
- Aggiornamenti live: Server-Sent Events (SSE). Niente WebSocket.

## Struttura dei file

```
server.js            # tutto il backend (~200 righe)
public/capture.html  # pagina 1: video + cattura frame
public/output.html   # pagina 2: output AI live
public/admin.html    # area di amministrazione
config.default.json  # valori di default (versionato)
config.json          # config attiva (gitignored, creata al primo avvio)
.env.example
```

Non creare altri file o cartelle se non strettamente necessari.

## Configurazione (`config.json`)

```json
{
  "systemPrompt": "Sei un assistente che legge schermate provenienti da una sorgente video HDMI che mostrano questionari o quiz, spesso più lunghi dello schermo e fatti scorrere un po' alla volta. Rispondi in italiano, in modo conciso.",
  "defaultPrompt": "Rispondi a ogni domanda visibile. Per ciascuna indica la risposta corretta (lettera e testo dell'opzione) e una motivazione di una riga. Se la domanda è aperta, rispondi in 1-3 frasi.",
  "model": "claude-haiku-4-5-20251001",
  "maxTokens": 1000,
  "intervalSec": 30,
  "imageMaxWidth": 1280,
  "jpegQuality": 0.7
}
```

Variabili d'ambiente (`.env`): `ANTHROPIC_API_KEY` (obbligatoria), `ADMIN_PASSWORD` (obbligatoria), `PORT` (default 3000), `HOST` (default `0.0.0.0`).

## API

| Metodo | Path | Accesso | Funzione |
|---|---|---|---|
| GET | `/` | pubblico | `capture.html` |
| GET | `/output` | pubblico | `output.html` |
| GET | `/admin` | Basic Auth | `admin.html` |
| GET | `/api/client-config` | pubblico | `{ intervalSec, imageMaxWidth, jpegQuality }` |
| POST | `/api/frame` | **solo loopback** | body `{ image: "<base64 jpeg senza prefisso>" }` → chiama Claude, risponde con il risultato e lo trasmette via SSE |
| POST | `/api/reset` | **solo loopback** | svuota i blocchi già elaborati (chiamato da Capture a ogni "Avvia analisi") |
| GET | `/api/events` | pubblico | stream SSE; all'apertura invia subito gli ultimi risultati in memoria (max 10) |
| GET | `/api/latest` | pubblico | ultimo risultato (o `null`) |
| GET | `/api/config` | Basic Auth | config completa |
| PUT | `/api/config` | Basic Auth | aggiorna e salva `config.json`, invia evento SSE `config` |

Evento SSE `result`: `{ id, ts, text, model, usage: { input_tokens, output_tokens }, error? }`. Se la risposta si ferma per `maxTokens` è un errore.

## Comportamenti obbligatori

1. **Chiamata a Claude**: `messages.create` con `system = systemPrompt` e un solo messaggio utente il cui contenuto è `[image (base64, image/jpeg), text = defaultPrompt]`. `max_tokens = maxTokens`.
2. **Nessuna sovrapposizione**: se un'elaborazione è in corso, il server risponde `409` al frame successivo e il client lo salta. Mai due chiamate in parallelo.
3. **Risparmio token**: il client ridimensiona il frame a `imageMaxWidth` (mantenendo le proporzioni) e lo codifica JPEG a `jpegQuality` prima dell'invio. 1280×720 ≈ 1.200 token di input per immagine. Nessuna cronologia di conversazione: ogni chiamata è indipendente.
4. **Protezione dei costi**: `/api/frame` accetta solo richieste da `127.0.0.1` / `::1` / `::ffff:127.0.0.1`; altrimenti `403`. Limite body JSON 5 MB.
5. **Errori**: un errore dell'API non fa crashare il server; viene trasmesso come evento `result` con campo `error` e mostrato in entrambe le pagine.
6. **Cronologia**: il server tiene in memoria solo gli ultimi 10 risultati (`GET /api/latest` restituisce l'ultimo). Nessuna persistenza su disco dei risultati.
7. **Blocchi incrementali**: la risposta è JSON (`output_config.format`) `{ blocks: [{ key, text }] }`. Al prompt si aggiungono istruzioni fisse: elaborare solo i blocchi (es. domanda + opzioni) visibili per intero, `key` = numero della domanda, e l'elenco delle chiavi già elaborate da escludere. Il server scarta comunque le chiavi già viste; se non resta nessun blocco nuovo il risultato non viene salvato né trasmesso e `/api/frame` risponde con `duplicate: true`. `text` del risultato = testi dei blocchi nuovi uniti.
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
- Validazione server: `intervalSec` 5–3600, `maxTokens` 50–4000, `imageMaxWidth` 320–1920, `jpegQuality` 0.3–0.95, stringhe non vuote.

Stile: CSS minimo inline, dark mode di default, nessuna libreria.

## Fuori scope (MVP)

Audio, registrazione video, storico persistente, multi-utente, login con sessione, HTTPS, test framework, Docker, TypeScript, rilevamento dei cambiamenti tra frame.

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
