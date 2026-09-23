import fs from "node:fs";
import path from "node:path";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(ROOT, "config.json");
const CONFIG_DEFAULT_PATH = path.join(ROOT, "config.default.json");

// --- Env obbligatorie ---
const { ANTHROPIC_API_KEY, ADMIN_PASSWORD } = process.env;
if (!ANTHROPIC_API_KEY) {
  console.error("Errore: variabile d'ambiente ANTHROPIC_API_KEY mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("Errore: variabile d'ambiente ADMIN_PASSWORD mancante. Copia .env.example in .env e impostala.");
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Config ---
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_DEFAULT_PATH, CONFIG_PATH);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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
  if (!Number.isFinite(body.maxTokens) || body.maxTokens < 50 || body.maxTokens > 4000) errors.push("maxTokens deve essere tra 50 e 4000");
  if (!Number.isFinite(body.intervalSec) || body.intervalSec < 5 || body.intervalSec > 3600) errors.push("intervalSec deve essere tra 5 e 3600");
  if (!Number.isFinite(body.imageMaxWidth) || body.imageMaxWidth < 320 || body.imageMaxWidth > 1920) errors.push("imageMaxWidth deve essere tra 320 e 1920");
  if (!Number.isFinite(body.jpegQuality) || body.jpegQuality < 0.3 || body.jpegQuality > 0.95) errors.push("jpegQuality deve essere tra 0.3 e 0.95");
  return errors;
}

// --- Stato risultati (in memoria, max 10) ---
const results = [];
function pushResult(r) {
  results.push(r);
  if (results.length > 10) results.shift();
}
function latestResult() {
  return results.length ? results[results.length - 1] : null;
}

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

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => res.sendFile(path.join(ROOT, "public", "capture.html")));
app.get("/output", (req, res) => res.sendFile(path.join(ROOT, "public", "output.html")));
app.get("/admin", requireAuth, (req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));

app.get("/api/client-config", (req, res) => {
  const { intervalSec, imageMaxWidth, jpegQuality } = config;
  res.json({ intervalSec, imageMaxWidth, jpegQuality });
});

app.get("/api/config", requireAuth, (req, res) => res.json(config));

app.put("/api/config", requireAuth, (req, res) => {
  const errors = validateConfig(req.body);
  if (errors.length) return res.status(400).json({ errors });
  config = {
    systemPrompt: req.body.systemPrompt,
    defaultPrompt: req.body.defaultPrompt,
    model: req.body.model,
    maxTokens: req.body.maxTokens,
    intervalSec: req.body.intervalSec,
    imageMaxWidth: req.body.imageMaxWidth,
    jpegQuality: req.body.jpegQuality,
  };
  saveConfig(config);
  broadcast("config", { intervalSec: config.intervalSec, imageMaxWidth: config.imageMaxWidth, jpegQuality: config.jpegQuality });
  res.json(config);
});

app.get("/api/latest", (req, res) => res.json(latestResult()));

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  sseClients.add(res);
  for (const r of results) sseSend(res, "result", r);
  req.on("close", () => sseClients.delete(res));
});

// Blocchi (es. domande) già elaborati nella sessione di analisi corrente:
// quando si scrolla, quelli ancora visibili non vanno rielaborati né mostrati di nuovo
const seenBlocks = new Map(); // chiave normalizzata -> chiave originale
const normKey = (k) => String(k).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const BLOCKS_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, text: { type: "string" } },
          required: ["key", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks"],
    additionalProperties: false,
  },
};

function blockInstructions() {
  const seen = [...seenBlocks.values()];
  return (
    "\n\nLa schermata può mostrare solo una parte di un contenuto più lungo che viene scrollato. " +
    "Dividi il contenuto in blocchi logici (es. una domanda con tutte le sue opzioni). " +
    "Elabora SOLO i blocchi visibili per intero: ignora quelli tagliati in alto o in basso, verranno elaborati quando saranno interamente visibili. " +
    'Per ogni blocco restituisci "key", un identificativo stabile (solo il numero della domanda se presente, es. "3", altrimenti le prime 6 parole del blocco), ' +
    'e "text", la tua risposta per quel blocco, che inizia con il numero o l\'etichetta del blocco.' +
    (seen.length ? `\nBlocchi già elaborati, da NON includere: ${seen.join(" | ")}` : "")
  );
}

// Nuova sessione di analisi: dimentica i blocchi già elaborati
app.post("/api/reset", requireLoopback, (req, res) => {
  seenBlocks.clear();
  res.status(204).end();
});

let busy = false;
app.post("/api/frame", requireLoopback, async (req, res) => {
  if (busy) return res.status(409).send("Elaborazione già in corso");
  const { image } = req.body || {};
  if (typeof image !== "string" || !image) return res.status(400).send("Campo image mancante");

  busy = true;
  const startedAt = Date.now();
  const result = { id: startedAt, ts: new Date().toISOString(), text: "", model: config.model };
  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: config.defaultPrompt + blockInstructions() },
          ],
        },
      ],
      output_config: { format: BLOCKS_FORMAT },
    });
    if (response.stop_reason === "max_tokens") throw new Error("Risposta troncata: aumenta maxTokens dall'admin");
    const raw = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const fresh = JSON.parse(raw).blocks.filter((b) => {
      const k = normKey(b.key);
      if (!k || seenBlocks.has(k)) return false;
      seenBlocks.set(k, b.key);
      return true;
    });
    result.text = fresh.map((b) => b.text).join("\n\n");
    result.usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    const durationMs = Date.now() - startedAt;
    console.log(`frame ts=${result.ts} durata=${durationMs}ms in=${result.usage.input_tokens} out=${result.usage.output_tokens} nuovi=${fresh.length}`);
    if (!fresh.length) return res.json({ ...result, duplicate: true });
    pushResult(result);
    broadcast("result", result);
    res.json(result);
  } catch (err) {
    result.error = err.message || String(err);
    const durationMs = Date.now() - startedAt;
    console.error(`frame ts=${result.ts} durata=${durationMs}ms ERRORE: ${result.error}`);
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
