import Layout from '../components/Layout';
import { useEffect, useState } from 'react';

function fmt(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

export default function Winners() {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetch('/api/winners')
      .then(r => r.json())
      .then(data => { if (mounted) setWinners(data?.winners || []); })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  return (
    <Layout title="Winners">
      <div className="panel">
        <h1 className="h1">Winners</h1>
        <p className="muted">Recent giveaway winners (picked randomly, weighted by entries).</p>
        {loading ? (
          <div className="muted">Loading…</div>
        ) : winners.length === 0 ? (
          <div className="muted">No winners yet.</div>
        ) : (
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Winner</th>
                  <th>Prize</th>
                  <th>Entries</th>
                  <th>Picked</th>
                </tr>
              </thead>
              <tbody>
                {winners.map(w => (
                  <tr key={`${w.giveaway_id}-${w.user_id}`}
                    className={w.won ? 'rowWin' : ''}>
                    <td>
                      <div className="winnerCell">
                        {w.avatar_url ? (
                          <img className="avatar" src={w.avatar_url} alt="" />
                        ) : (
                          <div className="avatar avatarFallback" />
                        )}
                        <div>
                          <div className="winnerName">{w.display_name}</div>
                          <div className="muted small">Giveaway #{w.giveaway_id}</div>
                        </div>
                      </div>
                    </td>
                    <td>{w.prize_text}</td>
                    <td>{w.entries}</td>
                    <td className="muted">{fmt(w.picked_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
