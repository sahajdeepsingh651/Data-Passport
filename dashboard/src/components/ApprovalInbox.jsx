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
    <>
      <div className="mb-gutter flex justify-between items-end">
        <div>
          <h2 className="font-headline-lg text-headline-lg text-on-surface mb-xs flex items-center gap-2">
            <span className="material-symbols-outlined text-error">check_box</span>
            Approval Inbox
          </h2>
          <p className="font-body-md text-body-md text-secondary">Review and authorize pending AI-generated drafts.</p>
        </div>
        <div className="flex gap-sm">
          <button className="flex items-center gap-xs px-sm py-xs bg-surface-container border border-outline-variant rounded-lg font-label-md text-label-md text-on-surface hover:bg-surface-variant transition-colors">
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">filter_list</span>
            Filter
          </button>
          <button className="flex items-center gap-xs px-sm py-xs bg-surface-container border border-outline-variant rounded-lg font-label-md text-label-md text-on-surface hover:bg-surface-variant transition-colors">
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">sort</span>
            Sort
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-on-surface-variant">Loading inbox...</p>
      ) : drafts.length === 0 ? (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-xl shadow-[0px_10px_15px_-3px_rgba(1,8,26,0.08)] flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-primary-container/20 flex items-center justify-center mb-md">
            <span className="material-symbols-outlined text-4xl text-primary" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
          </div>
          <h3 className="font-headline-md text-headline-md text-on-surface mb-xs">Inbox Zero</h3>
          <p className="font-body-md text-body-md text-secondary">All intercepted drafts have been processed.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-md">
          {drafts.map((d, idx) => (
            <div key={idx} className="bg-surface-container-lowest border border-outline-variant rounded-xl p-md shadow-[0px_10px_15px_-3px_rgba(1,8,26,0.08)] flex flex-col gap-md transition-all hover:border-primary/50">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-sm">
                  <div className="w-10 h-10 rounded-lg bg-surface-variant flex items-center justify-center text-primary">
                    <span aria-hidden="true" className="material-symbols-outlined">campaign</span>
                  </div>
                  <div>
                    <h3 className="font-headline-md text-headline-md text-on-surface text-[20px]">{d.title || `Draft ${d.pending_id}`}</h3>
                    <div className="flex items-center gap-sm mt-xs">
                      <span className="font-mono-sm text-mono-sm text-secondary">ID: {d.session_id.substring(0,8)}</span>
                      <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
                      <span className="font-label-md text-label-md text-secondary flex items-center gap-1 uppercase">
                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                          {d.visibility === 'private' ? 'lock' : d.visibility === 'team' ? 'group' : 'public'}
                        </span> {d.visibility}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="px-sm py-xs bg-[#FF9933]/10 text-[#FF9933] rounded-full font-label-md text-label-md flex items-center gap-xs border border-[#FF9933]/20">
                  <span aria-hidden="true" className="material-symbols-outlined text-[14px]">hourglass_empty</span>
                  Pending Approval
                </div>
              </div>
              
              <div className="bg-surface p-sm rounded-lg border border-outline-variant/50">
                <h4 className="font-label-md text-label-md text-on-surface-variant mb-xs">Sanitized Summary</h4>
                <p className="font-body-sm text-body-sm text-on-surface whitespace-pre-wrap">
                  {d.summary}
                </p>
              </div>
              
              <div className="flex justify-end gap-sm pt-xs border-t border-outline-variant/30">
                <button className="px-md py-sm bg-surface-container-lowest border border-outline-variant text-on-surface-variant font-label-md text-label-md rounded-lg hover:bg-surface-variant hover:text-on-surface transition-colors flex items-center gap-xs">
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">edit</span>
                  Edit
                </button>
                <button className="px-md py-sm bg-surface-container-lowest border border-error/30 text-error font-label-md text-label-md rounded-lg hover:bg-error-container transition-colors flex items-center gap-xs">
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                  Reject
                </button>
                <button className="px-md py-sm bg-primary text-on-primary font-label-md text-label-md rounded-lg hover:bg-primary/90 shadow-sm transition-colors flex items-center gap-xs">
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">check</span>
                  Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
