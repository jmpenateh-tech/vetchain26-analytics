// =============================================================================
// Reportes — VetChain 2.10
//
// Antes (2.9) la pantalla de Reportes armaba todo en el navegador con lo que cada
// servicio devolvía y exportaba CSV desde ahí: sin filtros, sin control de ámbito en el
// servidor, con los envíos recortados a 500 sin aviso y con las cifras de analítica
// acumuladas de toda la plataforma. Ahora el reporte se calcula aquí, en el backend:
//
//   GET /reports/overview?admin_id=&user_id=&from=YYYY-MM-DD&to=YYYY-MM-DD   (JSON)
//   GET /reports/pdf?type=resumen|usuarios|lotes|envios|dispensaciones|recalls|alertas&...
//
// 1. El ámbito lo decide auth-service (GET /scope) con el token del que pide: el
//    master-admin puede pedir toda la plataforma, un administrador o un usuario; un admin
//    solo su propio ámbito (pedir otro devuelve 403 y queda en la auditoría).
// 2. Los datos se piden a cada microservicio con el mismo token y filtros, y aquí se
//    vuelven a filtrar por los nombres de las entidades del ámbito (doble barrera).
// 3. Si una fuente no responde, el reporte lo indica ("datos incompletos") en lugar de
//    mostrar ceros.
// =============================================================================
import { callService, withScheme, AUTH_URL, getScope, ScopeError, sendAudit, clientIp } from "./common.js";
import { PdfDoc } from "./pdf.js";

const SVC = {
  manufacturing: withScheme(process.env.MANUFACTURING_URL || "localhost:3002"),
  distribution: withScheme(process.env.DISTRIBUTION_URL || "localhost:3003"),
  dispensing: withScheme(process.env.DISPENSING_URL || "localhost:3005"),
  fraud: withScheme(process.env.FRAUD_URL || "localhost:3006"),
  recall: withScheme(process.env.RECALL_URL || "localhost:3007"),
  auth: AUTH_URL,
};
const SOURCE_LABEL = { lots: "lotes (fabricación)", shipments: "envíos (distribución)", dispensations: "dispensaciones", recalls: "recalls", alerts: "alertas de fraude", activity: "actividad de usuarios (auditoría)" };
const ROLE_LABEL = { "master-admin": "Administrador", admin: "Gerente", fabricante: "Fabricante", distribuidor: "Distribuidor", veterinaria: "Veterinaria / Farmacia" };
const OPERATIVE = ["fabricante", "distribuidor", "veterinaria"];
export const REPORT_TYPES = { resumen: "Reporte general", usuarios: "Usuarios", lotes: "Lotes", envios: "Envíos", dispensaciones: "Dispensaciones", recalls: "Retiros de productos (recalls)", alertas: "Alertas de fraude" };

export class ReportError extends Error { constructor(status, message) { super(message); this.status = status; } }

const norm = (v) => String(v ?? "").trim().toLowerCase();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// from/to (YYYY-MM-DD, ambos opcionales). "to" es inclusivo: se consulta hasta el día siguiente.
export function parseFilters(q) {
  const f = { from: null, to: null, toExclusive: null, adminId: null, userId: null };
  for (const k of ["from", "to"]) {
    const v = q[k];
    if (v === undefined || v === "") continue;
    if (!DATE_RE.test(String(v)) || isNaN(new Date(`${v}T00:00:00Z`))) throw new ReportError(400, `La fecha "${k === "from" ? "desde" : "hasta"}" debe tener formato AAAA-MM-DD`);
    f[k] = String(v);
  }
  if (f.from && f.to && f.from > f.to) throw new ReportError(400, "La fecha «desde» no puede ser posterior a la fecha «hasta»");
  if (f.to) { const d = new Date(`${f.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); f.toExclusive = d.toISOString().slice(0, 10); }
  if (q.admin_id !== undefined && q.admin_id !== "") {
    if (q.admin_id !== "none" && !/^\d+$/.test(String(q.admin_id))) throw new ReportError(400, "Gerente no válido");
    f.adminId = String(q.admin_id);
  }
  if (q.user_id !== undefined && q.user_id !== "") {
    if (!/^\d+$/.test(String(q.user_id))) throw new ReportError(400, "Usuario no válido");
    f.userId = String(q.user_id);
  }
  return f;
}

const inRange = (f, v) => {
  if (!f.from && !f.to) return true;
  if (!v) return false;
  const d = new Date(v).toISOString();
  return (!f.from || d >= `${f.from}T00:00:00`) && (!f.toExclusive || d < `${f.toExclusive}T00:00:00`);
};

async function fetchJson(req, base, path) {
  const r = await callService(base, path, req, { timeout: 20000 });
  if (!r.ok) throw new ReportError(r.status === 403 ? 403 : 502, r.data?.error || `HTTP ${r.status}`);
  return r.data;
}

export async function buildReport(req, filters) {
  // 1) Ámbito (lo calcula auth-service; un admin que pide otro ámbito recibe 403).
  let scope;
  try { scope = await getScope(req, { adminId: filters.adminId, userId: filters.userId }); }
  catch (e) { if (e instanceof ScopeError) throw new ReportError(e.status, e.message); throw e; }
  const users = scope.users || [];
  const has = (name) => scope.all || scope.names.has(norm(name));
  const q = new URLSearchParams();
  if (filters.adminId) q.set("admin_id", filters.adminId);
  if (filters.userId) q.set("user_id", filters.userId);
  if (filters.from) q.set("from", filters.from);
  if (filters.toExclusive) q.set("to", filters.toExclusive);
  const qs = q.toString();

  // 2) Fuentes en paralelo (con el token del que pide).
  const sources = {
    lots: () => fetchJson(req, SVC.manufacturing, "/batches"),
    shipments: () => fetchJson(req, SVC.distribution, `/shipments?limit=20000&${qs}`),
    dispensations: () => fetchJson(req, SVC.dispensing, `/dispensations?${qs}`),
    recalls: () => fetchJson(req, SVC.recall, "/recalls"),
    alerts: () => fetchJson(req, SVC.fraud, `/fraud-alerts?${new URLSearchParams([...q].filter(([k]) => k === "admin_id" || k === "user_id"))}`),
    activity: () => fetchJson(req, SVC.auth, "/audit?limit=2000"),
  };
  const keys = Object.keys(sources);
  const settled = await Promise.allSettled(keys.map((k) => sources[k]()));
  const raw = {}, partial = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") raw[keys[i]] = s.value || [];
    else {
      if (s.reason instanceof ReportError && s.reason.status === 403) throw s.reason; // nunca se "rellena" un acceso denegado
      raw[keys[i]] = null; partial.push(SOURCE_LABEL[keys[i]]);
      console.error(`[reports] fuente ${keys[i]} no disponible:`, s.reason?.message);
    }
  });

  // 3) Filtro de ámbito y fechas (segunda barrera, aquí mismo).
  const allLots = raw.lots || [];
  const lots = allLots.filter((b) => has(b.manufacturer) && inRange(filters, b.created_at));
  const scopeLotIds = new Set(allLots.filter((b) => has(b.manufacturer)).map((b) => b.id));
  const lotById = new Map(allLots.map((b) => [b.id, b]));
  const shipments = (raw.shipments || []).filter((s) => (has(s.from_entity) || has(s.to_entity) || scopeLotIds.has(s.batch_id)) && inRange(filters, s.shipped_at));
  const touchedLots = new Set([...scopeLotIds, ...(raw.shipments || []).filter((s) => has(s.from_entity) || has(s.to_entity)).map((s) => s.batch_id)]);
  const dispensations = (raw.dispensations || []).filter((d) => has(d.dispensing_entity) && inRange(filters, d.timestamp));
  const recalls = (raw.recalls || []).filter((r) => touchedLots.has(r.batch_id) && inRange(filters, r.created_at));
  const alertEntities = (a) => [a.details?.dispensing_entity, a.details?.from_entity, a.details?.to_entity].filter(Boolean);
  const alerts = (raw.alerts || []).filter((a) => (scope.all || alertEntities(a).some(has)) && inRange(filters, a.created_at));
  const scopeIds = new Set(users.map((u) => u.id));
  const logins = new Map();
  for (const e of raw.activity?.events || []) {
    if (e.action === "login.success" && scopeIds.has(e.actor_id) && inRange(filters, e.at)) logins.set(e.actor_id, (logins.get(e.actor_id) || 0) + 1);
  }

  const operative = users.filter((u) => OPERATIVE.includes(u.role));
  const units = lots.reduce((a, b) => a + Number(b.quantity || 0), 0);
  const unitsShipped = shipments.reduce((a, s) => a + Number(s.units || 0), 0);
  const kpis = {
    users: operative.length,
    activeUsers: operative.filter((u) => u.active).length,
    admins: users.filter((u) => u.role === "admin").length,
    lots: lots.length, units,
    shipments: shipments.length, unitsShipped,
    inTransit: shipments.filter((s) => s.status === "en_transito").length,
    delivered: shipments.filter((s) => s.status === "entregado").length,
    dispensations: dispensations.length,
    recalls: recalls.length,
    alerts: alerts.length,
    alertsOpen: alerts.filter((a) => a.status === "abierta").length,
    logins: [...logins.values()].reduce((a, b) => a + b, 0),
  };

  // Desglose por administrador (solo master-admin viendo toda la plataforma).
  let byAdmin = null;
  if (scope.all) {
    const admins = users.filter((u) => u.role === "admin");
    const groups = [...admins.map((a) => ({ id: a.id, name: a.name, active: a.active })), { id: null, name: "Administración (sin gerente)", active: true }];
    byAdmin = groups.map((g) => {
      const members = operative.filter((u) => (u.adminId ?? null) === g.id);
      const names = new Set(members.map((u) => norm(u.name)));
      const mine = (n) => names.has(norm(n));
      return {
        adminId: g.id, name: g.name, active: g.active,
        users: members.length,
        lots: lots.filter((b) => mine(b.manufacturer)).length,
        shipments: shipments.filter((s) => mine(s.from_entity) || mine(s.to_entity)).length,
        dispensations: dispensations.filter((d) => mine(d.dispensing_entity)).length,
        alertsOpen: alerts.filter((a) => a.status === "abierta" && alertEntities(a).some(mine)).length,
      };
    }).filter((g) => g.adminId !== null || g.users > 0);
  }

  const scopeUserObj = filters.userId ? users.find((u) => String(u.id) === filters.userId) : null;
  const scopeAdminObj = filters.adminId && filters.adminId !== "none" ? users.find((u) => String(u.id) === filters.adminId) : null;
  const label = scopeUserObj ? `Usuario: ${scopeUserObj.name}`
    : filters.adminId === "none" ? "Usuarios sin gerente (los atiende el administrador)"
    : scopeAdminObj ? `Gerente: ${scopeAdminObj.name}`
    : scope.all ? "Toda la plataforma"
    : `Usuarios de ${req.auth.name}`;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: { name: req.auth.name, role: req.auth.role },
    scope: { label, global: !!scope.all, adminId: scope.adminId ?? null, userId: scopeUserObj?.id ?? null },
    filters: { from: filters.from, to: filters.to, adminId: filters.adminId, userId: filters.userId },
    partial, kpis, byAdmin,
    users: users.map((u) => ({ ...u, roleLabel: ROLE_LABEL[u.role] || u.role, logins: logins.get(u.id) || 0 })),
    lots: lots.map((b) => ({ id: b.id, product_id: b.product_id, product_name: b.product_name, manufacturer: b.manufacturer, quantity: b.quantity, manufacture_date: b.manufacture_date, expiry_date: b.expiry_date, status: b.status, created_at: b.created_at })),
    shipments: shipments.map((s) => ({ ...s, product_id: lotById.get(s.batch_id)?.product_id || null, product_name: lotById.get(s.batch_id)?.product_name || null })),
    dispensations,
    recalls: recalls.map((r) => ({ ...r, product_id: lotById.get(r.batch_id)?.product_id || null, product_name: lotById.get(r.batch_id)?.product_name || null })),
    alerts,
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const fmtD = (v) => { if (!v) return "—"; const d = new Date(String(v).length === 10 ? `${v}T12:00:00` : v); return isNaN(d) ? String(v) : d.toLocaleDateString("es-CO", { timeZone: process.env.REPORT_TZ || "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric" }); };
const fmtDT = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleString("es-CO", { timeZone: process.env.REPORT_TZ || "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const num = (n) => Number(n || 0).toLocaleString("es-CO");
const SHIP_STATUS = { en_transito: "En tránsito", entregado: "Entregado" };
const LOT_STATUS = { activo: "Activo", recall: "Retirado (recall)" };
const SEV = { critica: "Crítica", alta: "Alta", media: "Media", baja: "Baja" };
const PATTERN = { 1: "Movimiento de custodia inusual", 2: "Doble dispensación", 3: "Unidad no registrada (posible falsificación)" };
const alertDetail = (a) => a.details?.dispensing_entity ? `Intento por ${a.details.dispensing_entity}` : a.details?.from_entity ? `${a.details.from_entity} -> ${a.details.to_entity}` : "—";

const SECTIONS = {
  usuarios: (doc, r) => {
    doc.heading(`Usuarios (${r.users.length})`);
    doc.table({ rows: r.users, columns: [
      { label: "Nombre", key: "name", width: 2.2 }, { label: "Correo", key: "email", width: 2.4 }, { label: "Rol", key: "roleLabel", width: 1.4 },
      { label: "Gerente responsable", value: (u) => OPERATIVE.includes(u.role) ? (u.adminName || "Administración") : "—", width: 2 },
      { label: "Estado", value: (u) => u.active ? "Activa" : "Desactivada", width: 1 }, { label: "Inicios de sesión", key: "logins", width: 1, align: "right" },
    ], emptyText: "No hay usuarios en este ámbito." });
  },
  lotes: (doc, r) => {
    doc.heading(`Lotes registrados (${r.lots.length})`);
    doc.table({ rows: r.lots, columns: [
      { label: "Lote", key: "product_id", width: 1.4 }, { label: "Producto", key: "product_name", width: 2 }, { label: "Fabricante", key: "manufacturer", width: 1.8 },
      { label: "Unidades", value: (b) => num(b.quantity), width: 0.9, align: "right" }, { label: "Fabricación", value: (b) => fmtD(b.manufacture_date), width: 1.1 },
      { label: "Vencimiento", value: (b) => fmtD(b.expiry_date), width: 1.1 }, { label: "Estado", value: (b) => LOT_STATUS[b.status] || b.status, width: 1.3 },
    ], emptyText: "No se registraron lotes en este ámbito y periodo." });
  },
  envios: (doc, r) => {
    doc.heading(`Envíos (${r.shipments.length})`);
    doc.table({ rows: r.shipments, columns: [
      { label: "Lote", value: (s) => s.product_id || String(s.batch_id).slice(0, 8), width: 1.3 }, { label: "Origen", key: "from_entity", width: 1.8 }, { label: "Destino", key: "to_entity", width: 1.8 },
      { label: "Unidades", value: (s) => num(s.units), width: 0.9, align: "right" }, { label: "Enviado", value: (s) => fmtDT(s.shipped_at), width: 1.5 },
      { label: "Estado", value: (s) => SHIP_STATUS[s.status] || s.status, width: 1.1 }, { label: "Entregado", value: (s) => fmtDT(s.delivered_at), width: 1.5 },
    ], emptyText: "No hay envíos en este ámbito y periodo." });
  },
  dispensaciones: (doc, r) => {
    doc.heading(`Dispensaciones (${r.dispensations.length})`);
    doc.table({ rows: r.dispensations, columns: [
      { label: "Número de serie", key: "serial_number", width: 2.4 }, { label: "Entidad que dispensó", key: "dispensing_entity", width: 2.2 },
      { label: "Fecha", value: (d) => fmtDT(d.timestamp), width: 1.6 }, { label: "Verificada", value: (d) => d.validated ? "Sí" : "No", width: 0.9 },
    ], emptyText: "No hay dispensaciones en este ámbito y periodo." });
  },
  recalls: (doc, r) => {
    doc.heading(`Retiros de productos · recalls (${r.recalls.length})`);
    doc.table({ rows: r.recalls, columns: [
      { label: "Lote", value: (x) => x.product_id || String(x.batch_id).slice(0, 8), width: 1.3 }, { label: "Producto", key: "product_name", width: 1.7 },
      { label: "Motivo", key: "reason", width: 3.2 }, { label: "Fecha", value: (x) => fmtD(x.created_at), width: 1.1 },
      { label: "Estado", value: (x) => x.status === "cerrado" ? "Cerrado" : "En curso", width: 1 }, { label: "Unid. recuperadas", value: (x) => num(x.units_recovered), width: 1.1, align: "right" },
    ], emptyText: "No hay recalls que afecten a este ámbito en el periodo." });
  },
  alertas: (doc, r) => {
    doc.heading(`Alertas de fraude (${r.alerts.length})`);
    doc.table({ rows: r.alerts, columns: [
      { label: "Severidad", value: (a) => SEV[a.severity] || a.severity, width: 0.9 }, { label: "Tipo", value: (a) => PATTERN[a.pattern_id] || "Alerta de fraude", width: 2 },
      { label: "Unidad", key: "serial_number", width: 2.1 }, { label: "Detalle", value: alertDetail, width: 2 },
      { label: "Fecha", value: (a) => fmtDT(a.created_at), width: 1.4 }, { label: "Estado", value: (a) => a.status === "abierta" ? "Abierta" : "Revisada", width: 0.9 },
    ], emptyText: "No hay alertas de fraude en este ámbito y periodo." });
  },
};

export function reportPdf(report, type = "resumen") {
  if (!REPORT_TYPES[type]) throw new ReportError(400, `Tipo de reporte no válido. Tipos: ${Object.keys(REPORT_TYPES).join(", ")}`);
  const f = report.filters;
  const period = f.from || f.to ? `Periodo: ${f.from ? fmtD(f.from) : "inicio"} a ${f.to ? fmtD(f.to) : "hoy"}` : "Periodo: todo el historial";
  const doc = new PdfDoc({
    title: `${REPORT_TYPES[type]} · VetChain`,
    subtitle: `Ámbito: ${report.scope.label}`,
    meta: [period, `Generado por ${report.generatedBy.name} (${ROLE_LABEL[report.generatedBy.role] || report.generatedBy.role}) el ${fmtDT(report.generatedAt)}`],
    landscape: type !== "dispensaciones",
    author: report.generatedBy.name,
  });
  if (report.partial.length) doc.notice(`Datos incompletos: no respondieron ${report.partial.join(", ")}. Las cifras de esas secciones pueden faltar; vuelve a generar el reporte en unos minutos.`);
  const k = report.kpis;
  if (type === "resumen") {
    doc.heading("Indicadores");
    doc.kpis([
      ["Usuarios operativos", `${num(k.activeUsers)} activos de ${num(k.users)}`], ["Lotes registrados", num(k.lots)], ["Unidades fabricadas", num(k.units)], ["Envíos", `${num(k.shipments)} (${num(k.unitsShipped)} unid.)`],
      ["En tránsito / entregados", `${num(k.inTransit)} / ${num(k.delivered)}`], ["Dispensaciones", num(k.dispensations)], ["Recalls", num(k.recalls)], ["Alertas abiertas / total", `${num(k.alertsOpen)} / ${num(k.alerts)}`],
    ]);
    if (report.byAdmin) {
      doc.heading("Resumen por gerente");
      doc.table({ rows: report.byAdmin, columns: [
        { label: "Gerente", value: (g) => `${g.name}${g.active ? "" : " (desactivado)"}`, width: 3 }, { label: "Usuarios", value: (g) => num(g.users), width: 1, align: "right" },
        { label: "Lotes", value: (g) => num(g.lots), width: 1, align: "right" }, { label: "Envíos", value: (g) => num(g.shipments), width: 1, align: "right" },
        { label: "Dispensaciones", value: (g) => num(g.dispensations), width: 1.2, align: "right" }, { label: "Alertas abiertas", value: (g) => num(g.alertsOpen), width: 1.2, align: "right" },
      ], emptyText: "No hay gerentes registrados." });
    }
    for (const s of ["usuarios", "lotes", "envios", "dispensaciones", "recalls", "alertas"]) SECTIONS[s](doc, report);
  } else SECTIONS[type](doc, report);
  return doc.toBuffer();
}

const slug = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export function reportFilename(report, type) {
  const scope = report.scope.global ? "plataforma" : slug(report.scope.label.replace(/^[^:]+:\s*/, ""));
  const period = report.filters.from || report.filters.to ? `_${report.filters.from || "inicio"}_a_${report.filters.to || "hoy"}` : "";
  return `vetchain_${slug(REPORT_TYPES[type])}_${scope}${period}_${new Date().toISOString().slice(0, 10)}.pdf`;
}

export function installReportRoutes(app, requireRole) {
  const guard = requireRole("admin", "master-admin");
  const fail = (res, e) => {
    if (e instanceof ReportError) return res.status(e.status).json({ error: e.message });
    console.error("[reports]", e);
    return res.status(500).json({ error: "No se pudo generar el reporte" });
  };
  app.get("/reports/overview", guard, async (req, res) => {
    try { res.json(await buildReport(req, parseFilters(req.query))); } catch (e) { fail(res, e); }
  });
  app.get("/reports/pdf", guard, async (req, res) => {
    try {
      const type = String(req.query.type || "resumen");
      if (!REPORT_TYPES[type]) throw new ReportError(400, `Tipo de reporte no válido. Tipos: ${Object.keys(REPORT_TYPES).join(", ")}`);
      const report = await buildReport(req, parseFilters(req.query));
      const pdf = reportPdf(report, type);
      const name = reportFilename(report, type);
      sendAudit({ service: "analytics", ip: clientIp(req), method: "GET", path: "/reports/pdf", actor_id: req.auth.id, actor_name: req.auth.name, actor_role: req.auth.role,
        action: "report.downloaded", outcome: "ok", severity: "info", target: report.scope.label, message: `Descargó el reporte PDF «${REPORT_TYPES[type]}» (${report.scope.label})` });
      res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": String(pdf.length), "X-Report-Partial": report.partial.length ? "1" : "0" });
      res.end(pdf);
    } catch (e) { fail(res, e); }
  });
}
