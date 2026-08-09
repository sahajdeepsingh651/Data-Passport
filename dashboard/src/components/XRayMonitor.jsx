import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, User, Cpu, ArrowRight } from 'lucide-react';

// Helper to extract just the human's last prompt and any injected context
const extractImportantParts = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return { prompt: '', injection: '' };
  
  let prompt = '';
  let injection = '';

  // Find the last user message
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg && Array.isArray(lastUserMsg.content)) {
    // The actual prompt is usually the last text block that isn't an injection
    const textBlocks = lastUserMsg.content.filter(b => b.type === 'text');
    for (let i = textBlocks.length - 1; i >= 0; i--) {
      let text = textBlocks[i].text || '';
      if (text.includes('<system-reminder>')) {
        injection = text.replace('<system-reminder>', '').replace('</system-reminder>', '').trim();
      } else if (text.includes('SUGGESTION MODE:')) {
        continue;
      } else if (!prompt) {
        // Strip out invisible Antigravity hooks (like mode-overlay warnings)
        if (text.includes('UserPromptSubmit hook success:')) {
          text = text.split('UserPromptSubmit hook success:')[0].trim();
        }
        prompt = text;
      }
    }
  }

  // Also check for role="system" which is another way DataPassport injects
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg) {
    if (Array.isArray(systemMsg.content)) {
      injection = systemMsg.content.map(b => b.text).join('\n');
    } else if (typeof systemMsg.content === 'string') {
      injection = systemMsg.content;
    }
  }

  return { prompt, injection };
};

export default function XRayMonitor() {
  const [liveData, setLiveData] = useState({ raw: null, sanitized: null });
  
  useEffect(() => {
    const eventSource = new EventSource('http://localhost:8080/v1/dashboard/stream');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'request') {
          // Prevent empty automated background requests from overwriting the UI
          const extracted = extractImportantParts(data.raw?.messages);
          if (extracted.prompt) {
            setLiveData({ raw: data.raw, sanitized: data.sanitized });
          }
        }
      } catch (e) {}
    };
    return () => eventSource.close();
  }, []);

  const formatText = (text) => {
    if (!text) return <span style={{color: 'var(--text-secondary)'}}>No data</span>;
    
    // Split by our tokens to render them as nice UI badges instead of raw text
    const parts = text.split(/(⟦(?:SECRET|PII)_[0-9]+⟧)/g);
    
    return parts.map((part, i) => {
      if (part.startsWith('⟦SECRET_') || part.startsWith('⟦PII_')) {
        return <span key={i} className="redacted-token-badge">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  const rawParts = extractImportantParts(liveData.raw?.messages);
  const sanitizedParts = extractImportantParts(liveData.sanitized?.messages);

  return (
    <div>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes pulseGlow {
          0% { box-shadow: 0 0 15px rgba(0, 255, 157, 0.1); }
          50% { box-shadow: 0 0 30px rgba(0, 255, 157, 0.3); }
          100% { box-shadow: 0 0 15px rgba(0, 255, 157, 0.1); }
        }
        @keyframes flowRight {
          0% { background-position: 0% 50%; }
          100% { background-position: 100% 50%; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .xray-container {
          position: relative;
        }
        .bg-glow {
          position: absolute;
          top: 30%;
          left: 50%;
          width: 800px;
          height: 400px;
          transform: translate(-50%, -50%);
          background: radial-gradient(circle, rgba(51, 102, 255, 0.1) 0%, rgba(0, 255, 157, 0.05) 50%, transparent 70%);
          filter: blur(40px);
          z-index: 0;
          pointer-events: none;
        }
        .redacted-token-badge {
          display: inline-flex;
          align-items: center;
          background: linear-gradient(135deg, rgba(0, 255, 157, 0.2), rgba(0, 255, 157, 0.05));
          color: #00ff9d;
          border: 1px solid rgba(0, 255, 157, 0.5);
          padding: 3px 10px;
          border-radius: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          letter-spacing: 0.5px;
          margin: 0 4px;
          box-shadow: 0 0 12px rgba(0, 255, 157, 0.25);
          text-shadow: 0 0 8px rgba(0, 255, 157, 0.5);
          animation: pulseGlow 3s infinite;
        }
        .premium-panel {
          background: rgba(15, 15, 20, 0.6);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 16px;
          padding: 2rem;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1);
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          animation: fadeIn 0.4s ease-out;
        }
        .premium-panel.danger {
          border-top: 4px solid var(--accent-red);
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 51, 102, 0.2);
        }
        .premium-panel.safe {
          border-top: 4px solid var(--accent-green);
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(0, 255, 157, 0.2);
        }
        .chat-bubble {
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          padding: 1.5rem;
          margin-top: 1rem;
          font-size: 1.05rem;
          line-height: 1.7;
          white-space: pre-wrap;
          box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }
        .injection-bubble {
          background: linear-gradient(135deg, rgba(51, 102, 255, 0.1), rgba(51, 102, 255, 0.02));
          border: 1px solid rgba(51, 102, 255, 0.3);
          border-left: 4px solid var(--accent-blue);
          border-radius: 14px;
          padding: 1.5rem;
          margin-top: 1.5rem;
          font-size: 1rem;
          line-height: 1.7;
          white-space: pre-wrap;
          color: #e0e7ff;
          box-shadow: 0 8px 20px rgba(51, 102, 255, 0.15);
        }
        .connection-arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 1rem;
          position: relative;
          z-index: 1;
        }
        .flow-line {
          height: 4px;
          width: 100%;
          background: linear-gradient(90deg, var(--accent-red), var(--accent-green));
          background-size: 200% 100%;
          border-radius: 4px;
          animation: flowRight 2s linear infinite;
          position: relative;
          box-shadow: 0 0 15px rgba(0, 255, 157, 0.4);
        }
        .flow-line::after {
          content: '';
          position: absolute;
          right: -4px;
          top: -6px;
          border-top: 8px solid transparent;
          border-bottom: 8px solid transparent;
          border-left: 12px solid var(--accent-green);
        }
      `}} />

      <div className="xray-container">
        <div className="bg-glow"></div>
        
        <h2 style={{marginTop: 0, fontSize: '2rem', background: 'linear-gradient(90deg, #fff, #a0a0b0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'}}>Live X-Ray Monitor</h2>
        <p style={{color: 'var(--text-secondary)', marginBottom: '3rem', fontSize: '1.1rem'}}>
          Watch how DataPassport instantly sanitizes and enriches the developer's prompts.
        </p>
        
        {!liveData.raw ? (
          <div className="premium-panel" style={{textAlign: 'center', padding: '5rem', alignItems: 'center'}}>
            <div style={{
              background: 'rgba(255,255,255,0.05)', 
              borderRadius: '50%', 
              width: '100px', 
              height: '100px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              marginBottom: '1.5rem'
            }}>
              <ShieldCheck size={48} color="var(--text-secondary)" style={{opacity: 0.7}} />
            </div>
            <h3 style={{margin: 0, fontSize: '1.5rem', color: 'var(--text-primary)'}}>Waiting for AI traffic...</h3>
            <p style={{color: 'var(--text-secondary)', fontSize: '1.1rem', marginTop: '0.5rem'}}>Type a prompt into Claude Code to see it intercepted here.</p>
          </div>
        ) : (
          <div className="split-screen" style={{height: 'auto', display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '1rem'}}>
            
            {/* RAW SIDE */}
            <div className="premium-panel danger">
              <div className="payload-header" style={{borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '1rem'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem'}}>
                  <div style={{background: 'rgba(255, 51, 102, 0.2)', padding: '8px', borderRadius: '8px'}}>
                    <ShieldAlert color="var(--accent-red)" size={24} />
                  </div>
                  <h3 style={{margin: 0, fontSize: '1.25rem'}}>Device (Raw Input)</h3>
                </div>
                <span className="status-badge status-danger" style={{boxShadow: '0 0 10px rgba(255, 51, 102, 0.3)'}}>Unsafe</span>
              </div>
              
              <div style={{marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600}}>
                <User size={18} /> <span>Developer Prompt</span>
              </div>
              <div className="chat-bubble">
                {rawParts.prompt || <span style={{color: 'var(--text-secondary)', fontStyle: 'italic'}}>No user prompt detected</span>}
              </div>
            </div>

            {/* FLOW ARROW */}
            <div className="connection-arrow">
              <div className="flow-line"></div>
            </div>

            {/* SANITIZED SIDE */}
            <div className="premium-panel safe">
              <div className="payload-header" style={{borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '1rem'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem'}}>
                  <div style={{background: 'rgba(0, 255, 157, 0.15)', padding: '8px', borderRadius: '8px'}}>
                    <ShieldCheck color="var(--accent-green)" size={24} />
                  </div>
                  <h3 style={{margin: 0, fontSize: '1.25rem'}}>Anthropic API (Outbound)</h3>
                </div>
                <span className="status-badge status-safe" style={{boxShadow: '0 0 10px rgba(0, 255, 157, 0.3)'}}>Protected</span>
              </div>
              
              <div style={{marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600}}>
                <Cpu size={18} /> <span>Sanitized Prompt sent to AI</span>
              </div>
              <div className="chat-bubble">
                {formatText(sanitizedParts.prompt)}
              </div>

              {sanitizedParts.injection && (
                <>
                  <div style={{marginTop: '2rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-blue)', fontWeight: 600}}>
                    <ShieldCheck size={18} /> <span>DataPassport Knowledge Injection</span>
                  </div>
                  <div className="injection-bubble">
                    {sanitizedParts.injection}
                  </div>
                </>
              )}
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
