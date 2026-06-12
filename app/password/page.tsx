"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";

export default function PasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit() {
    if (!password || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        setError(true);
        setLoading(false);
      }
    } catch {
      setError(true);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900 antialiased flex items-center">
      <div className="max-w-sm mx-auto px-6 w-full -mt-20">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400 mb-4">
          Private preview
        </p>
        <h1 className="text-3xl font-light tracking-tight leading-tight mb-8">
          This tool is
          <br />
          password-protected.
        </h1>

        <label className="block text-[11px] font-medium uppercase tracking-[0.15em] text-neutral-400 mb-2">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          autoFocus
          className="w-full bg-transparent border-0 border-b border-neutral-200 px-0 py-2.5 text-[15px] text-neutral-900 placeholder:text-neutral-300 focus:outline-none focus:border-neutral-900 transition-colors rounded-none"
        />

        {error && (
          <p className="mt-3 text-sm text-red-600 border-l-2 border-red-600 pl-3">
            Incorrect password.
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={loading || !password}
          className="group mt-8 inline-flex items-center gap-3 bg-neutral-900 text-white px-8 py-3.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50 transition-colors"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Enter
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </button>
      </div>
    </main>
  );
}
