# Fertilizer Formula Cost Optimizer

A Streamlit web app that finds the **lowest-cost raw-material blend** for fertilizer formulas using linear programming (`scipy.optimize.linprog`).

Upload a price list (Excel), set the target N-P-K composition, and the optimizer computes the cheapest combination of raw materials that meets the nutrient requirements — including handling of fillers, excluded materials, and special components (NBPT/NPPT/LIMUS).

## Features

- 📊 Excel price-list import with flexible column-name detection (supports Chinese/Italian/English headers)
- 🎯 Target N-P-K composition constraints solved via linear programming
- 💰 Per-formula cost breakdown and comparison against current recipes
- 📥 One-click export of optimized formulas back to Excel

## Run locally

```bash
pip install -r requirements.txt
streamlit run app.py
```

Then open http://localhost:8501 in your browser.

## Tech stack

Python · Streamlit · pandas · NumPy · SciPy (linprog) · openpyxl
