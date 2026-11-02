-- Supabase · esquema del prototipo (ejecutar en SQL Editor)
create table if not exists viajes (
  id text primary key,
  chofer_id text, chofer text, unidad_id text, capacidad int,
  ruta_id text, ruta text, turno text check (turno in ('entrada','salida')),
  salida_ts bigint, salida_lat double precision, salida_lng double precision, odo_ini numeric,
  llegada_ts bigint, llegada_lat double precision, llegada_lng double precision, odo_fin numeric,
  paradas jsonb, pax_total int, km_gps numeric, km_odo numeric,
  incidencias jsonb, estado text, foto_odo_ini_url text, foto_odo_fin_url text, dispositivo text,
  creado_en timestamptz default now()
);
create table if not exists cargas (
  id text primary key,
  chofer_id text, chofer text, unidad_id text, ts bigint,
  litros numeric, importe numeric, estacion text, odo numeric,
  foto_ticket_url text, lat double precision, lng double precision,
  creado_en timestamptz default now()
);
create index if not exists viajes_salida_idx on viajes (salida_ts desc);
create index if not exists cargas_ts_idx on cargas (ts desc);

-- Piloto: acceso con la llave anon (sin login de choferes). Endurecer en fase 2 con auth por chofer.
alter table viajes enable row level security;
alter table cargas enable row level security;
create policy "piloto_viajes" on viajes for all to anon using (true) with check (true);
create policy "piloto_cargas" on cargas for all to anon using (true) with check (true);

-- Storage: crear bucket público "evidencias" desde el panel (Storage > New bucket > Public).

-- Vista para dashboard/Looker/Excel
create or replace view v_viajes as
select id, chofer, unidad_id, ruta_id, turno,
  to_timestamp(salida_ts/1000.0) at time zone 'America/Mexico_City' as salida,
  to_timestamp(llegada_ts/1000.0) at time zone 'America/Mexico_City' as llegada,
  pax_total, capacidad, coalesce(nullif(km_odo,0), km_gps) as km, km_gps, odo_ini, odo_fin, estado
from viajes;
