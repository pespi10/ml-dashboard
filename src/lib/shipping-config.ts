// ============================================================
// CONFIGURACIÓN DE ENVÍOS — ACTUALIZAR CUANDO SE CONFIRMEN LOS VALORES
// ============================================================

// Costo fijo por pedido de logística propia (GBA Norte + CABA)
// PENDIENTE CONFIRMAR — valor estimado
export const LOGISTICA_PROPIA_COSTO_POR_PEDIDO = 7000;

// Códigos postales de CABA (1000-1499)
export const CP_CABA = { min: 1000, max: 1499 };

// Partidos de GBA Norte hasta Pilar
export const PARTIDOS_GBA_NORTE = [
  "Vicente López",
  "San Isidro",
  "San Fernando",
  "Tigre",
  "Escobar",
  "Pilar",
  "Malvinas Argentinas",
  "José C. Paz",
  "San Miguel",
  "Moreno",  // corredor norte
  "Hurlingham",
  "Ituzaingó",
  "Tres de Febrero",
  "General San Martín",
];

// Rango de CPs de GBA Norte (aproximado)
export const CP_GBA_NORTE = { min: 1600, max: 1749 };

export function isLogisticaPropia(zipCode: string | null | undefined): boolean {
  if (!zipCode) return false;
  const cp = parseInt(zipCode.replace(/\D/g, ""));
  if (isNaN(cp)) return false;
  return (
    (cp >= CP_CABA.min && cp <= CP_CABA.max) ||
    (cp >= CP_GBA_NORTE.min && cp <= CP_GBA_NORTE.max)
  );
}

// ============================================================
