import fs from "node:fs";
import path from "node:path";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(ROOT, "config.json");
const CONFIG_DEFAULT_PATH = path.join(ROOT, "config.default.json");

// --- Env obbligatorie ---
const { ANTHROPIC_API_KEY, ADMIN_PASSWORD, OPENAI_API_KEY, ASSEMBLYAI_API_KEY } = process.env;
if (!ANTHROPIC_API_KEY) {
  console.error("Errore: variabile d'ambiente ANTHROPIC_API_KEY mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("Errore: variabile d'ambiente ADMIN_PASSWORD mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY non impostata: nessun fallback se Claude non risponde.");
if (!ASSEMBLYAI_API_KEY) console.warn("ASSEMBLYAI_API_KEY non impostata: l'assistente vocale (/voice) non funziona.");
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Config ---
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_DEFAULT_PATH, CONFIG_PATH);
  }
  const defaults = JSON.parse(fs.readFileSync(CONFIG_DEFAULT_PATH, "utf8"));
  // i campi aggiunti dopo la creazione di config.json prendono il default
  return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();

function validateConfig(body) {
  const errors = [];
  const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
  if (!isNonEmptyString(body.systemPrompt)) errors.push("systemPrompt non valido");
  if (!isNonEmptyString(body.defaultPrompt)) errors.push("defaultPrompt non valido");
  if (!isNonEmptyString(body.model)) errors.push("model non valido");
  if (!isNonEmptyString(body.fallbackModel)) errors.push("fallbackModel non valido");
  if (!Number.isFinite(body.maxTokens) || body.maxTokens < 50 || body.maxTokens > 32000) errors.push("maxTokens deve essere tra 50 e 32000");
  if (!Number.isFinite(body.imageMaxWidth) || body.imageMaxWidth < 320 || body.imageMaxWidth > 1920) errors.push("imageMaxWidth deve essere tra 320 e 1920");
  if (!Number.isFinite(body.jpegQuality) || body.jpegQuality < 0.3 || body.jpegQuality > 0.95) errors.push("jpegQuality deve essere tra 0.3 e 0.95");
  return errors;
}

// --- Riepiloghi dei frame (in memoria, max 10) ---
const results = [];
function pushResult(r) {
  results.push(r);
  if (results.length > 10) results.shift();
}

// Domande della sessione di analisi corrente: chiave normalizzata -> { key, question, answer, error?, model, ts }
// Servono sia a non rielaborare quelle ancora visibili dopo uno scroll, sia a reinviarle a chi si collega.
const blocks = new Map();
const normKey = (k) => String(k).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// --- SSE ---
const sseClients = new Set();
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of sseClients) sseSend(res, event, data);
}

// --- Basic Auth per /admin e /api/config ---
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, password] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (password === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="admin"');
  res.status(401).send("Autenticazione richiesta");
}

// --- Solo loopback per /api/frame ---
function requireLoopback(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "";
  const normalized = ip.replace(/^::ffff:/, "");
  if (normalized === "127.0.0.1" || normalized === "::1") return next();
  res.status(403).send("Accesso consentito solo da localhost");
}

// --- Chiamata LLM: Claude, con OpenAI come fallback se l'API non risponde ---
class TruncatedError extends Error {}

async function callClaude({ system, image, text, schema, maxTokens }) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  content.push({ type: "text", text });
  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    ...(schema && { output_config: { format: { type: "json_schema", schema } } }),
  });
  if (response.stop_reason === "max_tokens") throw new TruncatedError("Risposta troncata: aumenta maxTokens dall'admin");
  if (response.stop_reason === "refusal") throw new Error("Claude ha rifiutato la richiesta");
  return {
    text: response.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    model: config.model,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  };
}

async function callOpenAI({ system, image, text, schema, maxTokens }) {
  const content = [];
  if (image) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } });
  content.push({ type: "text", text });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: config.fallbackModel,
      max_completion_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content }],
      ...(schema && { response_format: { type: "json_schema", json_schema: { name: "blocks", schema, strict: true } } }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data.error?.message || res.statusText}`);
  const choice = data.choices[0];
  if (choice.finish_reason === "length") throw new TruncatedError("Risposta troncata: aumenta maxTokens dall'admin");
  return {
    text: choice.message.content || "",
    model: config.fallbackModel,
    usage: { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens },
    fallback: true,
  };
}

async function callLLM(opts) {
  try {
    return await callClaude(opts);
  } catch (err) {
    // il troncamento è un problema di config, non di disponibilità: niente fallback
    if (err instanceof TruncatedError || !OPENAI_API_KEY) throw err;
    console.error(`Claude non risponde (${err.message}), fallback su ${config.fallbackModel}`);
    try {
      return await callOpenAI(opts);
    } catch (err2) {
      throw new Error(`Claude: ${err.message} — fallback: ${err2.message}`);
    }
  }
}

// --- Estrazione delle domande dall'immagine ---
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, question: { type: "string" }, dependsOn: { type: "string" } },
        required: ["key", "question", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

const sameText = (a, b) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

function extractPrompt() {
  return (
    "Trascrivi le domande visibili nella schermata, SENZA rispondere. " +
    "La schermata può mostrare solo una parte di un contenuto più lungo che viene scrollato. " +
    "Dividi il contenuto in blocchi logici (una domanda con tutte le sue opzioni). " +
    "Includi SOLO i blocchi visibili per intero: ignora quelli tagliati in alto o in basso, verranno trascritti quando saranno interamente visibili. " +
    'Per ogni blocco restituisci "key", un identificativo stabile (solo il numero della domanda se presente, es. "3", altrimenti le prime 6 parole del blocco), ' +
    'e "question", la trascrizione fedele e completa di domanda e opzioni (con le loro lettere). ' +
    "Preserva formule e notazione matematica in LaTeX inline ($...$): esponenti, pedici, frazioni, radici, vettori, matrici, simboli greci e operatori. " +
    "Trascrivi ESATTAMENTE ciò che vedi, senza correggere, completare o semplificare nulla, anche se ti sembra un errore. " +
    "Per vettori e matrici conta righe e colonne e trascrivi ogni elemento nell'ordine, riga per riga, con il suo segno; ricontrolla ogni numero sull'immagine. " +
    "Includi tutte le opzioni di risposta; se non hanno lettera, etichettale A, B, C… nell'ordine in cui appaiono. " +
    "Una domanda composta da più parti (es. un risultato da calcolare o un'opzione da scegliere, seguiti da un campo di testo come \"Come sei giunto al risultato?\" o \"Quali teoremi hai applicato?\", oppure sotto-punti a, b, c) è UN SOLO blocco: " +
    "trascrivi tutte le parti nell'ordine, ciascuna su una riga che inizia con \"Parte 1:\", \"Parte 2:\"… e indica se è a risposta chiusa o aperta. " +
    "Campi o richieste senza numero proprio appartengono alla domanda numerata che li precede; se quella parte non è visibile per intero, ignora il blocco. " +
    'Se una domanda con numero proprio fa riferimento esplicito a un\'altra (es. "riferendoti alla domanda 3"), metti in "dependsOn" la key di quella domanda, altrimenti stringa vuota.'
  );
}

// Regole fisse per le risposte, in aggiunta al prompt di default modificabile dall'admin
const ANSWER_RULES =
  "Se la domanda ha più parti, rispondi a TUTTE nell'ordine, etichettandole come nella domanda (Parte 1, Parte 2…). " +
  "Le parti aperte devono essere coerenti con le risposte chiuse: se chiedono come sei giunto al risultato o quali teoremi hai applicato, " +
  "descrivi il procedimento che porta proprio a quel risultato, citando teoremi e formule usati. " +
  "Ricevi l'immagine della schermata e la trascrizione della domanda: la trascrizione può contenere errori di lettura, in caso di differenze fa fede l'immagine. " +
  "Rispondi solo alla domanda indicata, anche se l'immagine ne mostra altre. Prima di rispondere ricontrolla sull'immagine ogni numero, segno ed elemento di vettori e matrici. " +
  "Inizia con una riga \"Risposta: \" seguita dall'opzione scelta (lettera e testo completo), poi la motivazione. " +
  "Per una domanda a scelta multipla verifica l'opzione scelta (es. sostituendola nel problema). Se nessuna opzione torna, ricontrolla lettura e calcoli; " +
  "se ancora non torna scrivi \"Risposta: incerta\" e spiega il dubbio in una riga, senza inventare ipotesi e senza modificare la domanda. " +
  "La risposta viene mostrata come testo semplice in cui le formule sono renderizzate con KaTeX (auto-render): niente Markdown (niente **, #, elenchi con * o -). " +
  "Se la domanda contiene formule o notazione matematica, scrivi OGNI formula, simbolo, vettore, matrice, insieme o relazione in LaTeX compatibile con KaTeX, " +
  "inline tra $...$ o su riga propria tra $$...$$; ogni $ aperto va chiuso nella stessa riga, mai $ annidati, mai frasi dentro $...$ (per parole in una formula usa \\text{...}). " +
  "Usa solo comandi supportati da KaTeX (es. \\frac, \\sqrt, \\begin{pmatrix}...\\end{pmatrix}, \\mathbb{R}, \\text{Span}, \\neq, \\leq, \\Rightarrow, \\cdot); " +
  "niente simboli matematici Unicode (≠, ≤, →, ², √) fuori dalle formule e niente ambienti non supportati. " +
  "Quando indichi la risposta scelta riporta l'opzione completa (lettera e formula), senza abbreviarla.";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use("/katex", express.static(path.join(ROOT, "node_modules", "katex", "dist")));
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "public", "capture.html")));
app.get("/output", (req, res) => res.sendFile(path.join(ROOT, "public", "output.html")));
app.get("/screen", (req, res) => res.sendFile(path.join(ROOT, "public", "screen.html")));
app.get("/voice", (req, res) => res.sendFile(path.join(ROOT, "public", "voice.html")));
app.get("/admin", requireAuth, (req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));

app.get("/api/client-config", (req, res) => {
  const { imageMaxWidth, jpegQuality } = config;
  res.json({ imageMaxWidth, jpegQuality });
});

app.get("/api/config", requireAuth, (req, res) => res.json(config));

app.put("/api/config", requireAuth, (req, res) => {
  const errors = validateConfig(req.body);
  if (errors.length) return res.status(400).json({ errors });
  config = {
    systemPrompt: req.body.systemPrompt,
    defaultPrompt: req.body.defaultPrompt,
    model: req.body.model,
    fallbackModel: req.body.fallbackModel,
    maxTokens: req.body.maxTokens,
    imageMaxWidth: req.body.imageMaxWidth,
    jpegQuality: req.body.jpegQuality,
  };
  saveConfig(config);
  broadcast("config", { imageMaxWidth: config.imageMaxWidth, jpegQuality: config.jpegQuality });
  res.json(config);
});

app.get("/api/latest", (req, res) => res.json(results.length ? results[results.length - 1] : null));

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  sseClients.add(res);
  for (const b of blocks.values()) sseSend(res, "block", b);
  for (const r of results) if (r.error) sseSend(res, "result", r);
  for (const v of voiceAnswers) sseSend(res, "voice", v);
  req.on("close", () => sseClients.delete(res));
});

// Nuova sessione di analisi: dimentica le domande già elaborate
app.post("/api/reset", requireLoopback, (req, res) => {
  blocks.clear();
  res.status(204).end();
});

// --- Assistente vocale: trascrizione AssemblyAI nel browser, risposte di Claude in streaming via SSE ---
const VOICE_SYSTEM =
  "Ascolti in tempo reale una conversazione orale (es. un'interrogazione, un esame orale o un colloquio), trascritta automaticamente: " +
  "la trascrizione può contenere errori, interpretala nel senso più plausibile. " +
  "Quando viene posta una domanda rispondi in italiano, subito e in modo diretto: prima la risposta in una frase, poi al massimo 2-3 frasi di dettaglio utili da dire a voce. " +
  "Le domande possono riferirsi a quelle precedenti (es. \"e nel caso opposto?\", \"perché?\"): usa le domande e risposte già date per interpretarle e resta coerente con esse. " +
  "Niente preamboli, niente Markdown; formule in notazione testuale semplice.";
const SKIP = "[SKIP]";
const voiceTurns = []; // ultime frasi trascritte, usate come contesto
const voiceAnswers = []; // ultime 20 risposte, reinviate a chi si collega
const voiceHistory = []; // domande e risposte della sessione di ascolto, usate come contesto

function pushVoice(v) {
  voiceAnswers.push(v);
  if (voiceAnswers.length > 20) voiceAnswers.shift();
}

app.get("/api/voice/token", requireLoopback, async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) return res.status(503).send("ASSEMBLYAI_API_KEY non impostata nel file .env");
  try {
    const r = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=60", { headers: { Authorization: ASSEMBLYAI_API_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).send(`AssemblyAI ${r.status}: ${data.error || r.statusText}`);
    res.json({ token: data.token });
  } catch (err) {
    res.status(502).send(`AssemblyAI non raggiungibile: ${err.message}`);
  }
});

app.post("/api/voice/reset", requireLoopback, (req, res) => {
  voiceTurns.length = 0;
  voiceHistory.length = 0;
  res.status(204).end();
});

// Ogni frase conclusa arriva qui; la risposta parte subito e viene trasmessa a pezzi via SSE (evento "voice")
app.post("/api/voice/turn", requireLoopback, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).send("Campo text mancante");
  const context = voiceTurns.slice(-6).join("\n");
  const history = voiceHistory.slice(-10).map((h, i) => `D${i + 1}: ${h.question}\nR${i + 1}: ${h.answer}`).join("\n\n");
  voiceTurns.push(text);
  if (voiceTurns.length > 20) voiceTurns.shift();
  res.status(202).end();

  const startedAt = Date.now();
  const item = { id: `${startedAt}-${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), question: text, answer: "", done: false, model: config.model };
  const prompt =
    (history ? `Domande e risposte precedenti della sessione:\n${history}\n\n` : "") +
    (context ? `Frasi precedenti della conversazione:\n${context}\n\n` : "") +
    `Ultima frase trascritta:\n"${text}"\n\n` +
    "Se l'ULTIMA frase contiene una domanda nuova (o completa una domanda iniziata nelle frasi precedenti), rispondi. " +
    `Se non c'è una domanda nuova, rispondi esattamente ${SKIP} e nient'altro.`;
  let shown = false;
  const emit = () => {
    if (!shown) {
      // si aspetta qualche carattere per riconoscere SKIP prima di mostrare qualcosa
      if (!item.done && item.answer.length < SKIP.length) return;
      if (item.answer.trim().startsWith(SKIP)) return false;
      shown = true;
      pushVoice(item);
    }
    broadcast("voice", item);
  };

  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const stream = anthropic.messages.stream({
      model: config.model,
      max_tokens: config.maxTokens,
      system: VOICE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    stream.on("text", (delta) => {
      item.answer += delta;
      if (emit() === false) stream.abort();
    });
    const final = await stream.finalMessage();
    usage = { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens };
    if (final.stop_reason === "max_tokens") item.error = "Risposta troncata: aumenta maxTokens dall'admin";
  } catch (err) {
    if (item.answer.trim().startsWith(SKIP)) {
      // stream interrotto da noi: nessuna domanda
    } else if (!item.answer && OPENAI_API_KEY) {
      console.error(`voce: Claude non risponde (${err.message}), fallback su ${config.fallbackModel}`);
      try {
        const r = await callOpenAI({ system: VOICE_SYSTEM, text: prompt, maxTokens: config.maxTokens });
        item.answer = r.text;
        item.model = r.model;
        item.fallback = true;
        usage = r.usage;
      } catch (err2) {
        item.error = `Claude: ${err.message} — fallback: ${err2.message}`;
      }
    } else {
      item.error = err.message || String(err);
    }
  }
  item.done = true;
  const skipped = item.answer.trim().startsWith(SKIP) && !item.error;
  if (!skipped) emit();
  if (!skipped && !item.error) {
    voiceHistory.push({ question: text, answer: item.answer.trim() });
    if (voiceHistory.length > 20) voiceHistory.shift();
  }
  console.log(`voce ts=${item.ts} durata=${Date.now() - startedAt}ms in=${usage.input_tokens} out=${usage.output_tokens} ${skipped ? "nessuna domanda" : item.error ? `ERRORE: ${item.error}` : "risposta"}`);
});

let busy = false;
app.post("/api/frame", requireLoopback, async (req, res) => {
  if (busy) return res.status(409).send("Elaborazione già in corso");
  const { image } = req.body || {};
  if (typeof image !== "string" || !image) return res.status(400).send("Campo image mancante");

  busy = true;
  const startedAt = Date.now();
  const result = { id: startedAt, ts: new Date().toISOString(), model: config.model, newKeys: [] };
  const usage = { input_tokens: 0, output_tokens: 0 };
  const models = new Set();
  const track = (r) => {
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    models.add(r.model);
    return r;
  };
  try {
    // 1. estrazione: una chiamata con l'immagine
    const extracted = track(await callLLM({ system: config.systemPrompt, image, text: extractPrompt(), schema: EXTRACT_SCHEMA, maxTokens: config.maxTokens }));
    const fresh = [];
    for (const b of JSON.parse(extracted.text).blocks) {
      const k = normKey(b.key);
      if (!k) continue;
      // stessa domanda con lo stesso testo: risposta già valida. Testo cambiato (es. opzioni prima mancanti): si sovrascrive.
      const old = blocks.get(k);
      if (old && sameText(old.question, b.question)) continue;
      const block = { key: b.key, question: b.question, dependsOn: b.dependsOn || "", answer: null, ts: result.ts };
      blocks.set(k, block);
      fresh.push(block);
      broadcast("block", block);
    }

    // 2. risposte: una chiamata testuale per domanda, in parallelo (l'ordine lo tiene il client).
    // Una domanda che dipende da un'altra aspetta la sua risposta e la riceve come contesto.
    const pending = new Map(); // chiave normalizzata -> promise della risposta in questo frame
    const answer = async (block) => {
      const dep = block.dependsOn && blocks.get(normKey(block.dependsOn));
      // si aspetta solo una domanda precedente: evita attese circolari (3 dipende da 4 e 4 da 3)
      if (dep && dep.key.localeCompare(block.key, "it", { numeric: true }) < 0) await pending.get(normKey(dep.key));
      const context = dep?.answer ? `Domanda collegata (${dep.key}):\n${dep.question}\nRisposta già data:\n${dep.answer}\n\n` : "";
      try {
        const r = track(await callLLM({ system: config.systemPrompt, image, text: `${config.defaultPrompt}\n\n${ANSWER_RULES}\n\n${context}Domanda (trascrizione):\n${block.question}`, maxTokens: config.maxTokens }));
        block.answer = r.text;
        block.model = r.model;
      } catch (err) {
        block.error = err.message || String(err);
        console.error(`domanda ${block.key} ERRORE: ${block.error}`);
      }
      broadcast("block", block);
    };
    // in ordine di chiave: quando parte una dipendente, la promise della domanda precedente è già registrata
    fresh.sort((a, b) => a.key.localeCompare(b.key, "it", { numeric: true }));
    for (const block of fresh) pending.set(normKey(block.key), answer(block));
    await Promise.all(pending.values());

    result.newKeys = fresh.map((b) => b.key);
    result.usage = usage;
    result.model = [...models].join(", ");
    result.fallback = !models.has(config.model);
    console.log(`frame ts=${result.ts} durata=${Date.now() - startedAt}ms in=${usage.input_tokens} out=${usage.output_tokens} nuove=${fresh.length} modelli=${result.model}`);
    if (!fresh.length) return res.json({ ...result, duplicate: true });
    pushResult(result);
    broadcast("result", result);
    res.json(result);
  } catch (err) {
    result.error = err.message || String(err);
    result.usage = usage;
    console.error(`frame ts=${result.ts} durata=${Date.now() - startedAt}ms ERRORE: ${result.error}`);
    pushResult(result);
    broadcast("result", result);
    res.status(200).json(result);
  } finally {
    busy = false;
  }
});

app.listen(PORT, HOST, () => {
  console.log(`HDMI Vision in ascolto su http://${HOST}:${PORT}`);
});
