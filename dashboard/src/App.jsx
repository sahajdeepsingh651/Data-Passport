import { useState } from 'react';
import XRayMonitor from './components/XRayMonitor';
import ContextBusExplorer from './components/ContextBusExplorer';
import ApprovalInbox from './components/ApprovalInbox';

function App() {
  const [activeTab, setActiveTab] = useState('xray');

  return (
    <div className="bg-background text-on-background font-body-md text-body-md antialiased min-h-screen">
      {/* SideNavBar */}
      <nav className="bg-surface-container-low dark:bg-inverse-surface h-screen w-64 fixed left-0 top-0 border-r border-outline-variant dark:border-outline z-20">
        <div className="flex flex-col h-full p-md">
          {/* Header/Logo */}
          <div className="flex items-center gap-3 mb-xl">
            <div className="w-10 h-10 rounded bg-primary flex items-center justify-center text-on-primary">
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md font-bold text-primary dark:text-primary-fixed leading-none">DataPassport</h1>
              <span className="font-label-md text-label-md text-secondary mt-xs block">Enterprise SaaS</span>
            </div>
          </div>
          {/* Navigation Tabs */}
          <ul className="flex flex-col gap-sm flex-1 cursor-pointer">
            <li onClick={() => setActiveTab('xray')}>
              <a className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ease-in-out ${activeTab === 'xray' ? 'bg-secondary-container dark:bg-secondary-fixed-dim text-on-secondary-container dark:text-on-secondary-fixed font-semibold' : 'text-secondary dark:text-secondary-fixed hover:bg-surface-variant dark:hover:bg-on-secondary-fixed-variant'}`}>
                <span className="material-symbols-outlined">monitor_heart</span>
                <span className="font-body-md text-body-md font-semibold">X-Ray Monitor</span>
              </a>
            </li>
            <li onClick={() => setActiveTab('contextbus')}>
              <a className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ease-in-out ${activeTab === 'contextbus' ? 'bg-secondary-container dark:bg-secondary-fixed-dim text-on-secondary-container dark:text-on-secondary-fixed font-semibold' : 'text-secondary dark:text-secondary-fixed hover:bg-surface-variant dark:hover:bg-on-secondary-fixed-variant'}`}>
                <span className="material-symbols-outlined">alt_route</span>
                <span className="font-body-md text-body-md font-semibold">Context Bus</span>
              </a>
            </li>
            <li onClick={() => setActiveTab('approvals')}>
              <a className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ease-in-out ${activeTab === 'approvals' ? 'bg-secondary-container dark:bg-secondary-fixed-dim text-on-secondary-container dark:text-on-secondary-fixed font-semibold' : 'text-secondary dark:text-secondary-fixed hover:bg-surface-variant dark:hover:bg-on-secondary-fixed-variant'}`}>
                <span className="material-symbols-outlined">move_to_inbox</span>
                <span className="font-body-md text-body-md font-semibold">Approval Inbox</span>
              </a>
            </li>
          </ul>
        </div>
      </nav>

      {/* TopAppBar */}
      <header className="bg-surface-container-lowest dark:bg-surface-dim border-b border-outline-variant dark:border-outline shadow-sm fixed top-0 right-0 left-64 h-16 z-10 flex justify-between items-center px-gutter w-[calc(100%-16rem)]">
        {/* Search Area */}
        <div className="flex-1 max-w-md">
          <div className="relative flex items-center w-full h-10 rounded bg-surface border border-outline-variant focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition-all">
            <span className="material-symbols-outlined absolute left-3 text-on-surface-variant">search</span>
            <input className="w-full h-full bg-transparent border-none pl-10 pr-4 font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-0" placeholder="Search payloads or policy IDs..." type="text"/>
          </div>
        </div>
        {/* Trailing Actions */}
        <div className="flex items-center gap-md">
          <button className="text-on-surface-variant hover:text-primary transition-colors focus-within:ring-2 focus-within:ring-primary/20 rounded p-1">
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button className="text-on-surface-variant hover:text-primary transition-colors focus-within:ring-2 focus-within:ring-primary/20 rounded p-1">
            <span className="material-symbols-outlined">settings</span>
          </button>
          <div className="w-8 h-8 rounded-full bg-surface-variant border border-outline-variant overflow-hidden cursor-pointer ml-sm">
            <img alt="User profile" className="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuAdqYjFWJmrdJgCQmAxUfyi9t8tE7bv61O1OlA90h9wFqugz6OQ25LpcPv_mE64xC1P5GAtQEye_EQ1_FmTBdLUfXrqP8rrwBKY-s4aWSgLoB_yX1kBojQzXj_h7PcCvNButDYCHsIyU-bXiYCrsVf3vToTN2tvm3QBaZrJA8uZ9e2RqutLeSczusnNNZ7qYafI7DhpEBI4_NnSKlLinvH0rJ0a8K89t7s3FvYw"/>
          </div>
        </div>
      </header>

      {/* Main Content Canvas */}
      <main className="ml-64 mt-16 p-lg">
        {activeTab === 'xray' && <XRayMonitor />}
        {activeTab === 'contextbus' && <ContextBusExplorer />}
        {activeTab === 'approvals' && <ApprovalInbox />}
      </main>
    </div>
  );
}

export default App;
