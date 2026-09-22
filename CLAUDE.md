# CLAUDE.md

@AGENTS.md

## Istruzioni specifiche per Claude Code

Le specifiche complete sono in `AGENTS.md` (importato sopra). Qui solo come lavorare.

### Modalità di lavoro (spec-driven, a basso consumo)

1. Leggi `AGENTS.md` una volta. Non esplorare il repo oltre i file elencati lì.
2. Implementa in quest'ordine, un commit per step:
   1. `package.json`, `.env.example`, `.gitignore`, `config.default.json`
   2. `server.js` (config, auth, SSE, `/api/frame`, chiamata a Claude)
   3. `public/capture.html`
   4. `public/output.html`
   5. `public/admin.html`
3. Dopo ogni step verifica con un solo comando mirato (es. `node --check server.js`, oppure `curl` sull'endpoint appena scritto). Niente suite di test.
4. Alla fine spunta i criteri di accettazione di `AGENTS.md` e riporta quali hai verificato e quali richiedono la capture card fisica.

### Vincoli per risparmiare token

- Scrivi ogni file per intero in un'unica volta; per correzioni usa edit mirati, non riscritture.
- Non rileggere un file che hai appena scritto.
- Non installare pacchetti oltre a `express` e `@anthropic-ai/sdk`.
- Non generare documentazione aggiuntiva: il `README.md` esiste già; aggiornalo solo se cambia un comando o un endpoint.
- Non usare subagenti per questo progetto.
- Se un requisito è ambiguo, scegli l'opzione più semplice che lo soddisfa e annotala in una riga nel riepilogo finale, senza fermarti a chiedere.

### Riferimenti API Claude

- SDK: `import Anthropic from "@anthropic-ai/sdk"`; il client legge `ANTHROPIC_API_KEY` dall'ambiente.
- Blocco immagine: `{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }`, messo **prima** del blocco di testo.
- Testo della risposta: concatena i blocchi `content` con `type === "text"`. Riporta `response.usage`.

### Comandi

- `npm start` → `node --env-file=.env server.js`
- `npm run dev` → `node --env-file=.env --watch server.js`
