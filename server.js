// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------------- Middlewares ---------------- */
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.options("*", cors());
app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));

/* ---------------- Salud ---------------- */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

/* ---------------- Utilidades ---------------- */
function urlForTariff(code) {
  const base = "https://app.cfe.mx/Aplicaciones/CCFE/Tarifas/TarifasCRECasa/Tarifas/";
  const map = {
    "1": "Tarifa1.aspx", "1A":"Tarifa1A.aspx","1B":"Tarifa1B.aspx","1C":"Tarifa1C.aspx",
    "1D":"Tarifa1D.aspx","1E":"Tarifa1E.aspx","1F":"Tarifa1F.aspx","DAC":"TarifaDAC.aspx"
  };
  return base + (map[code] || map["1"]);
}
const MESES = ["","ENERO","FEBRERO","MARZO","ABRIL","MAYO","JUNIO","JULIO","AGOSTO","SEPTIEMBRE","OCTUBRE","NOVIEMBRE","DICIEMBRE"];
const toNum = (s) => { if (s == null) return NaN; const m = String(s).replace(/\s/g,"").replace(",",".").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
const pickPrice = (nums, {min=0.2, max=10} = {}) => nums.find(v => Number.isFinite(v) && v >= min && v <= max) ?? null;
function isMonthInSummer(month, start){ for(let i=0;i<6;i++){ const m=((start-1+i)%12)+1; if(m===month) return true;} return false; }

/* ---------------- Playwright (pool) ---------------- */
let sharedBrowser;
async function getBrowser() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  if (sharedBrowser && (await sharedBrowser.version())) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  return sharedBrowser;
}
process.on("SIGINT", async () => { try { await sharedBrowser?.close(); } finally { process.exit(0); } });
process.on("SIGTERM", async () => { try { await sharedBrowser?.close(); } finally { process.exit(0); } });

/* -------- Buscar un “scope” con tablas (main o iframe) -------- */
async function findScopeWithTables(page) {
  // 1) ¿Hay tablas en la página principal?
  if (await page.locator("table").count().catch(()=>0)) return page;
  // 2) Busca en frames
  for (const f of page.frames()) {
    try {
      if (await f.locator("table").count()) return f;
    } catch {}
  }
  return null;
}

/* -------- Select con posible postback (ASP.NET) -------- */
async function selectWithPostback(page, selectors, { value, label } = {}) {
  for (const sel of selectors) {
    const dd = await page.$(sel);
    if (!dd) continue;
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 25000 }),
        dd.selectOption(value != null ? { value: String(value) } : { label: String(label) }),
      ]);
      return true;
    } catch {
      try { await dd.selectOption(value != null ? { value: String(value) } : { label: String(label) }); } catch {}
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});
      return true;
    }
  }
  return false;
}

/* ---------------- Endpoint principal ---------------- */
app.get("/api/cfe-tarifa", async (req, res) => {
  const code = String(req.query.tarifa || "1D").toUpperCase();
  const year = Number(req.query.anio || new Date().getFullYear());
  const monthNum = Number(req.query.mes || (new Date().getMonth() + 1));
  const summerStart = Number(req.query.inicioVerano || 5);
  const isBimonthly = req.query.bimestral !== "false";
  const wantDebug = String(req.query.debug || "0") === "1";

  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ locale: "es-MX",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" });
    page = await context.newPage({ bypassCSP: true });
    page.setDefaultTimeout(50000);

    // 1) Cargar página
    await page.goto(urlForTariff(code), { waitUntil: "domcontentloaded", timeout: 50000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});
    await page.locator('button:has-text("Aceptar"), button:has-text("ACEPTAR"), text=/Entendido/i').first().click({ timeout: 1500 }).catch(()=>{});

    // 2) Espera a que haya selects/tablas (no falla si tarda)
    await Promise.race([
      page.waitForSelector("select", { timeout: 20000 }).catch(()=>{}),
      page.waitForSelector("table",  { timeout: 20000 }).catch(()=>{}),
      page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{}),
    ]);

    // 3) Selects
    await selectWithPostback(page, [
      'select[id*="ddlMesInicioVerano"]','select[name*="ddlMesInicioVerano"]',
      'xpath=//label[contains(., "comienza el verano")]/following::select[1]','xpath=//*[contains(.,"comienza el verano")]/following::select[1]',
    ], { value: summerStart }).catch(()=>{});

    const etiquetaMes = MESES[monthNum] || String(monthNum);
    await selectWithPostback(page, [
      'select[id*="ddlMesConsulta"]','select[name*="ddlMesConsulta"]',
      'xpath=//label[contains(., "mes que deseas consultar")]/following::select[1]',
      'xpath=//*[contains(.,"mes que deseas consultar")]/following::select[1]','xpath=(//select)[last()]',
    ], { value: monthNum, label: etiquetaMes }).catch(()=>{});

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});
    await page.waitForTimeout(800);

    // 4) Localiza tablas (en main o en iframe)
    const scope = await findScopeWithTables(page);
    if (!scope) {
      if (wantDebug) {
        const frames = await Promise.all(page.frames().map(async f => ({
          url: f.url(),
          tables: await f.locator("table").count().catch(()=>0),
          selects: await f.locator("select").count().catch(()=>0),
          title: await f.title().catch(()=>null)
        })));
        const htmlSnippet = (await page.content()).slice(0, 2000);
        return res.json({ debug: { frames, htmlSnippetLen: htmlSnippet.length, htmlSnippet }});
      }
      return res.status(404).json({ error: "No encontré tablas en la página de CFE." });
    }

    /* 5) Extrae filas */
    let rows = [];
    if (code === "DAC") {
      rows = await scope.$$eval("table tr", trs => trs.map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim())));
    } else {
      const summer = isMonthInSummer(monthNum, summerStart);
      const heading = summer ? "Temporada de verano" : "Fuera de verano";
      const table = await (scope.$(`xpath=(//*[contains(normalize-space(.), "${heading}")]/following::table)[1]`)
                     ?? scope.$("table"));
      if (!table) {
        if (wantDebug) {
          const tablesCount = await scope.locator("table").count().catch(()=>0);
          return res.json({ debug: { foundScope: true, tablesCount }});
        }
        return res.status(404).json({ error: `No encontré tablas visibles (scope).` });
      }
      rows = await table.$$eval("tr", trs => trs.map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim())));
    }
    if (wantDebug) return res.json({ debugRows: rows });

    /* 6) Parseo */
    let fixedCharge = null;
    const minKWhPerMonth = 25;
    const tiers = [];

    if (code === "DAC") {
      let singlePrice = null;
      for (const r of rows) {
        const joined = r.join(" ").toLowerCase();
        if (joined.includes("/kwh") || joined.includes("energ")) {
          const price = pickPrice(r.map(toNum));
          if (price != null) singlePrice = price;
        }
        if (joined.includes("cargo fijo") || joined.includes("servicio")) {
          const fc = r.map(toNum).filter(v => Number.isFinite(v) && v >= 0).at(-1);
          if (Number.isFinite(fc)) fixedCharge = fc;
        }
      }
      if (singlePrice == null) return res.status(404).json({ error: "No encontré $/kWh de DAC (usa ?debug=1)." });
      return res.json({ code, year, month: monthNum, isBimonthly, fixedCharge: fixedCharge ?? 0, minKWhPerMonth, tiers: [], singlePriceKWh: singlePrice, fetchedAt: new Date().toISOString() });
    }

    for (const r of rows) {
      const joined = r.join(" ").toLowerCase();
      if (joined.includes("consumo básico") || joined.includes("consumo basico")) {
        const price = pickPrice([toNum(r[1])]);
        const upTo = Number((r[2] || "").match(/primeros?\s+(\d+)/i)?.[1] || "0");
        if (price != null) tiers.push({ label: "Básico", upToKWh: upTo || null, pricePerKWh: price });
      } else if (joined.includes("consumo intermedio bajo")) {
        const price = pickPrice([toNum(r[1])]);
        const add = Number((r[2] || "").match(/siguientes?\s+(\d+)/i)?.[1] || "0");
        const prev = tiers.at(-1)?.upToKWh || 0;
        if (price != null) tiers.push({ label: "Intermedio bajo", upToKWh: add ? prev + add : null, pricePerKWh: price });
      } else if (joined.includes("consumo intermedio alto")) {
        const price = pickPrice([toNum(r[1])]);
        const add = Number((r[2] || "").match(/siguientes?\s+(\d+)/i)?.[1] || "0");
        const prev = tiers.at(-1)?.upToKWh || 0;
        if (price != null) tiers.push({ label: "Intermedio alto", upToKWh: add ? prev + add : null, pricePerKWh: price });
      } else if (joined.includes("consumo excedente")) {
        const price = pickPrice([toNum(r[1])]);
        if (price != null) tiers.push({ label: "Excedente", upToKWh: null, pricePerKWh: price });
      } else if (joined.includes("cargo fijo") || joined.includes("servicio")) {
        const fc = r.map(toNum).filter(v => Number.isFinite(v) && v >= 0).at(-1);
        if (Number.isFinite(fc)) fixedCharge = fc;
      }
    }

    const validTiers = tiers.filter(t => Number.isFinite(t.pricePerKWh));
    if (!validTiers.length) return res.status(404).json({ error: "No pude leer los bloques (usa ?debug=1)." });

    res.set("Cache-Control", "public, max-age=3600");
    return res.json({ code, year, month: monthNum, isBimonthly, fixedCharge: fixedCharge ?? 0, minKWhPerMonth, tiers: validTiers, fetchedAt: new Date().toISOString() });

  } catch (e) {
    console.error("cfe-tarifa error:", e);
    return res.status(500).json({ error: String(e) });
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
  }
});

/* ---------------- Arranque ---------------- */
app.listen(PORT, "0.0.0.0", () => console.log(`API listening on :${PORT}`));
