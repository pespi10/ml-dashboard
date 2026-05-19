import { supabaseAdmin } from "./supabase";

export interface ProductCost {
  mla_id: string;
  ean?: string | null;
  codigo?: string | null;
  nombre?: string | null;
  titulo_ml?: string | null;
  costo: number;
  precio_lista?: number | null;
  match_method?: string | null;
  updated_at?: string;
}

export interface AppConfig {
  key: string;
  value: string;
}

export async function getProductCosts(): Promise<ProductCost[]> {
  const { data, error } = await supabaseAdmin.from("product_costs").select("*");
  if (error) throw error;
  return data ?? [];
}

export async function upsertProductCosts(costs: ProductCost[]): Promise<void> {
  if (costs.length === 0) return;
  const { error } = await supabaseAdmin
    .from("product_costs")
    .upsert(costs, { onConflict: "mla_id" });
  if (error) throw error;
}

export async function deleteProductCost(mlaId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("product_costs")
    .delete()
    .eq("mla_id", mlaId);
  if (error) throw error;
}

export async function getConfig(key: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("app_config")
    .upsert({ key, value }, { onConflict: "key" });
  if (error) throw error;
}
