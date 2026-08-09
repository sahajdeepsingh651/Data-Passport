import { useEffect, useState } from 'react';
import axios from 'axios';
import { CheckSquare, CheckCircle, Clock } from 'lucide-react';

export default function ApprovalInbox() {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Poll the gateway for pending drafts
    const fetchDrafts = async () => {
      try {
        const response = await axios.get('http://localhost:8080/v1/dashboard/pending');
        setDrafts(response.data.drafts || []);
      } catch (err) {
        console.error("Failed to fetch pending drafts", err);
      } finally {
        setLoading(false);
      }
    };

    fetchDrafts();
    const interval = setInterval(fetchDrafts, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h2 style={{marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
        <CheckSquare color="var(--accent-red)" /> 
        Approval Inbox
      </h2>
      <p style={{color: 'var(--text-secondary)', marginBottom: '2rem'}}>
        AI drafts waiting for ESDS_APPROVE before entering the Context Bus.
      </p>

      {loading ? (
        <p>Loading inbox...</p>
      ) : drafts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--bg-glass)', borderRadius: '12px' }}>
          <CheckCircle size={48} color="var(--accent-green)" style={{marginBottom: '1rem'}} />
          <h3 style={{margin: 0}}>Inbox Zero</h3>
          <p style={{color: 'var(--text-secondary)'}}>All intercepted drafts have been processed.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {drafts.map((d, idx) => (
            <div key={idx} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.2rem' }}>{d.title || `Draft ${d.pending_id}`}</h3>
                <div className="tag" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'orange', background: 'rgba(255, 165, 0, 0.1)' }}>
                  <Clock size={14} /> Pending Approval
                </div>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Session ID</div>
                  <div style={{ fontFamily: 'monospace' }}>{d.session_id}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Visibility</div>
                  <div>{d.visibility}</div>
                </div>
              </div>

              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Sanitized Summary (Safe to publish)</div>
                <div className="code-block" style={{ padding: '0.75rem', margin: 0 }}>
                  {d.summary}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
