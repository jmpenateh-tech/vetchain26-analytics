import "dotenv/config";
import express from "express";
import { pool, initDb, consume, bodyDefault, installErrorHandlers } from "./common.js";

const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.json());
app.use(bodyDefault);

await initDb(`
CREATE TABLE IF NOT EXISTS transit_time_by_stage(
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS recall_coverage(
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS fraud_incidents_by_period(
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  period_date DATE NOT NULL,
  UNIQUE(event_type,period_date));

-- Migración: versiones anteriores guardaban una fila por evento. Se consolidan
-- en una sola por tipo de evento y se impide que vuelvan a duplicarse.
UPDATE transit_time_by_stage t SET count = s.total
  FROM (SELECT event_type, min(id) AS keep_id, sum(count) AS total
        FROM transit_time_by_stage GROUP BY event_type HAVING count(*) > 1) s
  WHERE t.id = s.keep_id;
DELETE FROM transit_time_by_stage t USING
  (SELECT event_type, min(id) AS keep_id
   FROM transit_time_by_stage GROUP BY event_type HAVING count(*) > 1) s
  WHERE t.event_type = s.event_type AND t.id <> s.keep_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transit_event ON transit_time_by_stage(event_type);`);

app.get("/", (_, res) => res.json({ service: "analytics-service", status: "ok" }));
app.get("/health", async (_, res) => {
  try { await pool.query("select 1"); res.json({ status: "ok" }); }
  catch { res.status(503).json({ status: "down" }); }
});

// El gateway quita el prefijo /analytics, así que el servicio expone /transit-time, etc.
// Las rutas antiguas (/analytics/transit-time, etc.) se mantienen por compatibilidad.
app.get(["/transit-time", "/analytics/transit-time"], async (_, res) =>
  res.json((await pool.query("select * from transit_time_by_stage order by updated_at desc")).rows));
app.get(["/recall-coverage", "/analytics/recall-coverage"], async (_, res) =>
  res.json((await pool.query("select * from recall_coverage order by created_at desc")).rows));
app.get(["/fraud-incidents", "/analytics/fraud-incidents"], async (_, res) =>
  res.json((await pool.query("select * from fraud_incidents_by_period order by period_date desc")).rows));

consume("analytics-service", async (msg) => {
  const today = new Date().toISOString().slice(0, 10);
  if (msg.event === "recall.initiated") {
    await pool.query("insert into recall_coverage(batch_id,status) values($1,'iniciado')", [msg.payload.batch_id]);
  }
  if (["unit.dispensed", "custody.transferred"].includes(msg.event)) {
    await pool.query(
      `insert into transit_time_by_stage(event_type,count) values($1,1)
       on conflict(event_type) do update set count=transit_time_by_stage.count+1, updated_at=now()`,
      [msg.event]);
  }
  if (msg.event === "fraud.alert") {
    await pool.query(
      `insert into fraud_incidents_by_period(event_type,count,period_date) values($1,1,$2)
       on conflict(event_type,period_date) do update set count=fraud_incidents_by_period.count+1`,
      [msg.event, today]);
  }
});

installErrorHandlers(app);
app.listen(PORT, () => console.log(`Analytics Service http://localhost:${PORT}`));
