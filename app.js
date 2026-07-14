"use strict";

/* =========================================================
   IndexedDB Datenschicht
   ========================================================= */
const DB_NAME = "begehungenDB";
const DB_VERSION = 2;
const STORE = "begehungen";
const UNTERNEHMEN_STORE = "unternehmen";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(UNTERNEHMEN_STORE)) {
        db.createObjectStore(UNTERNEHMEN_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(id, storeName = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record, storeName = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id, storeName = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* =========================================================
   App-Status
   ========================================================= */
let currentBegehung = null; // aktuell geöffnete Begehung (Objekt)
let currentFotos = [];      // Fotos (dataURL, komprimiert) für den Punkt in Erfassung
let currentMassnahmen = []; // Maßnahmen-Entwürfe {id, text, frist, sNach, wNach} für den Punkt in Erfassung

/* =========================================================
   Firmenlogo (für PDF-Kopfzeile)
   ========================================================= */
let logoDataUrl = null;
let logoAspect = 1200 / 720;

function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      logoDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      logoAspect = img.naturalWidth / img.naturalHeight;
      resolve();
    };
    img.onerror = () => resolve(); // Logo optional - PDF funktioniert auch ohne
    img.src = "logo.jpg";
  });
}
const logoReady = loadLogo();

/* =========================================================
   Risikomatrix nach Nohl (Schadensschwere x Eintrittswahrscheinlichkeit)
   ========================================================= */
// Schadensausmaß: 1-4 (wie üblich)
const S_LABELS = {
  1: "Leichte Verletzungen/Erkrankungen",
  2: "Mittelschwere Verletzungen/Erkrankungen",
  3: "Schwere Verletzung/Bleibende Schäden",
  4: "Möglicher Tod, Katastrophe",
};
// Eintrittswahrscheinlichkeit: 0-3 (beginnt bei 0 = sehr gering)
const W_LABELS = { 0: "Sehr gering", 1: "Gering", 2: "Mittel", 3: "Hoch" };

// Zeilen = Schadensausmaß (S, 1-4), Spalten = Eintrittswahrscheinlichkeit (W, 0-3) -> Risikoklasse 1-4
const NOHL_MATRIX = {
  1: { 0: 1, 1: 1, 2: 2, 3: 2 },
  2: { 0: 1, 1: 2, 2: 2, 3: 3 },
  3: { 0: 2, 1: 2, 2: 3, 3: 4 },
  4: { 0: 2, 1: 3, 2: 4, 3: 4 },
};
const RISK_CLASS_LABELS = { 1: "Gering", 2: "Mittel", 3: "Hoch", 4: "Sehr hoch" };
const RISK_CLASS_KEYS = { 1: "gering", 2: "mittel", 3: "hoch", 4: "sehrhoch" };

function clampValue(v, min, max) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function clampS(v) { return clampValue(v, 1, 4); }
function clampW(v) { return clampValue(v, 0, 3); }

function computeRisk(s, w) {
  s = clampS(s);
  w = clampW(w);
  const klasse = NOHL_MATRIX[s][w];
  return { klasse, label: RISK_CLASS_LABELS[klasse], key: RISK_CLASS_KEYS[klasse] };
}

const FRIST_LABELS = { sofort: "Sofort", kurzfristig: "Kurzfristig", mittelfristig: "Mittelfristig", langfristig: "Langfristig" };
const FRIST_OFFSET = {
  sofort: { unit: "days", amount: 7 },
  kurzfristig: { unit: "months", amount: 1 },
  mittelfristig: { unit: "months", amount: 3 },
  langfristig: { unit: "months", amount: 6 },
};

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Formatiert ein ISO-Datum (YYYY-MM-DD) als europäisches Datum (DD.MM.YYYY) für die Anzeige.
// Intern (Speicherung, Sortierung, Datumsrechnung) bleibt weiterhin das ISO-Format maßgeblich.
function formatDateEuropean(isoDateStr) {
  if (!isoDateStr) return "";
  const parts = isoDateStr.split("-");
  if (parts.length !== 3) return isoDateStr;
  const [y, m, d] = parts;
  return `${d}.${m}.${y}`;
}

// Formatiert einen Zeitstempel (Date.now()) als europäisches Datum mit Uhrzeit, für Kommentarverläufe.
function formatDateTimeEuropean(timestamp) {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()} ${hh}:${mm}`;
}

function berechneZieltermin(startDatum, frist) {
  const offset = FRIST_OFFSET[frist];
  if (!startDatum || !offset) return "";
  const d = new Date(startDatum + "T00:00:00");
  if (offset.unit === "days") {
    d.setDate(d.getDate() + offset.amount);
  } else {
    d.setMonth(d.getMonth() + offset.amount);
  }
  return formatDateLocal(d);
}

/* =========================================================
   Settings (API-Key etc.) - localStorage
   ========================================================= */
const SETTINGS_KEY = "begehung_ai_settings";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { provider: "anthropic", model: "claude-sonnet-5", apiKey: "" };
  } catch {
    return { provider: "anthropic", model: "claude-sonnet-5", apiKey: "" };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* =========================================================
   View-Wechsel
   ========================================================= */
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.hidden = true);
  document.getElementById(id).hidden = false;
  document.getElementById("tabBar").hidden = (id === "view-begehung");
}

/* =========================================================
   Start-Bildschirm: Liste der Begehungen
   ========================================================= */
async function renderBegehungList() {
  const list = document.getElementById("begehungList");
  const all = (await dbGetAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  const unternehmenAll = await dbGetAll(UNTERNEHMEN_STORE);
  const unternehmenMap = new Map(unternehmenAll.map(u => [u.id, u]));
  list.innerHTML = "";
  if (all.length === 0) {
    list.innerHTML = '<div class="empty-hint">Noch keine Begehungen erfasst.</div>';
    return;
  }
  for (const b of all) {
    const div = document.createElement("div");
    div.className = "begehung-item";
    const datum = formatDateEuropean(b.meta.datum);
    const anzahl = b.punkte.length;
    const u = unternehmenMap.get(b.meta.unternehmenId);
    const betriebLabel = u ? u.name : (b.meta.betrieb || "(ohne Unternehmen)");
    div.innerHTML = `
      <div class="begehung-item-info">
        <b>${escapeHtml(bezeichnung(b.meta))}</b>
        <span class="muted small">${escapeHtml(betriebLabel)} · ${datum} · ${anzahl} Punkt(e)</span>
      </div>
      <div class="begehung-item-actions">
        <button class="btn btn-ghost" data-action="delete">🗑️</button>
      </div>
    `;
    div.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        if (confirm("Diese Begehung wirklich löschen?")) {
          dbDelete(b.id).then(renderBegehungList);
        }
        return;
      }
      openBegehung(b);
    });
    list.appendChild(div);
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* =========================================================
   Unternehmen-Verwaltung
   ========================================================= */
let editingUnternehmenId = null; // Unternehmen, das gerade im Modal bearbeitet wird (null = neu)
let unternehmenLogoDataUrl = null;
let unternehmenLogoAspect = 1;

function computeImageAspect(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / img.naturalHeight || 1);
    img.onerror = () => resolve(1);
    img.src = dataUrl;
  });
}

async function getUnternehmenById(id) {
  if (!id) return null;
  return dbGet(id, UNTERNEHMEN_STORE);
}

async function renderUnternehmenList() {
  const list = document.getElementById("unternehmenList");
  const all = (await dbGetAll(UNTERNEHMEN_STORE)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  list.innerHTML = "";
  if (all.length === 0) {
    list.innerHTML = '<div class="empty-hint">Noch keine Unternehmen hinterlegt.</div>';
    return;
  }
  for (const u of all) {
    const div = document.createElement("div");
    div.className = "begehung-item";
    div.innerHTML = `
      <div class="unternehmen-item-info">
        ${u.logoDataUrl ? `<img class="unternehmen-logo-thumb" src="${u.logoDataUrl}">` : ""}
        <div>
          <b>${escapeHtml(u.name || "(ohne Name)")}</b>
          <span class="muted small">${escapeHtml(u.ansprechpartner || "")}</span>
        </div>
      </div>
      <div class="begehung-item-actions">
        <button class="btn btn-ghost" data-action="delete">🗑️</button>
      </div>
    `;
    div.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="delete"]')) {
        e.stopPropagation();
        if (confirm(`"${u.name}" wirklich löschen? Begehungen, die darauf verweisen, bleiben erhalten, verlieren aber die Verknüpfung.`)) {
          dbDelete(u.id, UNTERNEHMEN_STORE).then(() => {
            renderUnternehmenList();
            populateUnternehmenSelect();
          });
        }
        return;
      }
      openUnternehmenModal(u);
    });
    list.appendChild(div);
  }
}

function renderUnternehmenLogoPreview() {
  const wrap = document.getElementById("uLogoPreview");
  wrap.innerHTML = "";
  if (!unternehmenLogoDataUrl) return;
  const div = document.createElement("div");
  div.className = "foto-thumb";
  div.innerHTML = `<img src="${unternehmenLogoDataUrl}"><button class="remove">✕</button>`;
  div.querySelector(".remove").addEventListener("click", () => {
    unternehmenLogoDataUrl = null;
    renderUnternehmenLogoPreview();
  });
  wrap.appendChild(div);
}

function openUnternehmenModal(existing) {
  editingUnternehmenId = existing ? existing.id : null;
  document.getElementById("unternehmenModalTitle").textContent = existing ? "Unternehmen bearbeiten" : "Neues Unternehmen";
  document.getElementById("uName").value = existing ? (existing.name || "") : "";
  document.getElementById("uAdresse").value = existing ? (existing.adresse || "") : "";
  document.getElementById("uAnsprechpartner").value = existing ? (existing.ansprechpartner || "") : "";
  document.getElementById("uKontakt").value = existing ? (existing.kontakt || "") : "";
  document.getElementById("uLogo").value = "";
  unternehmenLogoDataUrl = existing ? (existing.logoDataUrl || null) : null;
  unternehmenLogoAspect = existing ? (existing.logoAspect || 1) : 1;
  renderUnternehmenLogoPreview();
  document.getElementById("unternehmenModal").hidden = false;
}

async function saveUnternehmenFromModal() {
  const name = document.getElementById("uName").value.trim();
  if (!name) {
    alert("Bitte einen Namen eingeben.");
    return;
  }
  const unternehmen = {
    id: editingUnternehmenId || uid(),
    name,
    adresse: document.getElementById("uAdresse").value.trim(),
    ansprechpartner: document.getElementById("uAnsprechpartner").value.trim(),
    kontakt: document.getElementById("uKontakt").value.trim(),
    logoDataUrl: unternehmenLogoDataUrl,
    logoAspect: unternehmenLogoAspect,
    createdAt: editingUnternehmenId ? undefined : Date.now(),
    updatedAt: Date.now(),
  };
  if (editingUnternehmenId) {
    const existing = await getUnternehmenById(editingUnternehmenId);
    unternehmen.createdAt = existing ? existing.createdAt : Date.now();
  }
  await dbPut(unternehmen, UNTERNEHMEN_STORE);
  document.getElementById("unternehmenModal").hidden = true;
  await renderUnternehmenList();
  await populateUnternehmenSelect();
}

async function populateUnternehmenSelect() {
  const select = document.getElementById("metaUnternehmenId");
  const currentValue = select.value;
  const all = (await dbGetAll(UNTERNEHMEN_STORE)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  select.innerHTML = '<option value="">— Kein Unternehmen / manuell —</option>' +
    all.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  if (all.some(u => u.id === currentValue)) select.value = currentValue;
}

/* =========================================================
   Tab-Umschaltung (Begehungen / Maßnahmen / Unternehmen)
   ========================================================= */
function switchTab(tab) {
  document.getElementById("tabBtnBegehungen").classList.toggle("active", tab === "begehungen");
  document.getElementById("tabBtnMassnahmen").classList.toggle("active", tab === "massnahmen");
  document.getElementById("tabBtnUnternehmen").classList.toggle("active", tab === "unternehmen");
  if (tab === "unternehmen") {
    showView("view-unternehmen");
    renderUnternehmenList();
  } else if (tab === "massnahmen") {
    showView("view-massnahmen");
    populateMassnahmenUnternehmenFilter();
    renderMassnahmenListe();
  } else {
    showView("view-start");
    renderBegehungList();
  }
}

function bezeichnung(meta) {
  return `${meta.art || "Arbeitsschutzbegehung"} ${meta.jahr || ""}-${meta.nummer || ""}`;
}

function updateBezeichnungDisplay() {
  const meta = {
    art: document.getElementById("metaArt").value,
    jahr: document.getElementById("metaJahr").value,
    nummer: document.getElementById("metaNummer").value,
  };
  document.getElementById("metaBezeichnung").textContent = bezeichnung(meta);
}

async function suggestNextNummer(art, jahr, unternehmenId) {
  const all = await dbGetAll();
  const relevant = all.filter(b =>
    b.meta.art === art &&
    String(b.meta.jahr) === String(jahr) &&
    (b.meta.unternehmenId || "") === (unternehmenId || "") &&
    b.id !== (currentBegehung && currentBegehung.id)
  );
  const maxNummer = relevant.reduce((max, b) => Math.max(max, Number(b.meta.nummer) || 0), 0);
  return maxNummer + 1;
}

async function refreshNummerSuggestion() {
  const nummerInput = document.getElementById("metaNummer");
  if (nummerInput.value) return; // Nutzer hat bereits einen Wert gesetzt
  const art = document.getElementById("metaArt").value;
  const jahr = document.getElementById("metaJahr").value;
  const unternehmenId = document.getElementById("metaUnternehmenId").value;
  nummerInput.value = await suggestNextNummer(art, jahr, unternehmenId);
  updateBezeichnungDisplay();
}

async function openBegehung(b) {
  currentBegehung = b;
  await populateUnternehmenSelect();
  document.getElementById("metaArt").value = b.meta.art || "Arbeitsschutzbegehung";
  document.getElementById("metaJahr").value = b.meta.jahr || new Date().getFullYear();
  document.getElementById("metaNummer").value = b.meta.nummer || "";
  document.getElementById("metaUnternehmenId").value = b.meta.unternehmenId || "";
  document.getElementById("metaBetrieb").value = b.meta.betrieb || "";
  document.getElementById("metaDatum").value = b.meta.datum || "";
  document.getElementById("metaBegeher").value = b.meta.begeher || "";
  document.getElementById("metaTeilnehmer").value = b.meta.teilnehmer || "";
  updateBezeichnungDisplay();
  resetPunktForm();
  renderPunkteList();
  showView("view-begehung");
}

async function createNewBegehung() {
  const jahr = new Date().getFullYear();
  const art = "Arbeitsschutzbegehung";
  currentBegehung = {
    id: uid(),
    meta: { art, jahr, nummer: "", unternehmenId: "", betrieb: "", datum: formatDateLocal(new Date()), begeher: "", teilnehmer: "" },
    punkte: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await populateUnternehmenSelect();
  document.getElementById("metaArt").value = art;
  document.getElementById("metaJahr").value = jahr;
  document.getElementById("metaNummer").value = "";
  document.getElementById("metaUnternehmenId").value = "";
  document.getElementById("metaBetrieb").value = "";
  document.getElementById("metaDatum").value = currentBegehung.meta.datum;
  document.getElementById("metaBegeher").value = "";
  document.getElementById("metaTeilnehmer").value = "";
  resetPunktForm();
  renderPunkteList();
  showView("view-begehung");
  await refreshNummerSuggestion();
  currentBegehung.meta.nummer = document.getElementById("metaNummer").value;
  dbPut(currentBegehung);
}

function persistMeta() {
  if (!currentBegehung) return;
  currentBegehung.meta.art = document.getElementById("metaArt").value;
  currentBegehung.meta.jahr = document.getElementById("metaJahr").value;
  currentBegehung.meta.nummer = document.getElementById("metaNummer").value;
  currentBegehung.meta.unternehmenId = document.getElementById("metaUnternehmenId").value;
  currentBegehung.meta.betrieb = document.getElementById("metaBetrieb").value;
  currentBegehung.meta.datum = document.getElementById("metaDatum").value;
  currentBegehung.meta.begeher = document.getElementById("metaBegeher").value;
  currentBegehung.meta.teilnehmer = document.getElementById("metaTeilnehmer").value;
  currentBegehung.updatedAt = Date.now();
  updateBezeichnungDisplay();
  dbPut(currentBegehung);
}

/* =========================================================
   Fotos: Aufnahme + Komprimierung
   ========================================================= */
function compressImage(file, maxWidth = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderFotoPreview() {
  const wrap = document.getElementById("fotoPreview");
  wrap.innerHTML = "";
  currentFotos.forEach((dataUrl, idx) => {
    const div = document.createElement("div");
    div.className = "foto-thumb";
    div.innerHTML = `<img src="${dataUrl}"><button class="remove" data-idx="${idx}">✕</button>`;
    wrap.appendChild(div);
  });
  wrap.querySelectorAll(".remove").forEach(btn => {
    btn.addEventListener("click", () => {
      currentFotos.splice(Number(btn.dataset.idx), 1);
      renderFotoPreview();
    });
  });
}

/* =========================================================
   Risiko-Begehung Anzeige + Maßnahmen-Formular
   ========================================================= */
function updateInitRiskBadge() {
  const s = document.getElementById("pInitS").value;
  const w = document.getElementById("pInitW").value;
  const risk = computeRisk(s, w);
  const badge = document.getElementById("pInitRiskBadge");
  badge.textContent = `Risiko: ${risk.label.toUpperCase()}`;
  badge.className = `risk-badge risk-${risk.key}`;
}

const FORTSCHRITT_STUFEN = [0, 25, 50, 75, 100];

function clampFortschritt(v) {
  const n = Number(v);
  return FORTSCHRITT_STUFEN.includes(n) ? n : 0;
}

function leereMassnahme() {
  return { id: uid(), text: "", verantwortlicher: "", frist: "kurzfristig", sNach: 1, wNach: 0, fortschritt: 0, wirksamkeitskontrolle: "", kommentare: [] };
}

function renderMassnahmenForm() {
  const wrap = document.getElementById("massnahmenList");
  const begehungsDatum = document.getElementById("metaDatum").value;
  wrap.innerHTML = "";
  currentMassnahmen.forEach((m, idx) => {
    const risk = computeRisk(m.sNach, m.wNach);
    const zieltermin = berechneZieltermin(begehungsDatum, m.frist);
    const div = document.createElement("div");
    div.className = "massnahme-row";
    div.innerHTML = `
      <div class="massnahme-row-header">
        <b>Maßnahme ${idx + 1}</b>
        <button type="button" class="btn btn-ghost" data-action="remove-massnahme" data-idx="${idx}">✕ entfernen</button>
      </div>
      <textarea rows="2" data-field="text" data-idx="${idx}" placeholder="Maßnahmenbeschreibung">${escapeHtml(m.text)}</textarea>
      <label>Verantwortlicher
        <input type="text" data-field="verantwortlicher" data-idx="${idx}" value="${escapeHtml(m.verantwortlicher || "")}" placeholder="Name / Funktion">
      </label>
      <div class="form-grid">
        <label>Frist
          <select data-field="frist" data-idx="${idx}">
            ${Object.keys(FRIST_LABELS).map(key => `<option value="${key}" ${m.frist === key ? "selected" : ""}>${FRIST_LABELS[key]}</option>`).join("")}
          </select>
        </label>
        <label>Zieltermin
          <input type="text" value="${formatDateEuropean(zieltermin) || "Begehungsdatum fehlt"}" disabled>
        </label>
      </div>
      <div class="form-grid">
        <label>Schadensschwere nach Maßnahme
          <select data-field="sNach" data-idx="${idx}">
            ${[1, 2, 3, 4].map(v => `<option value="${v}" ${Number(m.sNach) === v ? "selected" : ""}>${v} – ${S_LABELS[v]}</option>`).join("")}
          </select>
        </label>
        <label>Wahrscheinlichkeit nach Maßnahme
          <select data-field="wNach" data-idx="${idx}">
            ${[0, 1, 2, 3].map(v => `<option value="${v}" ${Number(m.wNach) === v ? "selected" : ""}>${v} – ${W_LABELS[v]}</option>`).join("")}
          </select>
        </label>
      </div>
      <span class="risk-badge risk-${risk.key}">Risiko nach Maßnahme: ${risk.label.toUpperCase()}</span>
      <div class="form-grid" style="margin-top:10px;">
        <label>Fortschritt
          <select data-field="fortschritt" data-idx="${idx}">
            ${FORTSCHRITT_STUFEN.map(v => `<option value="${v}" ${clampFortschritt(m.fortschritt) === v ? "selected" : ""}>${v}%</option>`).join("")}
          </select>
        </label>
        <label>Wirksamkeitskontrolle durch SiFa
          <input type="text" data-field="wirksamkeitskontrolle" data-idx="${idx}" value="${escapeHtml(m.wirksamkeitskontrolle || "")}" placeholder="z.B. wirksam, geprüft am ...">
        </label>
      </div>
    `;
    wrap.appendChild(div);
  });
}

function addMassnahmeRow() {
  currentMassnahmen.push(leereMassnahme());
  renderMassnahmenForm();
}

/* =========================================================
   Spracheingabe
   ========================================================= */
let recognizer = null;
let isRecording = false;

function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById("btnMic");
  const micStatus = document.getElementById("micStatus");
  if (!SR) {
    micBtn.disabled = true;
    micStatus.textContent = "Spracheingabe wird von diesem Browser nicht unterstützt.";
    return;
  }
  recognizer = new SR();
  recognizer.lang = "de-DE";
  recognizer.continuous = true;
  recognizer.interimResults = false;

  recognizer.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    const ta = document.getElementById("pNotiz");
    ta.value = (ta.value ? ta.value.trim() + " " : "") + transcript.trim();
  };
  recognizer.onerror = (e) => {
    micStatus.textContent = "Fehler bei Spracherkennung: " + e.error;
  };
  recognizer.onend = () => {
    isRecording = false;
    micBtn.classList.remove("recording");
    micStatus.textContent = "";
  };

  micBtn.addEventListener("click", () => {
    if (isRecording) {
      recognizer.stop();
      isRecording = false;
      micBtn.classList.remove("recording");
      micStatus.textContent = "";
    } else {
      recognizer.start();
      isRecording = true;
      micBtn.classList.add("recording");
      micStatus.textContent = "Aufnahme läuft...";
    }
  });
}

/* =========================================================
   KI-Anbindung
   ========================================================= */
function buildAiPrompt(kategorie, standort, notiz) {
  return `Du unterstützt bei einer Arbeitsschutz-/Brandschutz-Begehung. Aus Stichpunkten eines Sicherheitsbeauftragten sollst du einen professionellen Befund erstellen und die Gefährdung nach der Risikomatrix nach Nohl einstufen.

Kategorie: ${kategorie}
Standort/Bereich: ${standort || "(nicht angegeben)"}
Stichpunkte des Begehers: ${notiz}

Nutze für die Einstufung folgende Skalen:
Schadensausmaß (1-4): 1=Leichte Verletzungen/Erkrankungen, 2=Mittelschwere Verletzungen/Erkrankungen, 3=Schwere Verletzung/Bleibende Schäden, 4=Möglicher Tod, Katastrophe
Eintrittswahrscheinlichkeit (0-3): 0=Sehr gering, 1=Gering, 2=Mittel, 3=Hoch

Schlage GENAU 2 priorisierte, konkrete Maßnahmen vor (die wichtigste zuerst). Für jede Maßnahme: das nach ihrer Umsetzung verbleibende Restrisiko (ebenfalls Schadensausmaß 1-4 / Wahrscheinlichkeit 0-3) und eine Frist.

Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt in genau diesem Format, ohne weiteren Text, ohne Markdown-Codeblock:
{
  "befund": "Sachlich formulierter Befund in 2-4 Sätzen",
  "schadensschwereBegehung": 1,
  "wahrscheinlichkeitBegehung": 1,
  "massnahmen": [
    {
      "text": "Konkreter, umsetzbarer Maßnahmenvorschlag",
      "frist": "sofort" | "kurzfristig" | "mittelfristig" | "langfristig",
      "schadensschwereNachMassnahme": 1,
      "wahrscheinlichkeitNachMassnahme": 1
    }
  ]
}`;
}

function parseAiJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Keine gültige JSON-Antwort erhalten.");
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error("Die KI-Antwort war unvollständig oder fehlerhaft formatiert (evtl. wegen Token-Limit abgeschnitten). Bitte erneut versuchen oder Notiz kürzen.");
  }
}

async function callAnthropic(settings, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model || "claude-sonnet-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API Fehler (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    throw new Error("Die KI-Antwort wurde wegen des Token-Limits abgeschnitten. Bitte erneut versuchen oder Notiz kürzen.");
  }
  return data.content.map(c => c.text || "").join("");
}

async function callOpenAi(settings, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model || "gpt-4o-mini",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API Fehler (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.choices[0].finish_reason === "length") {
    throw new Error("Die KI-Antwort wurde wegen des Token-Limits abgeschnitten. Bitte erneut versuchen oder Notiz kürzen.");
  }
  return data.choices[0].message.content;
}

async function enhanceWithAi() {
  const settings = loadSettings();
  const statusEl = document.getElementById("aiStatus");
  const kategorie = document.getElementById("pKategorie").value;
  const standort = document.getElementById("pStandort").value;
  const notiz = document.getElementById("pNotiz").value.trim();

  if (!notiz) {
    statusEl.textContent = "Bitte zuerst eine Notiz eingeben.";
    return;
  }
  if (settings.provider === "none" || !settings.apiKey) {
    statusEl.textContent = "Kein API-Key hinterlegt (⚙️ Einstellungen). Felder unten manuell ausfüllen.";
    document.getElementById("pBefund").value = notiz;
    return;
  }

  statusEl.textContent = "KI denkt nach...";
  document.getElementById("btnAiEnhance").disabled = true;
  try {
    const prompt = buildAiPrompt(kategorie, standort, notiz);
    const raw = settings.provider === "openai"
      ? await callOpenAi(settings, prompt)
      : await callAnthropic(settings, prompt);
    const parsed = parseAiJson(raw);

    document.getElementById("pBefund").value = parsed.befund || notiz;
    document.getElementById("pInitS").value = clampS(parsed.schadensschwereBegehung);
    document.getElementById("pInitW").value = clampW(parsed.wahrscheinlichkeitBegehung);
    updateInitRiskBadge();

    currentMassnahmen = Array.isArray(parsed.massnahmen)
      ? parsed.massnahmen.map(m => ({
          id: uid(),
          text: m.text || "",
          frist: Object.keys(FRIST_LABELS).includes(m.frist) ? m.frist : "kurzfristig",
          sNach: clampS(m.schadensschwereNachMassnahme),
          wNach: clampW(m.wahrscheinlichkeitNachMassnahme),
        }))
      : [];
    // Immer genau 2 Maßnahmen-Zeilen anzeigen, auch falls die KI mehr/weniger liefert
    while (currentMassnahmen.length < 2) currentMassnahmen.push(leereMassnahme());
    currentMassnahmen = currentMassnahmen.slice(0, 2);
    renderMassnahmenForm();

    statusEl.textContent = "Vorschlag erstellt – bitte prüfen und bei Bedarf anpassen.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Fehler: " + err.message;
    document.getElementById("pBefund").value = notiz;
  } finally {
    document.getElementById("btnAiEnhance").disabled = false;
  }
}

/* =========================================================
   Punkte erfassen / anzeigen
   ========================================================= */
let editingPunktId = null; // ID des Punkts, der gerade bearbeitet wird (null = neuer Punkt)

function resetPunktForm() {
  editingPunktId = null;
  document.getElementById("btnAddPunkt").textContent = "+ Punkt hinzufügen";
  document.getElementById("btnCancelEditPunkt").hidden = true;
  document.getElementById("pKategorie").selectedIndex = 0;
  document.getElementById("pStandort").value = "";
  document.getElementById("pNotiz").value = "";
  document.getElementById("pFotos").value = "";
  document.getElementById("pBefund").value = "";
  document.getElementById("pInitS").value = "1";
  document.getElementById("pInitW").value = "0";
  updateInitRiskBadge();
  document.getElementById("aiStatus").textContent = "";
  currentFotos = [];
  renderFotoPreview();
  currentMassnahmen = [leereMassnahme(), leereMassnahme()];
  renderMassnahmenForm();
}

function startEditPunkt(p) {
  editingPunktId = p.id;
  document.getElementById("btnAddPunkt").textContent = "Änderungen speichern";
  document.getElementById("btnCancelEditPunkt").hidden = false;

  document.getElementById("pKategorie").value = p.kategorie;
  document.getElementById("pStandort").value = p.standort || "";
  document.getElementById("pNotiz").value = p.notizRoh || "";
  document.getElementById("pFotos").value = "";
  document.getElementById("pBefund").value = p.befund || "";
  const initRisk = p.risikoInitial || { s: 1, w: 1 };
  document.getElementById("pInitS").value = clampS(initRisk.s);
  document.getElementById("pInitW").value = clampW(initRisk.w);
  updateInitRiskBadge();
  document.getElementById("aiStatus").textContent = "";

  currentFotos = [...(p.fotos || [])];
  renderFotoPreview();

  const massnahmen = punktMassnahmen(p);
  currentMassnahmen = massnahmen.length
    ? massnahmen.map(m => ({
        id: m.id || uid(),
        text: m.text || "",
        verantwortlicher: m.verantwortlicher || "",
        frist: m.frist || "kurzfristig",
        sNach: m.risikoNach ? clampS(m.risikoNach.s) : 1,
        wNach: m.risikoNach ? clampW(m.risikoNach.w) : 0,
        fortschritt: clampFortschritt(m.fortschritt),
        wirksamkeitskontrolle: m.wirksamkeitskontrolle || "",
        kommentare: m.kommentare || [],
      }))
    : [leereMassnahme(), leereMassnahme()];
  renderMassnahmenForm();

  document.getElementById("btnAddPunkt").scrollIntoView({ behavior: "smooth", block: "center" });
}

function addPunkt() {
  if (!currentBegehung) return;
  const notiz = document.getElementById("pNotiz").value.trim();
  const befund = document.getElementById("pBefund").value.trim();
  if (!notiz && !befund) {
    alert("Bitte mindestens eine Notiz oder einen Befund erfassen.");
    return;
  }
  const begehungsDatum = currentBegehung.meta.datum;
  const massnahmen = currentMassnahmen
    .filter(m => m.text && m.text.trim())
    .map(m => ({
      id: m.id,
      text: m.text.trim(),
      verantwortlicher: (m.verantwortlicher || "").trim(),
      frist: m.frist,
      zieltermin: berechneZieltermin(begehungsDatum, m.frist),
      risikoNach: { s: clampS(m.sNach), w: clampW(m.wNach) },
      fortschritt: clampFortschritt(m.fortschritt),
      wirksamkeitskontrolle: (m.wirksamkeitskontrolle || "").trim(),
      kommentare: m.kommentare || [],
    }));

  const gemeinsameFelder = {
    kategorie: document.getElementById("pKategorie").value,
    standort: document.getElementById("pStandort").value.trim(),
    notizRoh: notiz,
    befund: befund || notiz,
    risikoInitial: {
      s: clampS(document.getElementById("pInitS").value),
      w: clampW(document.getElementById("pInitW").value),
    },
    massnahmen,
    fotos: [...currentFotos],
  };

  if (editingPunktId) {
    const idx = currentBegehung.punkte.findIndex(p => p.id === editingPunktId);
    if (idx !== -1) {
      currentBegehung.punkte[idx] = { ...currentBegehung.punkte[idx], ...gemeinsameFelder };
    }
  } else {
    currentBegehung.punkte.push({ id: uid(), ...gemeinsameFelder, createdAt: Date.now() });
  }
  currentBegehung.updatedAt = Date.now();
  dbPut(currentBegehung);
  resetPunktForm();
  renderPunkteList();
}

function punktInitialRisk(p) {
  // Fallback für Punkte aus einer älteren App-Version ohne Nohl-Matrix
  if (p.risikoInitial) return computeRisk(p.risikoInitial.s, p.risikoInitial.w);
  if (p.risiko === "hoch") return { label: "Hoch", key: "hoch" };
  if (p.risiko === "niedrig") return { label: "Gering", key: "gering" };
  if (p.risiko) return { label: "Mittel", key: "mittel" };
  return null;
}

function punktMassnahmen(p) {
  if (p.massnahmen) return p.massnahmen.map(m => ({ fortschritt: 0, wirksamkeitskontrolle: "", kommentare: [], ...m }));
  if (p.massnahme) return [{ id: p.id + "_legacy", text: p.massnahme, frist: p.frist, zieltermin: "", risikoNach: null, fortschritt: 0, wirksamkeitskontrolle: "", kommentare: [] }];
  return [];
}

function renderPunkteList() {
  const list = document.getElementById("punkteList");
  document.getElementById("punkteCount").textContent = currentBegehung.punkte.length;
  list.innerHTML = "";
  currentBegehung.punkte.forEach((p, idx) => {
    const div = document.createElement("div");
    div.className = "punkt-item";

    const initRisk = punktInitialRisk(p);
    const massnahmen = punktMassnahmen(p);
    const massnahmenHtml = massnahmen.map((m, mi) => {
      const rBadge = m.risikoNach
        ? (() => { const r = computeRisk(m.risikoNach.s, m.risikoNach.w); return `<span class="risk-badge risk-${r.key}">nach Maßnahme: ${r.label.toUpperCase()}</span>`; })()
        : "";
      return `<div class="massnahme-display">
        <p><b>Maßnahme ${mi + 1}:</b> ${escapeHtml(m.text)}</p>
        <p class="muted small">Verantwortlich: ${escapeHtml(m.verantwortlicher || "-")} · Frist: ${escapeHtml(FRIST_LABELS[m.frist] || m.frist || "-")} · Zieltermin: ${escapeHtml(formatDateEuropean(m.zieltermin) || "-")} · Fortschritt: ${clampFortschritt(m.fortschritt)}%</p>
        ${m.wirksamkeitskontrolle ? `<p class="muted small">Wirksamkeitskontrolle SiFa: ${escapeHtml(m.wirksamkeitskontrolle)}</p>` : ""}
        ${rBadge}
      </div>`;
    }).join("");

    div.innerHTML = `
      <div class="punkt-header">
        <span class="punkt-title">${idx + 1}. ${escapeHtml(p.kategorie)}${p.standort ? " – " + escapeHtml(p.standort) : ""}</span>
        ${initRisk ? `<span class="risk-badge risk-${initRisk.key}">Begehung: ${initRisk.label.toUpperCase()}</span>` : ""}
      </div>
      <div class="punkt-body">
        <p>${escapeHtml(p.befund)}</p>
        ${massnahmenHtml}
        <div class="punkt-thumbs">${(p.fotos || []).map(f => `<img src="${f}">`).join("")}</div>
      </div>
      <div class="punkt-actions">
        <button class="btn btn-ghost" data-action="edit">Bearbeiten</button>
        <button class="btn btn-ghost" data-action="del">Löschen</button>
      </div>
    `;
    div.querySelector('[data-action="edit"]').addEventListener("click", () => startEditPunkt(p));
    div.querySelector('[data-action="del"]').addEventListener("click", () => {
      if (confirm("Diesen Punkt löschen?")) {
        if (editingPunktId === p.id) resetPunktForm();
        currentBegehung.punkte.splice(idx, 1);
        currentBegehung.updatedAt = Date.now();
        dbPut(currentBegehung);
        renderPunkteList();
      }
    });
    list.appendChild(div);
  });
}

/* =========================================================
   Maßnahmenliste (pro Unternehmen, über alle Begehungen hinweg)
   ========================================================= */
const NONE_UNTERNEHMEN_VALUE = "__ohne__";

async function populateMassnahmenUnternehmenFilter() {
  const select = document.getElementById("massnahmenUnternehmenFilter");
  const currentValue = select.value;
  const all = (await dbGetAll(UNTERNEHMEN_STORE)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  select.innerHTML = '<option value="">— Unternehmen wählen —</option>' +
    all.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("") +
    `<option value="${NONE_UNTERNEHMEN_VALUE}">— Ohne Unternehmen —</option>`;
  if (currentValue && (currentValue === NONE_UNTERNEHMEN_VALUE || all.some(u => u.id === currentValue))) {
    select.value = currentValue;
  }
}

function findOrMigrateMassnahme(begehung, punktId, massnahmeId) {
  const punkt = begehung.punkte.find(p => p.id === punktId);
  if (!punkt) return null;
  if (!punkt.massnahmen) {
    // Alter Punkt ohne Maßnahmen-Array (einzelnes Textfeld) - beim ersten Bearbeiten migrieren
    punkt.massnahmen = punktMassnahmen(punkt).map(m => ({ ...m }));
    delete punkt.massnahme;
  }
  return punkt.massnahmen.find(m => m.id === massnahmeId) || null;
}

async function updateMassnahmeField(begehungId, punktId, massnahmeId, field, value) {
  const begehung = await dbGet(begehungId);
  if (!begehung) return;
  const massnahme = findOrMigrateMassnahme(begehung, punktId, massnahmeId);
  if (!massnahme) return;
  if (field === "fortschritt") {
    massnahme.fortschritt = clampFortschritt(value);
  } else if (field === "wirksamkeitskontrolle") {
    massnahme.wirksamkeitskontrolle = value;
  }
  begehung.updatedAt = Date.now();
  await dbPut(begehung);
}

async function addMassnahmeKommentar(begehungId, punktId, massnahmeId, text) {
  if (!text || !text.trim()) return;
  const begehung = await dbGet(begehungId);
  if (!begehung) return;
  const massnahme = findOrMigrateMassnahme(begehung, punktId, massnahmeId);
  if (!massnahme) return;
  if (!massnahme.kommentare) massnahme.kommentare = [];
  massnahme.kommentare.push({ id: uid(), text: text.trim(), datum: Date.now() });
  begehung.updatedAt = Date.now();
  await dbPut(begehung);
}

async function renderMassnahmenListe() {
  const container = document.getElementById("massnahmenListeContainer");
  const selected = document.getElementById("massnahmenUnternehmenFilter").value;
  container.innerHTML = "";
  if (!selected) {
    container.innerHTML = '<div class="empty-hint">Bitte oben ein Unternehmen wählen, um dessen Maßnahmenliste zu sehen.</div>';
    return;
  }

  const alleBegehungen = await dbGetAll();
  const passendeBegehungen = alleBegehungen.filter(b => {
    const bUnternehmenId = b.meta.unternehmenId || "";
    return selected === NONE_UNTERNEHMEN_VALUE ? !bUnternehmenId : bUnternehmenId === selected;
  });

  const zeilen = [];
  passendeBegehungen.forEach(b => {
    (b.punkte || []).forEach(p => {
      punktMassnahmen(p).forEach(m => {
        if (m.text) zeilen.push({ begehung: b, punkt: p, massnahme: m });
      });
    });
  });

  if (zeilen.length === 0) {
    container.innerHTML = '<div class="empty-hint">Noch keine Maßnahmen für dieses Unternehmen erfasst.</div>';
    return;
  }

  zeilen.sort((a, b) => (a.massnahme.zieltermin || "9999-99-99").localeCompare(b.massnahme.zieltermin || "9999-99-99"));

  const heute = formatDateLocal(new Date());
  zeilen.forEach(({ begehung, punkt, massnahme: m }) => {
    const div = document.createElement("div");
    div.className = "massnahmenliste-item";
    const fortschritt = clampFortschritt(m.fortschritt);
    const ueberfaellig = m.zieltermin && m.zieltermin < heute && fortschritt < 100;
    const rNachHtml = m.risikoNach
      ? (() => { const r = computeRisk(m.risikoNach.s, m.risikoNach.w); return `<span class="risk-badge risk-${r.key}">${r.label.toUpperCase()}</span>`; })()
      : "";
    div.innerHTML = `
      <div class="massnahmenliste-header">
        <span class="muted small">${escapeHtml(bezeichnung(begehung.meta))} · ${escapeHtml(formatDateEuropean(begehung.meta.datum))} · ${escapeHtml(punkt.kategorie)}${punkt.standort ? " – " + escapeHtml(punkt.standort) : ""}</span>
        ${ueberfaellig ? '<span class="ueberfaellig-badge">Überfällig</span>' : ""}
      </div>
      <p class="massnahmenliste-text">${escapeHtml(m.text)}</p>
      <p class="muted small">Verantwortlich: ${escapeHtml(m.verantwortlicher || "-")} · Frist: ${escapeHtml(FRIST_LABELS[m.frist] || m.frist || "-")} · Zieltermin: ${escapeHtml(formatDateEuropean(m.zieltermin) || "-")} ${rNachHtml}</p>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${fortschritt}%"></div></div>
      <div class="form-grid" style="margin-top:8px;">
        <label>Fortschritt
          <select data-begehung="${begehung.id}" data-punkt="${punkt.id}" data-massnahme="${m.id}" data-field="fortschritt">
            ${FORTSCHRITT_STUFEN.map(v => `<option value="${v}" ${fortschritt === v ? "selected" : ""}>${v}%</option>`).join("")}
          </select>
        </label>
        <label>Wirksamkeitskontrolle durch SiFa
          <input type="text" data-begehung="${begehung.id}" data-punkt="${punkt.id}" data-massnahme="${m.id}" data-field="wirksamkeitskontrolle" value="${escapeHtml(m.wirksamkeitskontrolle || "")}" placeholder="z.B. wirksam, geprüft am ...">
        </label>
      </div>
      <div class="kommentar-block">
        <div class="block-label">Verlauf / Kommentare</div>
        <div class="kommentar-liste">
          ${
            (m.kommentare && m.kommentare.length)
              ? [...m.kommentare].reverse().map(k => `<div class="kommentar-eintrag"><span class="kommentar-datum">${formatDateTimeEuropean(k.datum)}</span> ${escapeHtml(k.text)}</div>`).join("")
              : '<p class="muted small">Noch keine Kommentare.</p>'
          }
        </div>
        <div class="kommentar-add">
          <input type="text" data-action="kommentar-input" data-begehung="${begehung.id}" data-punkt="${punkt.id}" data-massnahme="${m.id}" placeholder="Kommentar zur Abarbeitung hinzufügen...">
          <button type="button" class="btn btn-ghost" data-action="add-kommentar" data-begehung="${begehung.id}" data-punkt="${punkt.id}" data-massnahme="${m.id}">+ Hinzufügen</button>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

/* =========================================================
   PDF-Erstellung
   ========================================================= */
const RISK_COLOR = {
  gering: [47, 158, 68],
  niedrig: [47, 158, 68],
  mittel: [217, 169, 31],
  hoch: [232, 89, 12],
  sehrhoch: [214, 69, 69],
};

const BRAND_BLUE = [42, 155, 214];
const BRAND_GRAY = [140, 140, 140];
const BRAND_DARKGRAY = [74, 74, 74];

async function createPdf() {
  persistMeta();
  await logoReady;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  function ensureSpace(needed) {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  // Kopfzeile: Kunden-Logo (verknüpftes Unternehmen) oben links, eigenes Logo oben rechts
  const meta = currentBegehung.meta;
  const unternehmen = await getUnternehmenById(meta.unternehmenId);
  const betriebLabel = unternehmen ? unternehmen.name : (meta.betrieb || "-");

  const logoWidth = 68;
  let textStartX = margin;
  let headerBlockHeight = 38;

  if (unternehmen && unternehmen.logoDataUrl) {
    const custLogoHeight = logoWidth / (unternehmen.logoAspect || 1);
    try {
      doc.addImage(unternehmen.logoDataUrl, "JPEG", margin, y, logoWidth, custLogoHeight);
      textStartX = margin + logoWidth + 16;
      headerBlockHeight = Math.max(headerBlockHeight, custLogoHeight);
    } catch (e) { /* Kunden-Logo konnte nicht eingebettet werden */ }
  }

  if (logoDataUrl) {
    const ownLogoHeight = logoWidth / logoAspect;
    try {
      doc.addImage(logoDataUrl, "JPEG", pageWidth - margin - logoWidth, y, logoWidth, ownLogoHeight);
      headerBlockHeight = Math.max(headerBlockHeight, ownLogoHeight);
    } catch (e) { /* Eigenes Logo konnte nicht eingebettet werden */ }
  }

  doc.setFontSize(17);
  doc.setFont(undefined, "bold");
  doc.setTextColor(...BRAND_DARKGRAY);
  doc.text(bezeichnung(meta), textStartX, y + headerBlockHeight / 2 - 5);
  doc.setFontSize(10.5);
  doc.setFont(undefined, "normal");
  doc.setTextColor(...BRAND_GRAY);
  doc.text(betriebLabel, textStartX, y + headerBlockHeight / 2 + 12);
  doc.setTextColor(0, 0, 0);

  y += headerBlockHeight + 12;
  doc.setDrawColor(...BRAND_BLUE);
  doc.setLineWidth(2);
  doc.line(margin, y, pageWidth - margin, y);
  doc.setLineWidth(1);
  y += 20;

  doc.setFontSize(10.5);
  doc.setFont(undefined, "normal");
  doc.setTextColor(60, 60, 60);
  const metaLines = [];
  if (unternehmen) {
    (unternehmen.adresse || "").split(/\r?\n/).forEach(line => { if (line.trim()) metaLines.push(line.trim()); });
    const kontaktParts = [unternehmen.ansprechpartner, unternehmen.kontakt].filter(Boolean).join(" · ");
    if (kontaktParts) metaLines.push(`Ansprechpartner: ${kontaktParts}`);
    if (meta.betrieb) metaLines.push(`Standort/Zusatz: ${meta.betrieb}`);
  }
  metaLines.push(`Datum: ${formatDateEuropean(meta.datum) || "-"}`);
  metaLines.push(`Begeher/in: ${meta.begeher || "-"}`);
  if (meta.teilnehmer) metaLines.push(`Teilnehmer: ${meta.teilnehmer}`);
  metaLines.forEach(line => { doc.text(line, margin, y); y += 15; });
  doc.setTextColor(0, 0, 0);
  y += 6;
  doc.setDrawColor(225);
  doc.line(margin, y, pageWidth - margin, y);
  y += 22;

  // Schätzt die Gesamthöhe eines Punkts, damit er als Ganzes auf eine Seite passt (kein Seitensprung mittendrin).
  function measurePunktHeight(p, idx) {
    let h = 18; // Titelzeile
    const initRisk = punktInitialRisk(p);
    if (initRisk) h += 18;

    doc.setFontSize(10.5);
    doc.setFont(undefined, "normal");
    const befundLines = doc.splitTextToSize(`Befund: ${p.befund}`, pageWidth - margin * 2);
    h += befundLines.length * 13 + 6;

    punktMassnahmen(p).forEach((m, mi) => {
      doc.setFontSize(10.5);
      const mLines = doc.splitTextToSize(`Maßnahme ${mi + 1}: ${m.text}`, pageWidth - margin * 2 - 10);
      h += mLines.length * 13 + 2;
      h += 14; // Verantwortlich/Frist/Zieltermin-Zeile
      if (m.risikoNach) h += 16;
      h += 6;
    });

    if (p.fotos && p.fotos.length) {
      const thumbSize = 110;
      let x = margin;
      let rows = 1;
      p.fotos.forEach(() => {
        if (x + thumbSize > pageWidth - margin) { x = margin; rows++; }
        x += thumbSize + 8;
      });
      h += rows * (thumbSize + 8) + 6;
    } else {
      h += 6;
    }

    h += 10 + 18; // Trennlinie + Abstand
    return h;
  }

  currentBegehung.punkte.forEach((p, idx) => {
    const nutzbareHoehe = pageHeight - margin * 2;
    const benoetigteHoehe = measurePunktHeight(p, idx);
    // Passt der komplette Punkt nicht mehr auf die aktuelle Seite (aber auf eine ganze Seite), Seitenumbruch davor erzwingen.
    if (benoetigteHoehe <= nutzbareHoehe) {
      ensureSpace(benoetigteHoehe);
    } else {
      ensureSpace(90);
    }
    doc.setFontSize(13);
    doc.setFont(undefined, "bold");
    doc.setTextColor(...BRAND_DARKGRAY);
    doc.text(`${idx + 1}. ${p.kategorie}${p.standort ? " – " + p.standort : ""}`, margin, y);
    doc.setTextColor(0, 0, 0);
    y += 18;

    const initRisk = punktInitialRisk(p);
    if (initRisk) {
      const color = RISK_COLOR[initRisk.key] || [100, 100, 100];
      doc.setFillColor(...color);
      doc.roundedRect(margin, y - 11, 160, 16, 3, 3, "F");
      doc.setFontSize(9);
      doc.setTextColor(255, 255, 255);
      doc.text(`Risiko bei Begehung: ${initRisk.label.toUpperCase()}`, margin + 6, y);
      doc.setTextColor(0, 0, 0);
      y += 18;
    }

    doc.setFontSize(10.5);
    doc.setFont(undefined, "normal");
    const befundLines = doc.splitTextToSize(`Befund: ${p.befund}`, pageWidth - margin * 2);
    ensureSpace(befundLines.length * 13);
    doc.text(befundLines, margin, y);
    y += befundLines.length * 13 + 6;

    const massnahmen = punktMassnahmen(p);
    massnahmen.forEach((m, mi) => {
      doc.setFontSize(10.5);
      doc.setFont(undefined, "normal");
      const mLines = doc.splitTextToSize(`Maßnahme ${mi + 1}: ${m.text}`, pageWidth - margin * 2 - 10);
      ensureSpace(mLines.length * 13 + 30);
      doc.text(mLines, margin + 10, y);
      y += mLines.length * 13 + 2;

      doc.setFontSize(9.5);
      doc.setTextColor(100, 100, 100);
      doc.text(`Verantwortlich: ${m.verantwortlicher || "-"}    Frist: ${FRIST_LABELS[m.frist] || m.frist || "-"}    Zieltermin: ${formatDateEuropean(m.zieltermin) || "-"}`, margin + 10, y);
      doc.setTextColor(0, 0, 0);
      y += 14;

      if (m.risikoNach) {
        const rNach = computeRisk(m.risikoNach.s, m.risikoNach.w);
        const color = RISK_COLOR[rNach.key] || [100, 100, 100];
        doc.setFillColor(...color);
        doc.roundedRect(margin + 10, y - 9, 160, 14, 3, 3, "F");
        doc.setFontSize(8.5);
        doc.setTextColor(255, 255, 255);
        doc.text(`Risiko nach Maßnahme: ${rNach.label.toUpperCase()}`, margin + 16, y);
        doc.setTextColor(0, 0, 0);
        y += 16;
      }
      y += 6;
    });

    if (p.fotos && p.fotos.length) {
      const thumbSize = 110;
      let x = margin;
      p.fotos.forEach(fotoDataUrl => {
        if (x + thumbSize > pageWidth - margin) {
          x = margin;
          y += thumbSize + 8;
        }
        ensureSpace(thumbSize + 8);
        try {
          doc.addImage(fotoDataUrl, "JPEG", x, y, thumbSize, thumbSize);
        } catch (e) { /* Bild konnte nicht eingebettet werden */ }
        x += thumbSize + 8;
      });
      y += thumbSize + 14;
    } else {
      y += 6;
    }

    doc.setDrawColor(230);
    ensureSpace(10);
    doc.line(margin, y, pageWidth - margin, y);
    y += 18;
  });

  // Fußzeile auf allen Seiten
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BRAND_BLUE);
    doc.setLineWidth(1);
    doc.line(margin, pageHeight - 30, pageWidth - margin, pageHeight - 30);
    doc.setFontSize(8.5);
    doc.setTextColor(130, 130, 130);
    doc.text(bezeichnung(meta), margin, pageHeight - 18);
    doc.text(`Seite ${i} von ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }

  const filenameSafe = bezeichnung(meta).replace(/[^a-z0-9]+/gi, "_");
  doc.save(`${filenameSafe}.pdf`);
}

/* =========================================================
   Settings-Modal
   ========================================================= */
function openSettingsModal() {
  const s = loadSettings();
  document.getElementById("settProvider").value = s.provider;
  document.getElementById("settModel").value = s.model;
  document.getElementById("settApiKey").value = s.apiKey;
  document.getElementById("settingsModal").hidden = false;
}

/* =========================================================
   Event-Bindings / Init
   ========================================================= */
window.addEventListener("DOMContentLoaded", () => {
  renderBegehungList();
  initSpeech();

  document.getElementById("btnNewBegehung").addEventListener("click", createNewBegehung);
  document.getElementById("btnBackToStart").addEventListener("click", () => {
    persistMeta();
    showView("view-start");
    renderBegehungList();
  });

  ["metaArt", "metaJahr", "metaNummer", "metaUnternehmenId", "metaBetrieb", "metaDatum", "metaBegeher", "metaTeilnehmer"].forEach(id => {
    document.getElementById(id).addEventListener("change", persistMeta);
  });
  document.getElementById("metaArt").addEventListener("change", () => {
    document.getElementById("metaNummer").value = "";
    refreshNummerSuggestion().then(persistMeta);
  });
  document.getElementById("metaJahr").addEventListener("change", () => {
    document.getElementById("metaNummer").value = "";
    refreshNummerSuggestion().then(persistMeta);
  });
  document.getElementById("metaUnternehmenId").addEventListener("change", async () => {
    const unternehmenId = document.getElementById("metaUnternehmenId").value;
    const teilnehmerInput = document.getElementById("metaTeilnehmer");
    if (!teilnehmerInput.value.trim()) {
      const unternehmen = await getUnternehmenById(unternehmenId);
      if (unternehmen && unternehmen.ansprechpartner) teilnehmerInput.value = unternehmen.ansprechpartner;
    }
    document.getElementById("metaNummer").value = "";
    await refreshNummerSuggestion();
    persistMeta();
  });
  document.getElementById("metaNummer").addEventListener("input", updateBezeichnungDisplay);
  document.getElementById("metaDatum").addEventListener("change", renderMassnahmenForm);

  document.getElementById("pInitS").addEventListener("change", updateInitRiskBadge);
  document.getElementById("pInitW").addEventListener("change", updateInitRiskBadge);

  document.getElementById("btnAddMassnahme").addEventListener("click", addMassnahmeRow);
  document.getElementById("massnahmenList").addEventListener("input", (e) => {
    const idx = e.target.dataset.idx;
    const field = e.target.dataset.field;
    if (idx === undefined || !field || !["text", "verantwortlicher", "wirksamkeitskontrolle"].includes(field)) return;
    currentMassnahmen[idx][field] = e.target.value;
  });
  document.getElementById("massnahmenList").addEventListener("change", (e) => {
    const idx = e.target.dataset.idx;
    const field = e.target.dataset.field;
    if (idx === undefined || !field) return;
    currentMassnahmen[idx][field] = e.target.value;
    renderMassnahmenForm();
  });
  document.getElementById("massnahmenList").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="remove-massnahme"]');
    if (!btn) return;
    currentMassnahmen.splice(Number(btn.dataset.idx), 1);
    renderMassnahmenForm();
  });

  document.getElementById("pFotos").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      try {
        const compressed = await compressImage(file);
        currentFotos.push(compressed);
      } catch (err) {
        console.error("Fehler beim Verarbeiten des Fotos", err);
      }
    }
    renderFotoPreview();
  });

  document.getElementById("btnAiEnhance").addEventListener("click", enhanceWithAi);
  document.getElementById("btnAddPunkt").addEventListener("click", addPunkt);
  document.getElementById("btnCancelEditPunkt").addEventListener("click", resetPunktForm);
  document.getElementById("btnCreatePdf").addEventListener("click", createPdf);

  document.getElementById("btnRefresh").addEventListener("click", () => location.reload());
  document.getElementById("btnSettings").addEventListener("click", openSettingsModal);
  document.getElementById("btnSettingsCancel").addEventListener("click", () => {
    document.getElementById("settingsModal").hidden = true;
  });
  document.getElementById("btnSettingsSave").addEventListener("click", () => {
    saveSettings({
      provider: document.getElementById("settProvider").value,
      model: document.getElementById("settModel").value.trim(),
      apiKey: document.getElementById("settApiKey").value.trim(),
    });
    document.getElementById("settingsModal").hidden = true;
  });

  document.getElementById("tabBtnBegehungen").addEventListener("click", () => switchTab("begehungen"));
  document.getElementById("tabBtnMassnahmen").addEventListener("click", () => switchTab("massnahmen"));
  document.getElementById("tabBtnUnternehmen").addEventListener("click", () => switchTab("unternehmen"));

  document.getElementById("massnahmenUnternehmenFilter").addEventListener("change", renderMassnahmenListe);
  document.getElementById("massnahmenListeContainer").addEventListener("change", async (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    await updateMassnahmeField(e.target.dataset.begehung, e.target.dataset.punkt, e.target.dataset.massnahme, field, e.target.value);
    renderMassnahmenListe();
  });
  document.getElementById("massnahmenListeContainer").addEventListener("input", async (e) => {
    if (e.target.dataset.field !== "wirksamkeitskontrolle") return;
    await updateMassnahmeField(e.target.dataset.begehung, e.target.dataset.punkt, e.target.dataset.massnahme, "wirksamkeitskontrolle", e.target.value);
  });
  document.getElementById("massnahmenListeContainer").addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-action="add-kommentar"]');
    if (!btn) return;
    const input = btn.parentElement.querySelector('[data-action="kommentar-input"]');
    if (!input || !input.value.trim()) return;
    await addMassnahmeKommentar(btn.dataset.begehung, btn.dataset.punkt, btn.dataset.massnahme, input.value);
    renderMassnahmenListe();
  });
  document.getElementById("massnahmenListeContainer").addEventListener("keydown", async (e) => {
    if (e.target.dataset.action !== "kommentar-input" || e.key !== "Enter") return;
    e.preventDefault();
    if (!e.target.value.trim()) return;
    await addMassnahmeKommentar(e.target.dataset.begehung, e.target.dataset.punkt, e.target.dataset.massnahme, e.target.value);
    renderMassnahmenListe();
  });

  document.getElementById("btnNewUnternehmen").addEventListener("click", () => openUnternehmenModal(null));
  document.getElementById("btnUnternehmenCancel").addEventListener("click", () => {
    document.getElementById("unternehmenModal").hidden = true;
  });
  document.getElementById("btnUnternehmenSave").addEventListener("click", saveUnternehmenFromModal);
  document.getElementById("uLogo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      unternehmenLogoDataUrl = await compressImage(file, 500, 0.85);
      unternehmenLogoAspect = await computeImageAspect(unternehmenLogoDataUrl);
      renderUnternehmenLogoPreview();
    } catch (err) {
      console.error("Fehler beim Verarbeiten des Logos", err);
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* Offline-Modus optional, kein Blocker */ });
  }
});
