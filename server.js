import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { customAlphabet } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3002;
const WRITE_TOKEN = process.env.WRITE_TOKEN || "";
const ORIGIN = process.env.ALLOW_ORIGIN || "";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));

const corsOrigins = [ORIGIN].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "cards.json");
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

await fs.mkdir(DATA_DIR, { recursive: true }).catch(()=>{});
try { await fs.access(DATA_FILE); } catch { await fs.writeFile(DATA_FILE, "[]\n", "utf8"); }

function tmpPath() {
  return path.join(DATA_DIR, `cards.tmp.${process.pid}.${Date.now()}.json`);
}

async function safeRead() {
  try {
    const txt = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(txt);
  } catch (err) {
    console.error("read_cards_parse_failed:", err?.message || err);
    await fs.writeFile(DATA_FILE, "[]\n", "utf8");
    return [];
  }
}
async function safeWrite(cards) {
  const json = JSON.stringify(cards, null, 2);
  const tmp = tmpPath();
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, DATA_FILE);
}

// in-process write queue to serialize writes
let writeChain = Promise.resolve();
function enqueueWrite(mutator) {
  writeChain = writeChain.then(async () => {
    const current = await safeRead();
    const next = await mutator(current);
    await safeWrite(next);
  }).catch(e => console.error("write_failed:", e));
  return writeChain;
}

function requireToken(req, res) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!WRITE_TOKEN || token !== WRITE_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return token;
}

function sanitizeCard(c) {
  const now = new Date().toISOString();
  const front = String(c.front ?? c.portuguese ?? "").replace(/^=+\s*/, "").trim();
  const backIn = c.back ?? c.translation ?? "";
  const back = Array.isArray(backIn)
    ? backIn.map(v => String(v)).join(" / ")
    : String(backIn).replace(/^=+\s*/, "").trim();
  if (!front || !back) return null;
  return {
    id: c.id || nanoid(),
    front, back,
    lang_from: c.lang_from || "pt",
    lang_to:   c.lang_to   || "de",
    tags: Array.isArray(c.tags) ? c.tags.slice(0,10) : [],
    ease: Number(c.ease ?? 2.5),
    interval: Number(c.interval ?? 0),
    next_review: c.next_review || now,
    lapses: Number(c.lapses ?? 0),
    created_at: c.created_at || now
  };
}

// --------- Routes ---------

// Public list
app.get("/api/cards", async (_req, res) => {
  const cards = await safeRead();
  res.set("Cache-Control", "no-store");
  res.json({ cards, count: cards.length });
});

// Create (one or many)
app.post("/api/cards", async (req, res) => {
  if (!requireToken(req, res)) return;
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const sanitized = incoming.map(sanitizeCard).filter(Boolean);
  if (!sanitized.length) return res.status(400).json({ error: "invalid_payload" });

  await enqueueWrite(async (cards) => {
    const idx = new Map(cards.map((x,i)=>[x.id, i]));
    for (const n of sanitized) {
      if (idx.has(n.id)) cards[idx.get(n.id)] = { ...cards[idx.get(n.id)], ...n };
      else cards.push(n);
    }
    return cards;
  });

  const after = await safeRead();
  res.json({ ok: true, added: sanitized.length, total: after.length });
});

// Update by id (partial allowed)
app.put("/api/cards/:id", async (req, res) => {
  if (!requireToken(req, res)) return;
  const id = String(req.params.id);

  const patch = req.body || {};
  if (patch.front !== undefined) patch.front = String(patch.front).replace(/^=+\s*/, "").trim();
  if (patch.back  !== undefined) {
    patch.back = Array.isArray(patch.back)
      ? patch.back.map(v => String(v)).join(" / ")
      : String(patch.back).replace(/^=+\s*/, "").trim();
  }

  let updated = false;
  await enqueueWrite(async (cards) => {
    const i = cards.findIndex(c => c.id === id);
    if (i === -1) return cards;
    cards[i] = { ...cards[i], ...patch };
    updated = true;
    return cards;
  });

  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, id });
});

// Delete by id
app.delete("/api/cards/:id", async (req, res) => {
  if (!requireToken(req, res)) return;
  const id = String(req.params.id);
  let removed = false;
  await enqueueWrite(async (cards) => {
    const before = cards.length;
    const next = cards.filter(c => c.id !== id);
    removed = next.length !== before;
    return next;
  });
  if (!removed) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, id });
});

// static SPA
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Flashcards listening on http://127.0.0.1:${PORT}`));
