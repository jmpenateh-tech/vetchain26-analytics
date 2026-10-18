# analytics-service — VetChain

Servicio de analítica. Agrega eventos de toda la plataforma y expone **KPIs** y **reportes**
(JSON y PDF) para la administración.

## Responsabilidad en la arquitectura

Es la **capa de lectura agregada** del sistema. No almacena datos operativos: resume lo que ocurre en
los demás servicios en tablas de métricas y genera reportes con ámbito por administrador.

- Consume eventos de RabbitMQ y acumula contadores por tipo de evento y por periodo.
- Calcula los reportes **en el servidor** (`reports.js`) consultando a los servicios por REST.
- Genera **PDF** sin dependencias nativas (`pdf.js`, usando `zlib` de Node).

## Tecnologías

| Componente | Versión |
|---|---|
| Node.js | ≥ 18 |
| Express | ^5.2.1 |
| pg | ^8.16.3 |
| amqplib (RabbitMQ) | ^0.10.9 |
| dotenv | ^18.0.1 |

## Instalación y ejecución

**Método oficial (recomendado): Docker Compose**, desde la raíz del proyecto:

```bash
docker compose up -d --build --wait
```

**Ejecución directa** (requiere PostgreSQL, RabbitMQ y los servicios de datos accesibles):

```bash
npm install
node index.js        # o: npm start
```

El servicio escucha en `PORT` (3009 por defecto).

## Endpoints principales

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/` , `/health` | Público | Identificación y estado. |
| GET | `/transit-time` , `/analytics/transit-time` | master-admin | Tiempo de tránsito por etapa. |
| GET | `/recall-coverage` , `/analytics/recall-coverage` | master-admin | Cobertura de recalls. |
| GET | `/fraud-incidents` , `/analytics/fraud-incidents` | master-admin | Incidentes de fraude por periodo. |
| GET | `/reports/overview` | admin / master-admin | Reporte JSON con filtros y ámbito. |
| GET | `/reports/pdf` | admin / master-admin | Reporte en PDF (`?type=…`). |

Tipos de PDF: `resumen`, `usuarios`, `lotes`, `envios`, `dispensaciones`, `recalls`, `alertas`.

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` | `3009` | Puerto de escucha. |
| `DATABASE_URL` | — | Conexión a PostgreSQL. |
| `DB_NAME` | — | Base de datos a usar dentro de la misma instancia. |
| `DB_POOL_MAX` | `10` | Tamaño máximo del pool. |
| `RABBITMQ_URL` | `amqp://localhost:5672` | Conexión AMQP. |
| `JWT_SECRET` | — | Verificación del token. |
| `AUTH_SERVICE_URL` | `http://localhost:3001` | Validación de sesión/ámbito. |
| `MANUFACTURING_URL` | `http://localhost:3002` | Datos de lotes/productos. |
| `DISTRIBUTION_URL` | `http://localhost:3003` | Datos de envíos. |
| `DISPENSING_URL` | `http://localhost:3005` | Datos de dispensaciones. |
| `FRAUD_URL` | `http://localhost:3006` | Datos de alertas. |
| `RECALL_URL` | `http://localhost:3007` | Datos de recalls. |

## Base de datos

- `transit_time_by_stage` (`id`, `event_type`, `count`, `updated_at`) + índice único `uq_transit_event`
  (`event_type`).
- `recall_coverage` (`id`, `batch_id`, `status`, `created_at`).
- `fraud_incidents_by_period` (`id`, `event_type`, `count`, `period_date`) + `UNIQUE(event_type, period_date)`.

Al arrancar ejecuta una **migración no destructiva** que consolida filas duplicadas de
`transit_time_by_stage` en una sola por `event_type`.

## Reglas de negocio

- Los **reportes** se calculan en el servidor y respetan el **ámbito** del administrador
  (`getScope`). `reports/overview` y `reports/pdf` están disponibles para `admin` y `master-admin`.
- `transit-time`, `recall-coverage` y `fraud-incidents` son **solo para `master-admin`**.
- Los KPIs se acumulan a partir de los eventos, no de los datos operativos.

## Eventos

- **Consume** (`vetchain.events`): eventos de lote, custodia, dispensación y recall para agregar métricas.
- **Publica**: ninguno.
