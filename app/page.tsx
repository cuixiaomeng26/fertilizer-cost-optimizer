"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, ArrowDown, Loader2, X, FileSpreadsheet, Search, Check } from "lucide-react";
import {
  parseRawMaterials,
  parseProductTargets,
  optimizeFormulas,
  DEFAULT_EXCLUDED_MATERIALS,
  type Material,
  type TargetProduct,
  type Formula,
} from "@/lib/optimizer";

// ── Upload zone ──────────────────────────────────────────────────────────────

function UploadZone({
  label,
  hint,
  fileName,
  onFile,
}: {
  label: string;
  hint: string;
  fileName: string | null;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-neutral-400 mb-2">
        {label}
      </p>
      <button
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`w-full text-left border px-5 py-6 transition-colors ${
          dragging
            ? "border-neutral-900 bg-neutral-50"
            : fileName
              ? "border-neutral-900"
              : "border-dashed border-neutral-300 hover:border-neutral-500"
        }`}
      >
        {fileName ? (
          <span className="flex items-center gap-2 text-sm text-neutral-900">
            <FileSpreadsheet className="w-4 h-4" />
            {fileName}
          </span>
        ) : (
          <span className="text-sm text-neutral-400">
            Drop file or click to browse
            <span className="block text-xs mt-1 text-neutral-300">{hint}</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ── Formula detail ───────────────────────────────────────────────────────────

function FormulaCard({ formula, best }: { formula: Formula; best: boolean }) {
  const entries = Object.entries(formula.weights).sort((a, b) => b[1] - a[1]);
  return (
    <div className={`py-5 ${best ? "" : "border-t border-neutral-100"}`}>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-sm text-neutral-400">
          {best ? "Best formula" : `Alternative ${formula.rank - 1}`}
        </span>
        <span className={`tabular-nums ${best ? "text-xl font-light" : "text-sm text-neutral-500"}`}>
          €{formula.cost.toFixed(2)}
          <span className="text-xs text-neutral-400"> /ton</span>
        </span>
      </div>
      <div className="space-y-2">
        {entries.map(([name, pct]) => (
          <div key={name} className="flex items-center gap-3">
            <span className="w-44 shrink-0 text-sm text-neutral-700 truncate" title={name}>
              {name}
            </span>
            <div className="flex-1 h-px bg-neutral-100 relative">
              <div
                className="absolute inset-y-0 left-0 -top-[1px] h-[3px] bg-neutral-900"
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <span className="w-16 text-right text-sm tabular-nums text-neutral-500">
              {pct.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-neutral-400">
        Actual {formula.firstComponentLabel} {formula.actualFirst.toFixed(2)}% · P{" "}
        {formula.actualP.toFixed(2)}% · K {formula.actualK.toFixed(2)}%
      </p>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

interface ProductResult {
  target: TargetProduct;
  formulas: Formula[];
}

export default function Home() {
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [targets, setTargets] = useState<TargetProduct[] | null>(null);
  const [rawFileName, setRawFileName] = useState<string | null>(null);
  const [productFileName, setProductFileName] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ProductResult[] | null>(null);
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const visibleResults = useMemo(() => {
    if (!results) return null;
    const query = filterQuery.trim().toLowerCase();
    const filtered = query
      ? results.filter((r) => r.target.name.toLowerCase().includes(query))
      : results;
    return [...filtered].sort((a, b) => {
      const ca = a.formulas[0]?.cost;
      const cb = b.formulas[0]?.cost;
      if (ca === undefined && cb === undefined) return 0;
      if (ca === undefined) return 1; // unsolved always last
      if (cb === undefined) return -1;
      return sortDir === "asc" ? ca - cb : cb - ca;
    });
  }, [results, filterQuery, sortDir]);

  async function handleRawFile(file: File) {
    setError(null);
    setResults(null);
    try {
      const parsed = parseRawMaterials(await file.arrayBuffer());
      if (parsed.length === 0) throw new Error("No materials recognised in the file.");
      setMaterials(parsed);
      setRawFileName(file.name);
      // Nothing is included by default — the user picks materials to use
      setIncluded(new Set());
    } catch (err) {
      setError(`Could not read raw materials file: ${(err as Error).message}`);
    }
  }

  async function handleProductFile(file: File) {
    setError(null);
    setResults(null);
    try {
      const parsed = parseProductTargets(await file.arrayBuffer());
      if (parsed.length === 0) throw new Error("No valid N-P-K targets recognised in the file.");
      setTargets(parsed);
      setProductFileName(file.name);
    } catch (err) {
      setError(`Could not read product file: ${(err as Error).message}`);
    }
  }

  function toggleIncluded(name: string) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setResults(null);
  }

  function selectAll() {
    if (!materials) return;
    setIncluded(
      new Set(
        materials
          .filter((m) => !DEFAULT_EXCLUDED_MATERIALS.has(m.product.toUpperCase()))
          .map((m) => m.product)
      )
    );
    setResults(null);
  }

  function clearSelection() {
    setIncluded(new Set());
    setResults(null);
  }

  function handleCalculate() {
    if (!materials || !targets) return;
    setLoading(true);
    setError(null);
    // Let the spinner paint before the solver blocks the main thread
    setTimeout(() => {
      try {
        const excluded = new Set(
          materials.filter((m) => !included.has(m.product)).map((m) => m.product)
        );
        const all: ProductResult[] = targets.map((target) => ({
          target,
          formulas: optimizeFormulas(materials, target, excluded),
        }));
        all.sort((a, b) => {
          const ca = a.formulas[0]?.cost ?? Infinity;
          const cb = b.formulas[0]?.cost ?? Infinity;
          return ca - cb;
        });
        setResults(all);
        setOpenProduct(all.find((r) => r.formulas.length > 0)?.target.name ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }, 50);
  }

  const ready = materials !== null && targets !== null && included.size >= 2;

  return (
    <main className="min-h-screen bg-white text-neutral-900 antialiased">
      <div className="max-w-3xl mx-auto px-6 py-20">
        {/* ── Hero ─────────────────────────────────────────── */}
        <header className="mb-16">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400 mb-4">
            Linear programming · runs in your browser
          </p>
          <h1 className="text-4xl font-light tracking-tight leading-tight mb-4">
            Fertilizer formulas,
            <br />
            at the lowest cost.
          </h1>
          <p className="text-neutral-500 leading-relaxed max-w-md">
            Upload your raw-material price list and target N-P-K products. The
            optimizer finds the cheapest blend for every formula — your data
            never leaves this page.
          </p>
        </header>

        {/* ── Uploads ──────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-10">
          <UploadZone
            label="Raw materials *"
            hint="Excel/CSV with product, N, P, K, cost columns"
            fileName={rawFileName}
            onFile={handleRawFile}
          />
          <UploadZone
            label="Target products *"
            hint="Excel/CSV with product names or N-P-K targets"
            fileName={productFileName}
            onFile={handleProductFile}
          />
        </div>

        {/* ── Materials / exclusion chips ──────────────────── */}
        {materials && (
          <section className="mb-10">
            <div className="flex items-baseline justify-between mb-3 gap-4 flex-wrap">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-neutral-400">
                Materials — click to include
              </p>
              <p className="text-xs text-neutral-400">
                {included.size} of {materials.length} selected ·{" "}
                <button onClick={selectAll} className="underline underline-offset-2 hover:text-neutral-900 transition-colors">
                  Select all
                </button>{" "}
                ·{" "}
                <button onClick={clearSelection} className="underline underline-offset-2 hover:text-neutral-900 transition-colors">
                  Clear
                </button>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {materials.map((m) => {
                const isIncluded = included.has(m.product);
                return (
                  <button
                    key={m.product}
                    onClick={() => toggleIncluded(m.product)}
                    title={`N ${(m.n * 100).toFixed(1)}% · P ${(m.p * 100).toFixed(1)}% · K ${(m.k * 100).toFixed(1)}% · €${m.cost}/ton`}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border transition-colors ${
                      isIncluded
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-200 text-neutral-400 hover:border-neutral-500 hover:text-neutral-700"
                    }`}
                  >
                    {isIncluded && <Check className="w-3 h-3" />}
                    {m.product}
                  </button>
                );
              })}
            </div>
            {included.size > 0 && included.size < 2 && (
              <p className="mt-3 text-xs text-neutral-400">
                Select at least 2 materials to optimize.
              </p>
            )}
          </section>
        )}

        {error && (
          <p className="mb-8 text-sm text-red-600 border-l-2 border-red-600 pl-3">{error}</p>
        )}

        {ready && (
          <button
            onClick={handleCalculate}
            disabled={loading}
            className="group inline-flex items-center gap-3 bg-neutral-900 text-white px-8 py-3.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50 transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Optimizing
              </>
            ) : (
              <>
                Calculate optimal formulas
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </button>
        )}

        {/* ── Results ──────────────────────────────────────── */}
        {results && visibleResults && (
          <section className="mt-20">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400 mb-6">
              Results — {results.filter((r) => r.formulas.length > 0).length} of {results.length}{" "}
              solvable
            </p>

            {/* ── Filter & sort ────────────────────────────── */}
            <div className="flex items-center gap-6 mb-8">
              <div className="flex-1 flex items-center gap-2 border-b border-neutral-200 focus-within:border-neutral-900 transition-colors">
                <Search className="w-4 h-4 text-neutral-300 shrink-0" />
                <input
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Filter by product name"
                  className="w-full bg-transparent py-2 text-sm text-neutral-900 placeholder:text-neutral-300 focus:outline-none"
                />
                {filterQuery && (
                  <button
                    onClick={() => setFilterQuery("")}
                    className="text-neutral-300 hover:text-neutral-900 transition-colors"
                    aria-label="Clear filter"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors shrink-0 pb-px"
              >
                Cost {sortDir === "asc" ? "low → high" : "high → low"}
                {sortDir === "asc" ? (
                  <ArrowUp className="w-3.5 h-3.5" />
                ) : (
                  <ArrowDown className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {visibleResults.length === 0 && (
              <p className="text-sm text-neutral-400 py-6 border-t border-neutral-200">
                No products match “{filterQuery}”.
              </p>
            )}

            <div>
              {visibleResults.map((r) => {
                const solved = r.formulas.length > 0;
                const isOpen = openProduct === r.target.name;
                const best = r.formulas[0];
                return (
                  <div key={r.target.name} className="border-t border-neutral-200">
                    <button
                      onClick={() => setOpenProduct(isOpen ? null : r.target.name)}
                      disabled={!solved}
                      className="w-full flex items-baseline justify-between gap-4 py-4 text-left disabled:cursor-default group"
                    >
                      <span className="min-w-0">
                        <span
                          className={`block text-[15px] truncate ${
                            solved
                              ? "text-neutral-900 group-hover:text-neutral-500 transition-colors"
                              : "text-neutral-300"
                          }`}
                        >
                          {r.target.name}
                        </span>
                        <span className="block text-xs text-neutral-400 mt-0.5">
                          Target {r.target.firstComponentLabel} {(r.target.n * 100).toFixed(1)} · P{" "}
                          {(r.target.p * 100).toFixed(1)} · K {(r.target.k * 100).toFixed(1)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums">
                        {solved ? (
                          <>
                            <span className="text-neutral-900">€{best.cost.toFixed(2)}</span>
                            <span className="text-neutral-400 text-xs"> /ton</span>
                          </>
                        ) : (
                          <span className="text-neutral-300 text-xs">no solution</span>
                        )}
                      </span>
                    </button>

                    {isOpen && solved && (
                      <div className="pb-6 pl-0 sm:pl-6">
                        {r.formulas.slice(0, 5).map((f) => (
                          <FormulaCard key={f.rank} formula={f} best={f.rank === 1} />
                        ))}
                        {r.formulas.length > 5 && (
                          <p className="text-xs text-neutral-400 mt-2">
                            {r.formulas.length - 5} more alternatives not shown
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <footer className="mt-24 pt-8 border-t border-neutral-100">
          <p className="text-xs text-neutral-300">
            Fertilizer Cost Optimizer — all computation happens locally in your browser.
          </p>
        </footer>
      </div>
    </main>
  );
}
