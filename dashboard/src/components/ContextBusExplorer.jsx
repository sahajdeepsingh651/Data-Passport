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
    if (vis === 'private') return 'lock';
    if (vis === 'team') return 'group';
    return 'public'; // global
  };
  
  const getVisibilityColor = (vis) => {
    if (vis === 'private') return 'bg-error-container/30 text-error border-error/20';
    if (vis === 'team') return 'bg-secondary-container/50 text-on-secondary-container border-secondary/20';
    return 'bg-surface-container-low text-primary border-primary/20'; // global
  };

  return (
    <>
      <div className="mb-lg">
        <h2 className="font-headline-lg text-headline-lg text-on-surface mb-xs">Context Bus</h2>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-2xl">
          Access centralized organizational knowledge, architectural decisions, and operational contexts across all DataPassport domains.
        </p>
      </div>

      {/* Filter/Action Bar */}
      <div className="flex justify-between items-center mb-md border-b border-outline-variant pb-sm">
        <div className="flex gap-2">
          <button className="px-4 py-2 bg-surface-container-lowest border border-outline-variant rounded font-label-md text-label-md text-on-surface hover:bg-surface-variant transition-colors flex items-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-[18px]">filter_list</span>
            Filter
          </button>
          <button className="px-4 py-2 bg-surface-container-lowest border border-outline-variant rounded font-label-md text-label-md text-on-surface hover:bg-surface-variant transition-colors flex items-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-[18px]">sort</span>
            Sort
          </button>
        </div>
        <button className="px-4 py-2 bg-primary border border-primary rounded font-label-md text-label-md text-on-primary hover:bg-primary-fixed hover:text-on-primary-fixed transition-colors flex items-center gap-2 shadow-sm">
          <span className="material-symbols-outlined text-[18px]">add</span>
          New Context
        </button>
      </div>

      {loading ? (
        <p className="text-on-surface-variant">Loading Context Bus...</p>
      ) : passports.length === 0 ? (
        <p className="text-on-surface-variant">No passports found in the Context Bus yet.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
          {passports.map((p, idx) => (
            <div key={idx} className="bg-surface-container-lowest border border-outline-variant rounded-lg p-md shadow-soft hover:shadow-md transition-shadow flex flex-col h-full group">
              <div className="flex justify-between items-start mb-sm">
                <div className="flex gap-2 flex-wrap">
                  <span className={`px-2 py-1 border rounded font-label-md text-[10px] uppercase tracking-wider flex items-center gap-1 ${getVisibilityColor(p.visibility)}`}>
                    <span className="material-symbols-outlined text-[12px]">{getVisibilityIcon(p.visibility)}</span> {p.visibility}
                  </span>
                  <span className="px-2 py-1 bg-surface-container text-secondary border border-secondary/20 rounded font-label-md text-[10px] uppercase tracking-wider">
                    {p.team || p.department || 'GLOBAL'}
                  </span>
                </div>
                <button className="text-on-surface-variant hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="material-symbols-outlined text-[20px]">more_vert</span>
                </button>
              </div>
              <h3 className="font-headline-md text-body-lg font-semibold text-on-surface mb-xs mt-2">
                {p.title || `Session ${p.session_id.substring(0,8)}`}
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant mb-md flex-grow line-clamp-3">
                {p.summary || p.content_snippet || 'No summary available.'}
              </p>
              <div className="flex justify-between items-center mt-auto pt-sm border-t border-outline-variant/50">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-label-md text-[10px]">
                    {p.team ? p.team.substring(0, 2).toUpperCase() : 'SYS'}
                  </span>
                  <span className="font-body-sm text-[12px] text-on-surface-variant">System</span>
                </div>
                <span className="font-mono-sm text-mono-sm text-on-surface-variant flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">schedule</span> {new Date(p.created_at).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
