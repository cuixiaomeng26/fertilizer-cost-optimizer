import * as XLSX from "xlsx";
import solver from "javascript-lp-solver";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Material {
  product: string;
  n: number; // ratio 0–1
  p: number;
  k: number;
  cost: number; // €/ton
}

export interface TargetProduct {
  name: string;
  n: number; // ratio 0–1
  p: number;
  k: number;
  firstComponentLabel: string; // "N" or NBPT/NPPT/LIMUS
}

export interface Formula {
  rank: number;
  cost: number;
  actualFirst: number; // %
  actualP: number;
  actualK: number;
  firstComponentLabel: string;
  weights: Record<string, number>; // product -> %
}

// ── Column detection (ported from app.py) ───────────────────────────────────

const RAW_PRODUCT_CANDIDATES = ["肥料名称 (Product)", "Product", "产品", "原料名称", "Material", "DESCRIZIONE"];
const TARGET_PRODUCT_CANDIDATES = ["Titolo MIX", "Product", "产品名称", "配方名称", "Formula", "DESCRIZIONE"];
const N_CANDIDATES = ["氮 (N Totale)", "N Totale", "N", "Nitrogen"];
const P_CANDIDATES = ["磷 (P)", "P", "Phosphorus"];
const K_CANDIDATES = ["钾 (K)", "K", "Potassium"];
const COST_CANDIDATES = ["价格 (Cost)", "Cost", "Price", "价格", "PREZZO €/TON"];

export const DEFAULT_EXCLUDED_MATERIALS = new Set(["AFF"]);
const SPECIAL_FIRST_COMPONENTS = ["NBPT", "NPPT", "LIMUS"];

const FILLER_KEYWORDS = [
  "DOLOMITE", "DOLOMIT", "FILLER", "BALLAST", "LIMESTONE",
  "CALCIUM CARBONATE", "CHALK", "CLAY", "SAND",
];

const SINGLE_NUTRIENT_TOLERANCE = 0.011;
const TOTAL_TOLERANCE = 0.019;

function findColumn(columns: string[], candidates: string[], required = true): string | null {
  const normalized = new Map<string, string>();
  for (const col of columns) normalized.set(String(col).trim().toLowerCase(), col);

  for (const candidate of candidates) {
    const key = candidate.trim().toLowerCase();
    const exact = normalized.get(key);
    if (exact !== undefined) return exact;
  }
  for (const candidate of candidates) {
    const key = candidate.trim().toLowerCase();
    for (const [nk, original] of normalized) {
      if (nk.includes(key)) return original;
    }
  }
  if (required) throw new Error(`Column not found: ${candidates.join(", ")}`);
  return null;
}

function normalizeRatio(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim().replace(/%/g, "");
  if (["", "-", "nan", "None"].includes(text)) return 0;
  const numeric = parseFloat(text.replace(",", "."));
  if (Number.isNaN(numeric)) return 0;
  return numeric > 1 ? numeric / 100 : numeric;
}

function detectSpecialFirstComponent(name: string): string | null {
  const upper = String(name).toUpperCase();
  for (const c of SPECIAL_FIRST_COMPONENTS) if (upper.includes(c)) return c;
  return null;
}

function parseNpkFromProductName(name: string): [number, number, number] | null {
  const text = String(name).trim().toUpperCase().replace(/\s/g, "");
  if (!text) return null;
  const match = text.match(/(\d{1,2}(?:[.,]\d+)?)-(\d{1,2}(?:[.,]\d+)?)-(\d{1,2}(?:[.,]\d+)?)/);
  if (!match) return null;
  return [match[1], match[2], match[3]].map((s) => parseFloat(s.replace(",", ".")) / 100) as [number, number, number];
}

// ── File parsing ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function readSheet(buffer: ArrayBuffer, preferredSheet?: string): Row[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName =
    preferredSheet && wb.SheetNames.includes(preferredSheet) ? preferredSheet : wb.SheetNames[0];
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName], { defval: "" });
}

export function parseRawMaterials(buffer: ArrayBuffer): Material[] {
  const rows = readSheet(buffer);
  if (rows.length === 0) throw new Error("Raw materials file is empty.");
  const columns = Object.keys(rows[0]);
  const productCol = findColumn(columns, RAW_PRODUCT_CANDIDATES)!;
  const nCol = findColumn(columns, N_CANDIDATES)!;
  const pCol = findColumn(columns, P_CANDIDATES)!;
  const kCol = findColumn(columns, K_CANDIDATES)!;
  const costCol = findColumn(columns, COST_CANDIDATES)!;

  const materials: Material[] = [];
  for (const row of rows) {
    const product = String(row[productCol] ?? "").trim();
    if (!product || product === "nan") continue;
    const costText = String(row[costCol] ?? "0").replace(/,/g, "");
    const cost = parseFloat(costText);
    materials.push({
      product,
      n: normalizeRatio(row[nCol]),
      p: normalizeRatio(row[pCol]),
      k: normalizeRatio(row[kCol]),
      cost: Number.isNaN(cost) ? 0 : cost,
    });
  }
  return materials;
}

export function parseProductTargets(buffer: ArrayBuffer): TargetProduct[] {
  const rows = readSheet(buffer, "Product");
  if (rows.length === 0) throw new Error("Product file is empty.");
  const columns = Object.keys(rows[0]);
  const productCol = findColumn(columns, TARGET_PRODUCT_CANDIDATES, false);

  const names = rows.map((row) =>
    String(productCol ? row[productCol] : row[columns[0]]).trim()
  );

  // Pass 1: parse N-P-K straight out of the product names (e.g. "MIX 20-10-10 NBPT")
  const parsed: TargetProduct[] = [];
  const seen = new Set<string>();
  names.forEach((name) => {
    const npk = parseNpkFromProductName(name);
    if (!npk) return;
    const item: TargetProduct = {
      name,
      n: npk[0],
      p: npk[1],
      k: npk[2],
      firstComponentLabel: detectSpecialFirstComponent(name) ?? "N",
    };
    const sig = `${item.name}|${item.n}|${item.p}|${item.k}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      parsed.push(item);
    }
  });
  if (parsed.length > 0) return parsed;

  // Pass 2: fall back to explicit N/P/K columns
  const nCol = findColumn(columns, N_CANDIDATES)!;
  const pCol = findColumn(columns, P_CANDIDATES)!;
  const kCol = findColumn(columns, K_CANDIDATES)!;

  const targets: TargetProduct[] = [];
  rows.forEach((row, idx) => {
    const rawName = productCol ? String(row[productCol]).trim() : "";
    const name = rawName && rawName !== "nan" ? rawName : `Product ${idx + 1}`;
    const n = normalizeRatio(row[nCol]);
    const p = normalizeRatio(row[pCol]);
    const k = normalizeRatio(row[kCol]);
    if (Math.abs(n) < 1e-9 && Math.abs(p) < 1e-9 && Math.abs(k) < 1e-9) return;
    targets.push({ name, n, p, k, firstComponentLabel: detectSpecialFirstComponent(name) ?? "N" });
  });
  return targets;
}

// ── Optimization (ported from app.py) ───────────────────────────────────────

export function isFiller(m: Material): boolean {
  const upper = m.product.toUpperCase();
  const hasFillerName = FILLER_KEYWORDS.some((kw) => upper.includes(kw));
  const zeroNutrients = Math.abs(m.n) < 1e-9 && Math.abs(m.p) < 1e-9 && Math.abs(m.k) < 1e-9;
  return hasFillerName || zeroNutrients;
}

function isDolomite(name: string): boolean {
  const upper = String(name).toUpperCase();
  return upper.includes("DOLOMITE") || upper.includes("DOLOMIT");
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface SolveOutput {
  cost: number;
  actualFirst: number;
  actualP: number;
  actualK: number;
  firstComponentLabel: string;
  weights: Record<string, number>;
}

function solveCombination(combo: Material[], target: TargetProduct): SolveOutput | null {
  const firstVector = combo.map((m) =>
    target.firstComponentLabel === "N"
      ? m.n
      : m.product.toUpperCase().includes(target.firstComponentLabel)
        ? 1
        : 0
  );

  const lb = [
    Math.max(target.n - SINGLE_NUTRIENT_TOLERANCE, 0),
    Math.max(target.p - SINGLE_NUTRIENT_TOLERANCE, 0),
    Math.max(target.k - SINGLE_NUTRIENT_TOLERANCE, 0),
  ];
  const ub = [target.n, target.p, target.k];
  const targetSum = target.n + target.p + target.k;

  const variables: Record<string, Record<string, number>> = {};
  combo.forEach((m, i) => {
    variables[`x${i}`] = {
      cost: m.cost,
      one: 1,
      first: firstVector[i],
      p: m.p,
      k: m.k,
      total: firstVector[i] + m.p + m.k,
    };
  });

  const result = solver.Solve({
    optimize: "cost",
    opType: "min",
    constraints: {
      one: { equal: 1 },
      first: { min: lb[0], max: ub[0] },
      p: { min: lb[1], max: ub[1] },
      k: { min: lb[2], max: ub[2] },
      total: { min: Math.max(targetSum - TOTAL_TOLERANCE, 0), max: targetSum },
    },
    variables,
  });

  if (!result.feasible) return null;

  const weights = combo.map((_, i) => {
    const w = result[`x${i}`];
    return typeof w === "number" ? w : 0;
  });

  // Percentages, rounded; drop near-zero components
  const rounded: Record<string, number> = {};
  combo.forEach((m, i) => {
    if (weights[i] > 1e-8) {
      const pct = round2(weights[i] * 100);
      if (pct > 0) rounded[m.product] = round2((rounded[m.product] ?? 0) + pct);
    }
  });

  // Assign the rounding gap to dolomite (or the largest component)
  const totalPct = round2(Object.values(rounded).reduce((a, b) => a + b, 0));
  const gap = round2(100 - totalPct);
  if (Math.abs(gap) > 0) {
    const names = Object.keys(rounded);
    const dolomite = names.find(isDolomite);
    const recipient =
      dolomite ?? names.reduce((a, b) => (rounded[a] >= rounded[b] ? a : b), names[0]);
    if (recipient) rounded[recipient] = round2(rounded[recipient] + gap);
  }

  const used: Record<string, number> = {};
  for (const [name, value] of Object.entries(rounded)) if (value > 0) used[name] = value;
  if (Object.keys(used).length === 0) return null;

  const dot = (vec: number[]) => weights.reduce((acc, w, i) => acc + w * vec[i], 0);

  return {
    cost: round2(dot(combo.map((m) => m.cost))),
    actualFirst: round2(dot(firstVector) * 100),
    actualP: round2(dot(combo.map((m) => m.p)) * 100),
    actualK: round2(dot(combo.map((m) => m.k)) * 100),
    firstComponentLabel: target.firstComponentLabel,
    weights: used,
  };
}

function signature(s: SolveOutput): string {
  const w = Object.entries(s.weights)
    .map(([name, v]) => `${name}:${round2(v)}`)
    .sort()
    .join("|");
  return `${s.cost}|${s.actualFirst}|${s.actualP}|${s.actualK}|${s.firstComponentLabel}|${w}`;
}

function* combinations<T>(items: T[], size: number): Generator<T[]> {
  const n = items.length;
  if (size > n) return;
  const idx = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]);
    let i = size - 1;
    while (i >= 0 && idx[i] === n - size + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function optimizeFormulas(
  materials: Material[],
  target: TargetProduct,
  excluded: Set<string>
): Formula[] {
  const excludedUpper = new Set([...excluded].map((s) => s.trim().toUpperCase()).filter(Boolean));
  const available = materials.filter((m) => !excludedUpper.has(m.product.toUpperCase()));

  const fillers = available.filter(isFiller);
  const dolomiteFillers = fillers.filter((m) => isDolomite(m.product));
  const effective = available.filter((m) => !isFiller(m));
  if (effective.length < 2) return [];

  const fillerPart = dolomiteFillers.length > 0 ? dolomiteFillers : fillers;

  const results: SolveOutput[] = [];
  const seen = new Set<string>();
  const maxSize = Math.min(3, effective.length);
  for (let size = 2; size <= maxSize; size++) {
    for (const combo of combinations(effective, size)) {
      const solved = solveCombination([...combo, ...fillerPart], target);
      if (solved) {
        const sig = signature(solved);
        if (!seen.has(sig)) {
          seen.add(sig);
          results.push(solved);
        }
      }
    }
  }

  return results
    .sort((a, b) => a.cost - b.cost)
    .map((r, i) => ({ rank: i + 1, ...r }));
}
