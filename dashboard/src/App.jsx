import { useState } from 'react';
import { Activity, Database, CheckSquare, ShieldCheck } from 'lucide-react';
import XRayMonitor from './components/XRayMonitor';
import ContextBusExplorer from './components/ContextBusExplorer';
import ApprovalInbox from './components/ApprovalInbox';

function App() {
  const [activeTab, setActiveTab] = useState('xray');

  return (
    <div className="dashboard-container">
      <aside className="sidebar">
        <div className="sidebar-title">
          <ShieldCheck size={28} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
          DataPassport
        </div>
        
        <div 
          className={`nav-item ${activeTab === 'xray' ? 'active' : ''}`}
          onClick={() => setActiveTab('xray')}
        >
          <Activity size={20} />
          X-Ray Monitor
        </div>
        
        <div 
          className={`nav-item ${activeTab === 'contextbus' ? 'active' : ''}`}
          onClick={() => setActiveTab('contextbus')}
        >
          <Database size={20} />
          Context Bus
        </div>
        
        <div 
          className={`nav-item ${activeTab === 'approvals' ? 'active' : ''}`}
          onClick={() => setActiveTab('approvals')}
        >
          <CheckSquare size={20} />
          Approval Inbox
        </div>
      </aside>

      <main className="main-content">
        {activeTab === 'xray' && <XRayMonitor />}
        {activeTab === 'contextbus' && <ContextBusExplorer />}
        {activeTab === 'approvals' && <ApprovalInbox />}
      </main>
    </div>
  );
}

export default App;
