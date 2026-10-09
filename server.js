import fs from "node:fs";
import path from "node:path";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(ROOT, "config.json");
const CONFIG_DEFAULT_PATH = path.join(ROOT, "config.default.json");

// --- Env obbligatorie ---
const { ANTHROPIC_API_KEY, ADMIN_PASSWORD, OPENAI_API_KEY } = process.env;
if (!ANTHROPIC_API_KEY) {
  console.error("Errore: variabile d'ambiente ANTHROPIC_API_KEY mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("Errore: variabile d'ambiente ADMIN_PASSWORD mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY non impostata: nessun fallback se Claude non risponde.");
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
  if (!Number.isFinite(body.maxTokens) || body.maxTokens < 50 || body.maxTokens > 4000) errors.push("maxTokens deve essere tra 50 e 4000");
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
        properties: { key: { type: "string" }, question: { type: "string" } },
        required: ["key", "question"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

function extractPrompt() {
  const seen = [...blocks.values()].map((b) => b.key);
  return (
    "Trascrivi le domande visibili nella schermata, SENZA rispondere. " +
    "La schermata può mostrare solo una parte di un contenuto più lungo che viene scrollato. " +
    "Dividi il contenuto in blocchi logici (una domanda con tutte le sue opzioni). " +
    "Includi SOLO i blocchi visibili per intero: ignora quelli tagliati in alto o in basso, verranno trascritti quando saranno interamente visibili. " +
    'Per ogni blocco restituisci "key", un identificativo stabile (solo il numero della domanda se presente, es. "3", altrimenti le prime 6 parole del blocco), ' +
    'e "question", la trascrizione fedele e completa di domanda e opzioni (con le loro lettere). ' +
    "Preserva formule e notazione matematica in LaTeX inline ($...$): esponenti, pedici, frazioni, radici, vettori, matrici, simboli greci e operatori." +
    (seen.length ? `\nBlocchi già trascritti, da NON includere: ${seen.join(" | ")}` : "")
  );
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => res.sendFile(path.join(ROOT, "public", "capture.html")));
app.get("/output", (req, res) => res.sendFile(path.join(ROOT, "public", "output.html")));
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
  req.on("close", () => sseClients.delete(res));
});

// Nuova sessione di analisi: dimentica le domande già elaborate
app.post("/api/reset", requireLoopback, (req, res) => {
  blocks.clear();
  res.status(204).end();
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
      if (!k || blocks.has(k)) continue;
      const block = { key: b.key, question: b.question, answer: null, ts: result.ts };
      blocks.set(k, block);
      fresh.push(block);
      broadcast("block", block);
    }

    // 2. risposte: una chiamata testuale per domanda, in parallelo (l'ordine lo tiene il client)
    await Promise.all(
      fresh.map(async (block) => {
        try {
          const r = track(await callLLM({ system: config.systemPrompt, text: `${config.defaultPrompt}\n\nDomanda:\n${block.question}`, maxTokens: config.maxTokens }));
          block.answer = r.text;
          block.model = r.model;
        } catch (err) {
          block.error = err.message || String(err);
          console.error(`domanda ${block.key} ERRORE: ${block.error}`);
        }
        broadcast("block", block);
      })
    );

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
