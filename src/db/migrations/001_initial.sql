-- product_costs: stores per-product cost data synced from EAN or direct upload
create table if not exists product_costs (
  mla_id       text primary key,
  ean          text,
  codigo       text,
  nombre       text,
  titulo_ml    text,
  costo        numeric(12, 2) not null default 0,
  precio_lista numeric(12, 2) not null default 0,
  match_method text,
  updated_at   timestamptz not null default now()
);

-- app_config: generic key/value store for app settings
create table if not exists app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- auto-update updated_at on both tables
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger product_costs_updated_at
  before update on product_costs
  for each row execute procedure set_updated_at();

create trigger app_config_updated_at
  before update on app_config
  for each row execute procedure set_updated_at();
