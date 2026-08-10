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
        return <span key={i} className="bg-primary-container text-on-primary-container font-bold px-1 rounded inline-block border border-primary/30 mx-1">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  const rawParts = extractImportantParts(liveData.raw?.messages);
  const sanitizedParts = extractImportantParts(liveData.sanitized?.messages);

  return (
    <>
      {/* Page Header */}
      <div className="mb-lg">
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Live Context Interception</h2>
        <p className="font-body-md text-body-md text-on-surface-variant mt-sm max-w-3xl">
          Real-time telemetry of payload sanitization. The X-Ray monitor flags sensitive entity requests and demonstrates automated policy enforcement before routing to external inference endpoints.
        </p>
      </div>

      {!liveData.raw ? (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant p-xl shadow-level-2 text-center mt-xl flex flex-col items-center justify-center min-h-[400px]">
          <div className="w-16 h-16 rounded-full bg-surface-variant flex items-center justify-center mb-md">
            <span className="material-symbols-outlined text-4xl text-on-surface-variant" style={{opacity: 0.7}}>shield</span>
          </div>
          <h3 className="font-headline-md text-headline-md text-on-surface mb-xs">Waiting for AI traffic...</h3>
          <p className="font-body-md text-body-md text-on-surface-variant max-w-md mx-auto">
            Type a prompt into Claude Code to see it intercepted here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col xl:flex-row items-stretch gap-gutter w-full mt-xl">
          {/* Left Side: Raw Developer Prompt */}
          <div className="flex-1 bg-surface-container-lowest rounded-xl border border-error/20 border-t-4 border-t-error p-md shadow-level-2 relative overflow-hidden flex flex-col">
            <div className="flex justify-between items-start mb-md">
              <div>
                <h3 className="font-headline-md text-headline-md text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-error">warning</span>
                  Device (Raw Input)
                </h3>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-xs">Developer Prompt</p>
              </div>
              <div className="bg-error-container text-on-error-container font-label-md text-label-md px-3 py-1.5 rounded uppercase tracking-wider flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]" style={{fontVariationSettings: "'FILL' 1"}}>gpp_bad</span>
                UNSAFE
              </div>
            </div>
            
            <div className="flex-1 bg-background rounded-lg border border-error/10 p-4 font-mono-sm text-mono-sm text-on-surface relative overflow-x-auto whitespace-pre-wrap">
              {rawParts.prompt || <span style={{color: 'var(--text-secondary)', fontStyle: 'italic'}}>No user prompt detected</span>}
            </div>
          </div>

          {/* Flow Connector */}
          <div className="hidden xl:flex flex-col items-center justify-center px-4 relative z-0">
            <div className="w-12 h-12 rounded-full bg-surface-variant border border-outline-variant flex items-center justify-center shadow-sm relative z-10">
              <span className="material-symbols-outlined text-primary">arrow_forward</span>
            </div>
            <div className="absolute h-0.5 bg-outline-variant w-full top-1/2 -z-10 -translate-y-1/2"></div>
          </div>
          
          <div className="xl:hidden flex justify-center py-sm">
            <span className="material-symbols-outlined text-outline text-3xl">arrow_downward</span>
          </div>

          {/* Right Side: Sanitized Prompt */}
          <div className="flex-1 bg-surface-container-lowest rounded-xl border border-primary/20 border-t-4 border-t-primary p-md shadow-level-2 relative overflow-hidden flex flex-col">
            <div className="flex justify-between items-start mb-md">
              <div>
                <h3 className="font-headline-md text-headline-md text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">verified_user</span>
                  Anthropic API (Outbound)
                </h3>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-xs">Sanitized Prompt sent to AI</p>
              </div>
              <div className="bg-primary-container text-on-primary-container font-label-md text-label-md px-3 py-1.5 rounded uppercase tracking-wider flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]" style={{fontVariationSettings: "'FILL' 1"}}>gpp_good</span>
                PROTECTED
              </div>
            </div>
            
            <div className="flex-1 bg-background rounded-lg border border-primary/10 p-4 font-mono-sm text-mono-sm text-on-surface relative overflow-x-auto whitespace-pre-wrap">
              {formatText(sanitizedParts.prompt)}
            </div>

            {sanitizedParts.injection && (
              <>
                <div className="mt-md mb-xs flex items-center gap-2 text-primary font-semibold">
                  <span className="material-symbols-outlined text-[18px]">shield</span>
                  <span>DataPassport Knowledge Injection</span>
                </div>
                <div className="bg-surface-container-low rounded-lg border border-primary/20 p-4 font-mono-sm text-mono-sm text-on-surface relative overflow-x-auto whitespace-pre-wrap">
                  {sanitizedParts.injection}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
