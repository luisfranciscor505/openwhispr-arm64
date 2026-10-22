import { useEffect, useId, useState } from "react";
import type { WhisperNpuStatus } from "../types/electron";

export function NpuAccelerationSettings() {
  const id = useId();
  const [status, setStatus] = useState<WhisperNpuStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await window.electronAPI.getWhisperNpuStatus();
        if (active) setStatus(value);
      } catch (reason) {
        if (active) setError(String(reason));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  async function probe() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.electronAPI.getWhisperNpuStatus(true));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function change(preference: "automatic" | "npu" | "cpu") {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.electronAPI.setWhisperNpuPreference(preference));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      <label htmlFor={id}>Speech acceleration</label>
      <select
        id={id}
        className="ms-2 rounded border bg-background p-1"
        disabled={busy || !status}
        value={status?.preference || "automatic"}
        onChange={(event) => void change(event.target.value as "automatic" | "npu" | "cpu")}
      >
        <option value="automatic">Automatic (NPU with CPU fallback)</option>
        <option value="npu">NPU</option>
        <option value="cpu">CPU</option>
      </select>
      <button
        type="button"
        className="ms-2 underline"
        disabled={busy || !status?.downloaded}
        onClick={() => void probe()}
      >
        {busy ? "Checking…" : "Check NPU"}
      </button>
      <p role="status" aria-live="polite">
        {status
          ? `Active backend: ${status.backend === "qnn-htp" ? "Snapdragon NPU" : status.backend === "cpu" ? "ARM64 CPU" : "not started"}`
          : "Checking NPU…"}
      </p>
      {(error || status?.unavailableReason) && (
        <p role="alert" className="text-muted-foreground">
          {error || status?.unavailableReason}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Applies to Whisper Base — Snapdragon NPU. Other models keep their existing backend.
      </p>
    </div>
  );
}
