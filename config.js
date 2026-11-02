// Configuración del prototipo.
// Deja SUPABASE_URL vacío para trabajar solo en el celular (modo local).
// Cuando exista el proyecto Supabase, llena URL y ANON_KEY y la app sincroniza sola.
window.APP_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  STORAGE_BUCKET: "evidencias",
  PIN_SUPERVISOR: "2468",          // PIN para abrir el dashboard en el celular
  HORA_META_ENTRADA: "05:50",      // hora programada de llegada al astillero (turno entrada)
  HORA_META_SALIDA: "17:20",       // hora programada de salida del astillero (turno salida)
  TOLERANCIA_MIN: 5                // minutos de tolerancia para contar "a tiempo"
};
