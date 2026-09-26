import { useMemo } from "react";
import { api } from "./api.js";

const TOKEN_HINT = "this cluster needs an admin token. Set it under the plug icon.";

/** One line for a finished scrub across every node. */
export function scrubSummary(r) {
  const res = r.results ?? [];
  const checked = res.reduce((s, x) => s + x.checked, 0);
  const bad = res.reduce((s, x) => s + x.mismatches, 0);
  const dropped = res.reduce((s, x) => s + (x.hints_dropped || 0), 0);
  const hints = dropped ? `, ${dropped} corrupt hint${dropped === 1 ? "" : "s"} dropped` : "";
  return `Scrubbed ${res.length} nodes: ${checked} replicas re-hashed, ${bad} mismatch${bad === 1 ? "" : "es"}${bad ? ", repaired from healthy copies" : ""}${hints}.`;
}

/** The message for a failed action: a 401 gets a pointer to the token field. */
export function failureText(prefix, e) {
  return e?.status === 401 ? `${prefix}: ${TOKEN_HINT}` : `${prefix}: ${e?.message ?? "unknown error"}`;
}

/**
 * Every button on the dashboard, as a function that calls the API, tells
 * the user what happened through `notify`, and asks for a fresh overview.
 */
export function useActions({ base, notify, refresh, setBusy }) {
  return useMemo(() => {
    const run = async (fn, okText, failText, tone = "ok") => {
      try {
        const res = await fn();
        const text = typeof okText === "function" ? okText(res) : okText;
        if (text) notify(typeof tone === "function" ? tone(res) : tone, text);
        refresh();
        return res;
      } catch (e) {
        notify("error", failureText(failText, e));
        refresh();
        return null;
      }
    };
    return {
      scrub: async () => {
        setBusy((b) => ({ ...b, scrub: true }));
        await run(
          () => api.scrub(base),
          scrubSummary,
          "Scrub failed",
          (r) => ((r.results ?? []).some((x) => x.mismatches) ? "warn" : "ok"),
        );
        setBusy((b) => ({ ...b, scrub: false }));
      },
      stopNode: (id) => run(() => api.nodeAction(base, id, "stop"), `${id} stopped. Peers will notice through missed probes.`, `Could not stop ${id}`, "warn"),
      startNode: (id) => run(() => api.nodeAction(base, id, "start"), `${id} started and is rejoining through its seeds.`, `Could not start ${id}`),
      partition: (a, b) => run(() => api.partition(base, a, b), `Cut the network between ${a} and ${b}.`, "Partition failed", "warn"),
      heal: () => run(() => api.heal(base), "Every partition healed.", "Heal failed"),
      corrupt: (key, node) =>
        run(() => api.corrupt(base, key, node), `Flipped a byte of ${key} on ${node}. Scrub or read it to see the heal.`, "Corrupt failed", "warn"),
      repair: (key) =>
        run(
          () => api.repair(base, key),
          (r) =>
            r.pushed?.length ? `Repaired ${key}: pushed from ${r.source} to ${r.pushed.join(", ")}.` : `${key} is already healthy on every reachable owner.`,
          `Repair of ${key} failed`,
        ),
      del: (key) => run(() => api.del(base, key), `Deleted ${key}. A tombstone replicates like any write.`, `Delete of ${key} failed`),
      setQuorum: (q) => run(() => api.setQuorum(base, q), `Policy ${q.n}/${q.w}/${q.r} gossiped to the cluster.`, "Policy change rejected"),
      put: async (key, file) => {
        try {
          const body = await api.put(base, key, file);
          const hints = body.acks.filter((a) => a.hint_for);
          notify(hints.length ? "warn" : "ok", `Stored ${key}: acked by ${body.acks.map((a) => a.node).join(", ")}${hints.length ? " (with a hint)" : ""}.`);
          refresh();
          return { body };
        } catch (e) {
          notify("error", failureText("Upload failed", e));
          return { error: e.message, body: e.body };
        }
      },
      read: async (key) => {
        try {
          const res = await api.get(base, key);
          return { ...res, key, url: URL.createObjectURL(res.blob) };
        } catch (e) {
          return { key, error: e.message };
        }
      },
    };
  }, [base, notify, refresh, setBusy]);
}
