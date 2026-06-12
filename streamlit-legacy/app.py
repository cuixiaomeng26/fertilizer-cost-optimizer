from __future__ import annotations

from io import BytesIO
from itertools import combinations
import re
from typing import Iterable

import numpy as np
import pandas as pd
import streamlit as st
from scipy.optimize import linprog


st.set_page_config(page_title="Ottimizzatore Costi Formule Fertilizzanti", layout="wide")


RAW_PRODUCT_CANDIDATES = ["肥料名称 (Product)", "Product", "产品", "原料名称", "Material", "DESCRIZIONE"]
TARGET_PRODUCT_CANDIDATES = ["Titolo MIX", "Product", "产品名称", "配方名称", "Formula", "DESCRIZIONE"]
N_CANDIDATES = ["氮 (N Totale)", "N Totale", "N", "Nitrogen"]
P_CANDIDATES = ["磷 (P)", "P", "Phosphorus"]
K_CANDIDATES = ["钾 (K)", "K", "Potassium"]
COST_CANDIDATES = ["价格 (Cost)", "Cost", "Price", "价格", "PREZZO €/TON"]
DEFAULT_EXCLUDED_MATERIALS = {"AFF"}
SPECIAL_FIRST_COMPONENTS = ("NBPT", "NPPT", "LIMUS")

FILLER_KEYWORDS = (
    "DOLOMITE",
    "DOLOMIT",
    "FILLER",
    "BALLAST",
    "LIMESTONE",
    "CALCIUM CARBONATE",
    "CHALK",
    "CLAY",
    "SAND",
)

SINGLE_NUTRIENT_TOLERANCE = 0.011
TOTAL_TOLERANCE = 0.019
DISPLAY_DECIMALS = 2


def find_column(columns: Iterable[str], candidates: list[str], required: bool = True) -> str | None:
    normalized = {str(col).strip().lower(): col for col in columns}
    for candidate in candidates:
        key = candidate.strip().lower()
        if key in normalized:
            return normalized[key]

    for candidate in candidates:
        key = candidate.strip().lower()
        for normalized_key, original_col in normalized.items():
            if key in normalized_key:
                return original_col

    if required:
        raise KeyError(f"Colonna non trovata: {candidates}")
    return None


def normalize_ratio(value: float) -> float:
    if pd.isna(value):
        return 0.0
    text = str(value).strip().replace("%", "")
    if text in {"", "-", "nan", "None"}:
        return 0.0
    numeric = float(text)
    if numeric > 1:
        return numeric / 100.0
    return numeric


def detect_special_first_component(name: str) -> str | None:
    upper_name = str(name).upper()
    for component in SPECIAL_FIRST_COMPONENTS:
        if component in upper_name:
            return component
    return None


def parse_npk_from_product_name(name: str) -> tuple[float, float, float] | None:
    text = str(name).strip().upper().replace(" ", "")
    if not text:
        return None

    match = re.search(r"(\d{1,2}(?:[.,]\d+)?)\s*-\s*(\d{1,2}(?:[.,]\d+)?)\s*-\s*(\d{1,2}(?:[.,]\d+)?)", text)
    if not match:
        return None

    values = tuple(float(part.replace(",", ".")) / 100.0 for part in match.groups())
    return values


def read_table(file_bytes: bytes, file_name: str, preferred_sheet: str | None = None) -> pd.DataFrame:
    if not file_bytes:
        raise ValueError(f"Il file {file_name} e' vuoto e non puo' essere letto.")

    lower_name = file_name.lower()
    is_excel = lower_name.endswith((".xlsx", ".xlsm", ".xls")) or file_bytes[:2] == b"PK"

    if is_excel:
        excel_file = pd.ExcelFile(BytesIO(file_bytes))
        if preferred_sheet and preferred_sheet in excel_file.sheet_names:
            return pd.read_excel(excel_file, sheet_name=preferred_sheet)
        return pd.read_excel(excel_file, sheet_name=excel_file.sheet_names[0])

    return pd.read_csv(BytesIO(file_bytes), encoding_errors="ignore")


@st.cache_data(show_spinner=False)
def load_raw_materials(file_bytes: bytes, file_name: str) -> pd.DataFrame:
    raw_df = read_table(file_bytes, file_name)
    column_map = {
        "Product": find_column(raw_df.columns, RAW_PRODUCT_CANDIDATES),
        "N": find_column(raw_df.columns, N_CANDIDATES),
        "P": find_column(raw_df.columns, P_CANDIDATES),
        "K": find_column(raw_df.columns, K_CANDIDATES),
        "Cost": find_column(raw_df.columns, COST_CANDIDATES),
    }

    df = raw_df[[column_map["Product"], column_map["N"], column_map["P"], column_map["K"], column_map["Cost"]]].copy()
    df.columns = ["Product", "N", "P", "K", "Cost"]
    df = df.replace("-", 0).fillna(0)
    df["Product"] = df["Product"].astype(str).str.strip()

    for nutrient in ["N", "P", "K"]:
        df[nutrient] = pd.to_numeric(df[nutrient].astype(str).str.replace("%", "", regex=False), errors="coerce")
        df[nutrient] = df[nutrient].fillna(0.0).map(normalize_ratio)

    df["Cost"] = pd.to_numeric(df["Cost"].astype(str).str.replace(",", "", regex=False), errors="coerce").fillna(0.0)
    df = df[(df["Product"] != "")].reset_index(drop=True)
    return df


@st.cache_data(show_spinner=False)
def load_product_targets(file_bytes: bytes, file_name: str) -> pd.DataFrame:
    raw_df = read_table(file_bytes, file_name, preferred_sheet="Product")
    product_col = find_column(raw_df.columns, TARGET_PRODUCT_CANDIDATES, required=False)
    if product_col is not None:
        name_series = raw_df[product_col].astype(str).str.strip()
    else:
        first_col = raw_df.columns[0]
        name_series = raw_df[first_col].astype(str).str.strip()

    parsed_names = name_series.map(parse_npk_from_product_name)
    parsed_mask = parsed_names.notna()

    parsed_rows = []
    for name, parsed in zip(name_series[parsed_mask], parsed_names[parsed_mask]):
        n_val, p_val, k_val = parsed
        parsed_rows.append(
            {
                "TargetProduct": name,
                "N": n_val,
                "P": p_val,
                "K": k_val,
                "FirstComponentLabel": detect_special_first_component(name) or "N",
            }
        )

    parsed_df = pd.DataFrame(parsed_rows)
    if not parsed_df.empty:
        parsed_df = parsed_df.drop_duplicates(subset=["TargetProduct", "N", "P", "K"]).reset_index(drop=True)
        return parsed_df

    n_col = find_column(raw_df.columns, N_CANDIDATES)
    p_col = find_column(raw_df.columns, P_CANDIDATES)
    k_col = find_column(raw_df.columns, K_CANDIDATES)

    selected_cols = [n_col, p_col, k_col] if product_col is None else [product_col, n_col, p_col, k_col]
    df = raw_df[selected_cols].copy()
    if product_col is None:
        df.columns = ["N", "P", "K"]
        df.insert(0, "TargetProduct", [f"Prodotto {idx + 1}" for idx in range(len(df))])
    else:
        df.columns = ["TargetProduct", "N", "P", "K"]
    df["FirstComponentLabel"] = df["TargetProduct"].map(lambda value: detect_special_first_component(value) or "N")

    df = df.replace("-", 0).fillna(0)
    df["TargetProduct"] = df["TargetProduct"].astype(str).str.strip()
    for nutrient in ["N", "P", "K"]:
        df[nutrient] = pd.to_numeric(df[nutrient].astype(str).str.replace("%", "", regex=False), errors="coerce")
        df[nutrient] = df[nutrient].fillna(0.0).map(normalize_ratio)

    df = df[
        (df["TargetProduct"] != "")
        & ~(np.isclose(df["N"], 0.0) & np.isclose(df["P"], 0.0) & np.isclose(df["K"], 0.0))
    ].reset_index(drop=True)

    df["TargetProduct"] = df["TargetProduct"].replace("nan", "").replace("", np.nan)
    df["TargetProduct"] = df["TargetProduct"].fillna(pd.Series(range(1, len(df) + 1)).map(lambda x: f"Prodotto {x}"))
    return df


def is_filler(row: pd.Series) -> bool:
    product_name = str(row["Product"]).upper()
    has_filler_name = any(keyword in product_name for keyword in FILLER_KEYWORDS)
    zero_nutrients = np.isclose([row["N"], row["P"], row["K"]], 0.0).all()
    return has_filler_name or zero_nutrients


def is_dolomite(product_name: str) -> bool:
    return "DOLOMITE" in str(product_name).upper() or "DOLOMIT" in str(product_name).upper()


def solve_combination(combo_df: pd.DataFrame, target: dict[str, float]) -> dict | None:
    nutrient_matrix = combo_df[["N", "P", "K"]].to_numpy(dtype=float).T
    costs = combo_df["Cost"].to_numpy(dtype=float)
    n_items = len(combo_df)

    a_eq = np.ones((1, n_items))
    b_eq = np.array([1.0])

    if target["FirstComponentLabel"] == "N":
        first_component_vector = nutrient_matrix[0]
    else:
        first_component_vector = combo_df["Product"].astype(str).str.upper().str.contains(target["FirstComponentLabel"]).astype(float).to_numpy()

    lower_bounds = np.array(
        [
            max(target["FirstComponentValue"] - SINGLE_NUTRIENT_TOLERANCE, 0.0),
            max(target["P"] - SINGLE_NUTRIENT_TOLERANCE, 0.0),
            max(target["K"] - SINGLE_NUTRIENT_TOLERANCE, 0.0),
        ]
    )
    upper_bounds = np.array([target["FirstComponentValue"], target["P"], target["K"]])

    a_ub = []
    b_ub = []
    a_ub.append(-first_component_vector)
    b_ub.append(-lower_bounds[0])
    a_ub.append(first_component_vector)
    b_ub.append(upper_bounds[0])

    for idx in range(1, 3):
        a_ub.append(-nutrient_matrix[idx])
        b_ub.append(-lower_bounds[idx])
        a_ub.append(nutrient_matrix[idx])
        b_ub.append(upper_bounds[idx])

    total_vector = first_component_vector + nutrient_matrix[1] + nutrient_matrix[2]
    target_sum = target["FirstComponentValue"] + target["P"] + target["K"]
    a_ub.append(-total_vector)
    b_ub.append(-max(target_sum - TOTAL_TOLERANCE, 0.0))
    a_ub.append(total_vector)
    b_ub.append(target_sum)

    result = linprog(
        c=costs,
        A_ub=np.array(a_ub),
        b_ub=np.array(b_ub),
        A_eq=a_eq,
        b_eq=b_eq,
        bounds=[(0, 1)] * n_items,
        method="highs",
    )

    if not result.success:
        return None

    weights = result.x
    raw_used = {row.Product: float(weight * 100) for row, weight in zip(combo_df.itertuples(index=False), weights) if weight > 1e-8}
    rounded_used = {name: round(value, DISPLAY_DECIMALS) for name, value in raw_used.items() if round(value, DISPLAY_DECIMALS) > 0}
    total_percentage = round(sum(rounded_used.values()), DISPLAY_DECIMALS)
    rounding_gap = round(100.0 - total_percentage, DISPLAY_DECIMALS)

    if abs(rounding_gap) > 0:
        dolomite_names = [name for name in rounded_used if is_dolomite(name)]
        if dolomite_names:
            rounded_used[dolomite_names[0]] = round(rounded_used[dolomite_names[0]] + rounding_gap, DISPLAY_DECIMALS)
        else:
            largest_component = max(rounded_used, key=rounded_used.get, default=None)
            if largest_component is not None:
                rounded_used[largest_component] = round(rounded_used[largest_component] + rounding_gap, DISPLAY_DECIMALS)

    used = {name: value for name, value in rounded_used.items() if value > 0}
    if not used:
        return None

    return {
        "Costo Totale (€/Ton)": round(float(np.dot(weights, combo_df["Cost"])), DISPLAY_DECIMALS),
        "Voce 1 Reale": round(float(np.dot(weights, first_component_vector)) * 100, DISPLAY_DECIMALS),
        "P Reale": round(float(np.dot(weights, combo_df["P"])) * 100, DISPLAY_DECIMALS),
        "K Reale": round(float(np.dot(weights, combo_df["K"])) * 100, DISPLAY_DECIMALS),
        "Composizione": "Composizione",
        "FirstComponentLabel": target["FirstComponentLabel"],
        "weights": used,
    }


def build_solution_signature(result: dict) -> tuple:
    weights_signature = tuple(sorted((name, round(weight, DISPLAY_DECIMALS)) for name, weight in result["weights"].items()))
    return (
        round(result["Costo Totale (€/Ton)"], DISPLAY_DECIMALS),
        round(result["Voce 1 Reale"], DISPLAY_DECIMALS),
        round(result["P Reale"], DISPLAY_DECIMALS),
        round(result["K Reale"], DISPLAY_DECIMALS),
        result["FirstComponentLabel"],
        weights_signature,
    )


def optimize_formulas(
    raw_df: pd.DataFrame,
    target_n: float,
    target_p: float,
    target_k: float,
    first_component_label: str = "N",
    excluded_materials: set[str] | None = None,
) -> pd.DataFrame:
    target = {
        "FirstComponentValue": target_n / 100.0,
        "FirstComponentLabel": first_component_label,
        "P": target_p / 100.0,
        "K": target_k / 100.0,
    }
    excluded_materials = {item.strip().upper() for item in (excluded_materials or set()) if item.strip()}
    filtered_df = raw_df[~raw_df["Product"].str.upper().isin(excluded_materials)].copy()

    filler_mask = filtered_df.apply(is_filler, axis=1)
    fillers = filtered_df[filler_mask].copy()
    dolomite_fillers = fillers[fillers["Product"].map(is_dolomite)].copy()
    effective = filtered_df[~filler_mask].copy()

    if len(effective) < 2:
        return pd.DataFrame()

    results: list[dict] = []
    seen_signatures: set[tuple] = set()
    if not dolomite_fillers.empty:
        filler_part = dolomite_fillers
    else:
        filler_part = fillers if not fillers.empty else pd.DataFrame(columns=filtered_df.columns)

    for size in range(2, min(4, len(effective)) + 1):
        for combo in combinations(effective.index.tolist(), size):
            combo_df = pd.concat([effective.loc[list(combo)], filler_part], ignore_index=True)
            solved = solve_combination(combo_df, target)
            if solved is not None:
                signature = build_solution_signature(solved)
                if signature in seen_signatures:
                    continue
                seen_signatures.add(signature)
                results.append(solved)

    if not results:
        return pd.DataFrame()

    ingredient_names = sorted({name for result in results for name in result["weights"]})
    ranked = sorted(results, key=lambda item: item["Costo Totale (€/Ton)"])
    rows = []
    for rank, result in enumerate(ranked, start=1):
        row = {
            "Classifica": rank,
            "Costo Totale (€/Ton)": result["Costo Totale (€/Ton)"],
            "Voce 1 Reale": result["Voce 1 Reale"],
            "P Reale": result["P Reale"],
            "K Reale": result["K Reale"],
            "Composizione": result["Composizione"],
        }
        for ingredient in ingredient_names:
            row[ingredient] = result["weights"].get(ingredient, 0.0)
        rows.append(row)
    return pd.DataFrame(rows)


def build_batch_results(
    raw_df: pd.DataFrame,
    product_df: pd.DataFrame,
    excluded_materials: set[str] | None = None,
) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    summary_rows = []
    detail_tables: dict[str, pd.DataFrame] = {}

    for row in product_df.itertuples(index=False):
        result_df = optimize_formulas(
            raw_df,
            row.N * 100,
            row.P * 100,
            row.K * 100,
            first_component_label=row.FirstComponentLabel,
            excluded_materials=excluded_materials,
        )
        detail_tables[row.TargetProduct] = result_df
        if result_df.empty:
            summary_rows.append(
                {
                    "Prodotto": row.TargetProduct,
                    "Target Voce 1": round(row.N * 100, DISPLAY_DECIMALS),
                    "Target P": round(row.P * 100, DISPLAY_DECIMALS),
                    "Target K": round(row.K * 100, DISPLAY_DECIMALS),
                    "Stato": "Nessuna soluzione",
                    "Miglior Costo (€/Ton)": np.nan,
                    "Miglior Voce 1 Reale": np.nan,
                    "Miglior P Reale": np.nan,
                    "Miglior K Reale": np.nan,
                }
            )
            continue

        best = result_df.iloc[0]
        summary_rows.append(
            {
                    "Prodotto": row.TargetProduct,
                    "Target Voce 1": round(row.N * 100, DISPLAY_DECIMALS),
                    "Target P": round(row.P * 100, DISPLAY_DECIMALS),
                    "Target K": round(row.K * 100, DISPLAY_DECIMALS),
                    "Stato": "Soluzione trovata",
                    "Miglior Costo (€/Ton)": best["Costo Totale (€/Ton)"],
                    "Miglior Voce 1 Reale": best["Voce 1 Reale"],
                    "Miglior P Reale": best["P Reale"],
                    "Miglior K Reale": best["K Reale"],
                }
            )

    summary_df = pd.DataFrame(summary_rows)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(by=["Stato", "Miglior Costo (€/Ton)"], ascending=[False, True], na_position="last")
        summary_df = summary_df.reset_index(drop=True)
    return summary_df, detail_tables


def highlight_best_formula(row: pd.Series) -> list[str]:
    if row.name == 0:
        return ["background-color: #fff3bf; font-weight: 700;"] * len(row)
    return [""] * len(row)


def highlight_feasible(row: pd.Series) -> list[str]:
    if row.get("Stato") == "Soluzione trovata":
        return ["background-color: #e6fcf5;"] * len(row)
    return ["background-color: #fff5f5;"] * len(row)


def render_material_preview(df: pd.DataFrame) -> None:
    st.subheader("Database materie prime")
    col1, col2, col3 = st.columns(3)
    filler_mask = df.apply(is_filler, axis=1)
    col1.metric("Materie prime totali", len(df))
    col2.metric("Materie prime attive", int((~filler_mask).sum()))
    col3.metric("Riempitivi", int(filler_mask.sum()))

    preview_df = df.copy()
    for col in ["N", "P", "K"]:
        preview_df[col] = (preview_df[col] * 100).round(DISPLAY_DECIMALS)
    st.dataframe(preview_df, use_container_width=True, hide_index=True)


def render_product_preview(df: pd.DataFrame) -> None:
    st.subheader("Tabella prodotti target")
    preview_df = df[["TargetProduct", "N", "P", "K"]].copy()
    for col in ["N", "P", "K"]:
        preview_df[col] = (preview_df[col] * 100).round(DISPLAY_DECIMALS)
    preview_df.columns = ["Prodotto", "Target Voce 1", "Target P", "Target K"]
    st.dataframe(preview_df, use_container_width=True, hide_index=True)


def render_formula_table(result_df: pd.DataFrame) -> None:
    ingredient_columns = [col for col in result_df.columns if col not in {"Classifica", "Costo Totale (€/Ton)", "Voce 1 Reale", "P Reale", "K Reale", "Composizione"}]
    format_map = {
        "Costo Totale (€/Ton)": "{:.2f}",
        "Voce 1 Reale": "{:.2f}%",
        "P Reale": "{:.2f}%",
        "K Reale": "{:.2f}%",
    }
    for col in ingredient_columns:
        format_map[col] = "{:.2f}%"

    st.dataframe(
        result_df.style.apply(highlight_best_formula, axis=1).format(format_map),
        use_container_width=True,
        hide_index=True,
    )


def main() -> None:
    st.title("Ottimizzatore Costi Formule Fertilizzanti")
    st.caption("`rawmaterial` contiene materie prime e prezzi. `product` contiene i target N/P/K dei prodotti. L'app legge i file e calcola automaticamente la formula a costo minimo.")

    left_col, right_col = st.columns(2)
    raw_file = left_col.file_uploader("Carica il file materie prime `rawmaterial`", type=["csv", "xlsx", "xls"])
    product_file = right_col.file_uploader("Carica il file prodotti `product`", type=["csv", "xlsx", "xls"])

    if raw_file is None or product_file is None:
        st.info("Carica entrambi i file `rawmaterial` e `product`. Anche se `product` ha estensione `.csv`, puo' essere riconosciuto come Excel se il contenuto lo e'.")
        return

    try:
        raw_df = load_raw_materials(raw_file.getvalue(), raw_file.name)
        product_df = load_product_targets(product_file.getvalue(), product_file.name)
    except Exception as exc:
        st.error(f"Lettura file o riconoscimento colonne fallito: {exc}")
        return

    if raw_df.empty:
        st.error("La tabella delle materie prime e' vuota.")
        return
    if product_df.empty:
        st.error("La tabella prodotti non contiene target N/P/K validi.")
        return

    with st.expander("Visualizza la tabella materie prime pulita", expanded=False):
        render_material_preview(raw_df)
    with st.expander("Visualizza i target prodotto riconosciuti", expanded=False):
        render_product_preview(product_df)

    available_materials = sorted(raw_df["Product"].dropna().astype(str).unique().tolist())
    default_exclusions = [name for name in available_materials if name.upper() in DEFAULT_EXCLUDED_MATERIALS]
    excluded_materials = st.multiselect(
        "Materie prime escluse dal calcolo",
        options=available_materials,
        default=default_exclusions,
        help="AFF e' escluso di default perche' liquido. Se serve, puoi rimetterlo manualmente.",
    )

    options = ["Tutti i prodotti"] + product_df["TargetProduct"].tolist()
    selected_product = st.selectbox("Seleziona il prodotto da calcolare", options=options, index=0)

    if st.button("Calcola la formula ottimale", type="primary", use_container_width=True):
        with st.spinner("Calcolo combinazioni e risoluzione del modello lineare in corso..."):
            if selected_product == "Tutti i prodotti":
                summary_df, detail_tables = build_batch_results(raw_df, product_df, excluded_materials=set(excluded_materials))
                st.subheader("Riepilogo risultati ottimali")
                st.dataframe(
                    summary_df.style.apply(highlight_feasible, axis=1).format(
                        {
                            "Target Voce 1": "{:.2f}%",
                            "Target P": "{:.2f}%",
                            "Target K": "{:.2f}%",
                            "Miglior Costo (€/Ton)": "{:.2f}",
                            "Miglior Voce 1 Reale": "{:.2f}%",
                            "Miglior P Reale": "{:.2f}%",
                            "Miglior K Reale": "{:.2f}%",
                        }
                    ),
                    use_container_width=True,
                    hide_index=True,
                )

                feasible_products = [name for name, table in detail_tables.items() if not table.empty]
                if feasible_products:
                    chosen = st.selectbox("Visualizza il dettaglio formula di un prodotto", feasible_products, key="detail_product")
                    st.subheader(f"Dettaglio formula ottimale per {chosen}")
                    render_formula_table(detail_tables[chosen])
                else:
                    st.warning("Nessun prodotto ha una soluzione fattibile con i vincoli attuali.")
                return

            selected_row = product_df.loc[product_df["TargetProduct"] == selected_product].iloc[0]
            result_df = optimize_formulas(
                raw_df,
                selected_row["N"] * 100,
                selected_row["P"] * 100,
                selected_row["K"] * 100,
                first_component_label=selected_row["FirstComponentLabel"],
                excluded_materials=set(excluded_materials),
            )

        if result_df.empty:
            st.error(f"Nessuna formula fattibile trovata per {selected_product} con le tolleranze impostate.")
            return

        st.subheader(f"Risultati formula ottimale per {selected_product}")
        render_formula_table(result_df)
        best = result_df.iloc[0]
        st.success(
            f"La soluzione migliore costa {best['Costo Totale (€/Ton)']:.2f} €/Ton, "
            f"con Voce 1/P/K reali pari a {best['Voce 1 Reale']:.2f}% / {best['P Reale']:.2f}% / {best['K Reale']:.2f}%."
        )


if __name__ == "__main__":
    main()
