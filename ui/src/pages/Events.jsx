import { useEffect, useState } from "react";
import { getJSON } from "../api.js";

export default function Events({ base }) {
  const [state, setState] = useState({ status: "loading", events: [] });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading", events: [] });
    getJSON(base, "/v1/admin/events", ctrl.signal)
      .then((body) => setState({ status: "ok", events: body.events ?? [], implemented: body.implemented }))
      .catch((error) => {
        if (error.name === "AbortError") return;
        setState({ status: "offline", events: [], error: error.message });
      });
    return () => ctrl.abort();
  }, [base]);

  return (
    <div className="page">
      <section className="panel">
        <header className="panel-head">
          <h2>Event log</h2>
          <p className="muted">
            Append-only repair, rebalance, and failure lines. The stream is Phase C.
            {state.status === "ok" && state.implemented === false ? " This node returned an empty log." : ""}
            {state.status === "offline" ? ` Node unreachable (${state.error}).` : ""}
          </p>
        </header>
        <ol className="log">
          {state.events.length === 0 ? (
            <li className="empty">No events yet.</li>
          ) : (
            state.events.map((event, index) => (
              <li key={index}>
                <span>{event.at ?? ""}</span>
                <span>{event.kind ?? ""}</span>
                <span>{event.message ?? ""}</span>
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}
