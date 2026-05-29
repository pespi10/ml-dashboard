-- Correr en Supabase SQL Editor antes de usar el sistema de sync
-- ─────────────────────────────────────────────────────────────

-- Órdenes sincronizadas desde MercadoLibre
CREATE TABLE IF NOT EXISTS orders (
  id            BIGINT PRIMARY KEY,
  date_created  TIMESTAMPTZ NOT NULL,
  status        TEXT,
  total_amount  NUMERIC     DEFAULT 0,
  sale_fee      NUMERIC     DEFAULT 0,
  item_id       TEXT,
  item_title    TEXT,
  category_id   TEXT,
  seller_sku    TEXT,
  quantity      INT         DEFAULT 1,
  unit_price    NUMERIC     DEFAULT 0,
  pack_id       BIGINT,
  shipment_id   BIGINT
);

CREATE INDEX IF NOT EXISTS orders_date_idx   ON orders (date_created);
CREATE INDEX IF NOT EXISTS orders_item_idx   ON orders (item_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

-- Costos de envío y clasificación logística
CREATE TABLE IF NOT EXISTS shipments (
  id          BIGINT  PRIMARY KEY,
  order_id    BIGINT  REFERENCES orders(id) ON DELETE CASCADE,
  seller_cost NUMERIC DEFAULT 0,
  is_flex     BOOLEAN DEFAULT false
);

-- Percepciones IIBB del billing de ML
CREATE TABLE IF NOT EXISTS billing_perceptions (
  period         TEXT    NOT NULL,
  society        TEXT    NOT NULL DEFAULT '',
  tax_type       TEXT    NOT NULL DEFAULT '',
  amount         NUMERIC DEFAULT 0,
  taxable_amount NUMERIC DEFAULT 0,
  aliquot        NUMERIC DEFAULT 0,
  description    TEXT,
  PRIMARY KEY (period, society, tax_type)
);

-- Log de sincronizaciones
CREATE TABLE IF NOT EXISTS sync_log (
  id               SERIAL PRIMARY KEY,
  synced_at        TIMESTAMPTZ DEFAULT NOW(),
  date_from        TEXT,
  date_to          TEXT,
  orders_count     INT     DEFAULT 0,
  shipments_count  INT     DEFAULT 0,
  perceptions_count INT    DEFAULT 0,
  duration_ms      INT     DEFAULT 0,
  status           TEXT    DEFAULT 'ok',
  error            TEXT
);
