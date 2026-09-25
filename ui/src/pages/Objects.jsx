export default function Objects() {
  return (
    <div className="page">
      <section className="panel">
        <header className="panel-head">
          <h2>Objects</h2>
          <p className="muted">
            Columns are the Phase E replica map. Put, Get, and Delete return 501 until Phase A, so this table stays empty.
          </p>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Size</th>
                <th scope="col">Version</th>
                <th scope="col">Replicas</th>
                <th scope="col">Checksum</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="empty">No objects stored.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="metrics" aria-label="Overhead metrics">
        <article>
          <h3>Storage overhead</h3>
          <p className="metric">3.0×</p>
          <p className="muted">Stated cost of N=3. Erasure coding is not in the MVP.</p>
        </article>
        <article>
          <h3>Last repair</h3>
          <p className="metric">—</p>
          <p className="muted">Filled when Repair runs.</p>
        </article>
        <article>
          <h3>Under-replicated</h3>
          <p className="metric">—</p>
          <p className="muted">Filled from the replica map.</p>
        </article>
      </section>
    </div>
  );
}
