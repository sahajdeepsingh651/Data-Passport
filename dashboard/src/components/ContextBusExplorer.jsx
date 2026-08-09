import { useEffect, useState } from 'react';
import axios from 'axios';
import { Database, Lock, Users, Building, FileText } from 'lucide-react';

export default function ContextBusExplorer() {
  const [passports, setPassports] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch data passports from the real store backend
    const fetchPassports = async () => {
      try {
        const response = await axios.get('http://localhost:8000/v1/search', {
          headers: {
            'Authorization': 'Bearer dev-local-token' // Using the dev token
          },
          params: {
            q: '.*', // fetch all for demo (if supported) or rely on backend defaults
          }
        });
        setPassports(response.data.results || []);
      } catch (err) {
        console.error("Failed to fetch passports from Context Bus", err);
      } finally {
        setLoading(false);
      }
    };

    fetchPassports();
  }, []);

  const getVisibilityIcon = (vis) => {
    if (vis === 'private') return <Lock size={14} />;
    if (vis === 'team') return <Users size={14} />;
    return <Building size={14} />;
  };

  return (
    <div>
      <h2 style={{marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
        <Database color="var(--accent-blue)" /> 
        Context Bus (Knowledge Library)
      </h2>
      <p style={{color: 'var(--text-secondary)', marginBottom: '2rem'}}>
        Approved Data Passports currently available for retrieval by AI agents.
      </p>

      {loading ? (
        <p>Loading Context Bus...</p>
      ) : passports.length === 0 ? (
        <p>No passports found in the Context Bus yet.</p>
      ) : (
        <div className="passport-grid">
          {passports.map((p, idx) => (
            <div key={idx} className="glass-panel passport-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <div className="tag" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  {getVisibilityIcon(p.visibility)}
                  {p.visibility.toUpperCase()}
                </div>
                <div className="tag" style={{ color: 'var(--accent-blue)' }}>
                  {p.team || p.department || 'GLOBAL'}
                </div>
              </div>
              
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>
                <FileText size={16} style={{display: 'inline', marginRight: '4px', verticalAlign: 'text-bottom'}}/>
                {p.title || `Session ${p.session_id.substring(0,8)}`}
              </h3>
              
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {p.summary || p.content_snippet || 'No summary available.'}
              </p>

              <div style={{ fontSize: '0.75rem', color: '#666' }}>
                {new Date(p.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
