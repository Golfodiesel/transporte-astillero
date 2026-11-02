# Transporte de Personal · Astillero — prototipo PWA

App web para celular (chofer) + dashboard (supervisor). Sin instalación de tienda: se abre con un enlace y se agrega a la pantalla de inicio. Funciona sin señal; los datos se guardan en el teléfono y se envían a Supabase cuando hay conexión (si está configurado).

## Archivos
- `index.html`, `styles.css`, `app.js` — la app (chofer y supervisor en el mismo sitio)
- `catalogo.js` — choferes, unidades, rutas y paradas (**editar con datos reales**)
- `config.js` — URL/llave de Supabase, PIN del supervisor, horas meta, tolerancia
- `db.js` — almacenamiento local (IndexedDB)
- `sync.js` — envío/lectura de datos en Supabase (opcional)
- `sw.js`, `manifest.json`, `icon.svg` — modo PWA (abre sin señal, ícono en pantalla)
- `schema.sql` — tablas para Supabase

## Publicar (requiere HTTPS para que funcione el GPS)
Opción A — GitHub Pages (gratis):
1. Crear repositorio y subir estos archivos a la rama `main`.
2. Settings → Pages → Source: `main` / root. Queda en `https://<usuario>.github.io/<repo>/`.

Opción B — Vercel o Netlify (gratis): arrastrar la carpeta o conectar el repositorio. Sin pasos de build.

## Conectar Supabase (fase 2, para ver todos los choferes en un solo dashboard)
1. Crear proyecto en supabase.com (plan gratuito).
2. SQL Editor → pegar y ejecutar `schema.sql`.
3. Storage → New bucket → nombre `evidencias`, público (para fotos de odómetro y tickets).
4. Settings → API → copiar `Project URL` y `anon public key` a `config.js`.
5. Volver a publicar. La app envía los registros pendientes automáticamente al recuperar señal.

## Uso en el celular del chofer
1. Abrir el enlace en Chrome (Android) → menú → "Agregar a pantalla de inicio".
2. Permitir ubicación cuando lo pida.
3. Flujo: **Iniciar viaje** → **+ pasajeros por parada → Confirmar parada** → **Llegué al astillero** → odómetro final.
4. **Combustible**: litros, importe, odómetro, foto del ticket.
5. **Historial**: ver registros y, en modo local, **Compartir datos (JSON)** por WhatsApp al supervisor.

## Supervisor
Pestaña **Supervisor** → PIN (`config.js`). Indicadores: puntualidad, ocupación, km, km/L, costo por pasajero; tablas y exportación a CSV (abre en Excel). En modo local puede importar los JSON que comparten los choferes.

## Indicadores — definiciones
- **Puntualidad**: turno entrada = llegada al astillero vs `HORA_META_ENTRADA`; turno salida = hora de salida vs `HORA_META_SALIDA`; a tiempo si retraso ≤ `TOLERANCIA_MIN`.
- **Ocupación**: pasajeros / capacidad, acumulado del periodo.
- **Km**: odómetro final − inicial; si no se capturó, km por GPS.
- **Rendimiento**: km del periodo / litros cargados en el periodo (se afina con más datos).
- **Costo por pasajero**: importe de combustible del periodo / pasajeros del periodo.
