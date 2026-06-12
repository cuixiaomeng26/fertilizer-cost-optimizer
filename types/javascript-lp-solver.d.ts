declare module "javascript-lp-solver" {
  export interface LpModel {
    optimize: string;
    opType: "min" | "max";
    constraints: Record<string, { min?: number; max?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
  }
  export interface LpResult {
    feasible: boolean;
    result: number;
    bounded?: boolean;
    [variable: string]: number | boolean | undefined;
  }
  const solver: { Solve(model: LpModel): LpResult };
  export default solver;
}
