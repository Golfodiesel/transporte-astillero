// Sincronización opcional con Supabase. Sin URL configurada, no hace nada (modo local).
window.SYNC = (function () {
  var cfg = window.APP_CONFIG || {};
  var client = null, loading = null;

  function enabled() { return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY); }

  function loadClient() {
    if (!enabled()) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.onload = function () {
        client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
        resolve(client);
      };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(","), mime = parts[0].match(/:(.*?);/)[1], bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function subirFoto(sb, fotoId) {
    return DB.get("fotos", fotoId).then(function (f) {
      if (!f || f.url) return f ? f.url : null;
      var path = fotoId + ".jpg";
      return sb.storage.from(cfg.STORAGE_BUCKET).upload(path, dataUrlToBlob(f.dataUrl), { upsert: true, contentType: "image/jpeg" })
        .then(function (r) {
          if (r.error) throw r.error;
          var pub = sb.storage.from(cfg.STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
          f.url = pub; return DB.put("fotos", f).then(function () { return pub; });
        });
    });
  }

  function mapViaje(v) {
    return {
      id: v.id, chofer_id: v.chofer_id, chofer: v.chofer, unidad_id: v.unidad_id, capacidad: v.capacidad,
      ruta_id: v.ruta_id, ruta: v.ruta, turno: v.turno,
      salida_ts: v.salida_ts, salida_lat: v.salida_lat, salida_lng: v.salida_lng, odo_ini: v.odo_ini,
      llegada_ts: v.llegada_ts, llegada_lat: v.llegada_lat, llegada_lng: v.llegada_lng, odo_fin: v.odo_fin,
      paradas: v.paradas, pax_total: v.pax_total, km_gps: v.km_gps, km_odo: v.km_odo,
      incidencias: v.incidencias, estado: v.estado, foto_odo_ini_url: v.foto_odo_ini_url || null,
      foto_odo_fin_url: v.foto_odo_fin_url || null, dispositivo: v.dispositivo
    };
  }

  function mapCarga(c) {
    return {
      id: c.id, chofer_id: c.chofer_id, chofer: c.chofer, unidad_id: c.unidad_id, ts: c.ts,
      litros: c.litros, importe: c.importe, estacion: c.estacion, odo: c.odo,
      foto_ticket_url: c.foto_ticket_url || null, lat: c.lat, lng: c.lng
    };
  }

  // Envía todo lo pendiente. Devuelve {ok, enviados, error}
  function push() {
    if (!enabled()) return Promise.resolve({ ok: false, enviados: 0, error: "sin_config" });
    return loadClient().then(function (sb) {
      if (!sb) return { ok: false, enviados: 0, error: "sin_cliente" };
      var enviados = 0;
      return DB.all("viajes").then(function (viajes) {
        var pend = viajes.filter(function (v) { return v.estado === "cerrado" && !v.synced; });
        return pend.reduce(function (p, v) {
          return p.then(function () {
            var fotos = [];
            if (v.foto_odo_ini) fotos.push(subirFoto(sb, v.foto_odo_ini).then(function (u) { v.foto_odo_ini_url = u; }));
            if (v.foto_odo_fin) fotos.push(subirFoto(sb, v.foto_odo_fin).then(function (u) { v.foto_odo_fin_url = u; }));
            return Promise.all(fotos).then(function () {
              return sb.from("viajes").upsert(mapViaje(v));
            }).then(function (r) {
              if (r.error) throw r.error;
              v.synced = true; enviados++; return DB.put("viajes", v);
            });
          });
        }, Promise.resolve());
      }).then(function () { return DB.all("cargas"); }).then(function (cargas) {
        var pend = cargas.filter(function (c) { return !c.synced; });
        return pend.reduce(function (p, c) {
          return p.then(function () {
            var f = c.foto_ticket ? subirFoto(sb, c.foto_ticket).then(function (u) { c.foto_ticket_url = u; }) : Promise.resolve();
            return f.then(function () { return sb.from("cargas").upsert(mapCarga(c)); }).then(function (r) {
              if (r.error) throw r.error;
              c.synced = true; enviados++; return DB.put("cargas", c);
            });
          });
        }, Promise.resolve());
      }).then(function () { return { ok: true, enviados: enviados }; })
        .catch(function (e) { return { ok: false, enviados: enviados, error: String(e.message || e) }; });
    });
  }

  // Trae viajes y cargas de todos los choferes (para el dashboard).
  function pull() {
    if (!enabled()) return Promise.resolve(null);
    return loadClient().then(function (sb) {
      if (!sb) return null;
      return Promise.all([
        sb.from("viajes").select("*").order("salida_ts", { ascending: false }).limit(2000),
        sb.from("cargas").select("*").order("ts", { ascending: false }).limit(2000)
      ]).then(function (rs) {
        if (rs[0].error || rs[1].error) return null;
        return { viajes: rs[0].data, cargas: rs[1].data };
      });
    });
  }

  return { enabled: enabled, push: push, pull: pull };
})();
