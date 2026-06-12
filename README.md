# Fertilizer Cost Optimizer

A web app that finds the **lowest-cost raw-material blend** for fertilizer formulas using linear programming — entirely in the browser. No server, no upload: your price data never leaves the page.

Built with Next.js + TypeScript; originally prototyped in Python/Streamlit with `scipy.optimize.linprog` (kept in [`streamlit-legacy/`](streamlit-legacy/) — the TypeScript port produces identical results).

## How it works

1. **Upload two files** — a raw-material price list and a target-product list (Excel/CSV, flexible column-name detection for English/Chinese/Italian headers).
2. **Toggle materials** you want to exclude with one click.
3. **Optimize** — for every target product the solver enumerates 2–3-material combinations (plus fillers such as dolomite), solves a cost-minimizing linear program under N-P-K tolerance constraints, and ranks all feasible formulas by €/ton.

Targets can be parsed straight from product names (e.g. `MIX 20-10-10 NBPT`), with special handling for NBPT/NPPT/LIMUS first components.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Tech stack

Next.js · TypeScript · Tailwind CSS · SheetJS (xlsx) · javascript-lp-solver
