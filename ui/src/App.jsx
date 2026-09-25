import { useState } from "react";
import Cluster from "./pages/Cluster.jsx";
import Objects from "./pages/Objects.jsx";
import Events from "./pages/Events.jsx";

const PAGES = [
  ["cluster", "Cluster"],
  ["objects", "Objects"],
  ["events", "Events"],
];

export default function App() {
  const [page, setPage] = useState("cluster");
  const [base, setBase] = useState("http://localhost:8081");

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <p className="mark">Athanor</p>
          <h1>Control plane</h1>
        </div>
        <nav className="nav" aria-label="Sections">
          {PAGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={page === id ? "nav-btn active" : "nav-btn"}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="endpoint">
          Node
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            spellCheck="false"
            aria-label="Node HTTP base URL"
          />
        </label>
      </header>
      <main>
        {page === "cluster" && <Cluster base={base} />}
        {page === "objects" && <Objects />}
        {page === "events" && <Events base={base} />}
      </main>
    </div>
  );
}
