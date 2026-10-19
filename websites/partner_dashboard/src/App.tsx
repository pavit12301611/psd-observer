import { useState } from 'react';
import { Handshake, Building2 } from 'lucide-react';
import { PartnerPanel } from './PartnerPanel';
import { EnterprisePanel } from './EnterprisePanel';

type Tab = 'partner' | 'enterprise';

function App() {
  const [tab, setTab] = useState<Tab>('partner');

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center px-4 py-12">
      {/* Soft background accents */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-blue-100/50 blur-3xl" />
        <div className="absolute -bottom-32 -left-24 w-96 h-96 rounded-full bg-indigo-100/40 blur-3xl" />
      </div>

      <div className="relative w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white shadow-sm border border-gray-100 mb-5">
            <img src="/eye-logo-black.svg" alt="Observer AI" className="w-9 h-9" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            {tab === 'partner' ? 'Partner Dashboard' : 'Enterprise Admin'}
          </h1>
        </div>

        {/* Tabs. These authenticate with different keys — partners must never be
            able to reach the admin endpoints, which create Stripe subscriptions. */}
        <div className="flex gap-1 bg-white border border-gray-100 rounded-2xl p-1 mb-5 shadow-sm">
          <TabButton active={tab === 'partner'} onClick={() => setTab('partner')} icon={<Handshake className="w-4 h-4" />}>
            Partner
          </TabButton>
          <TabButton active={tab === 'enterprise'} onClick={() => setTab('enterprise')} icon={<Building2 className="w-4 h-4" />}>
            Enterprise
          </TabButton>
        </div>

        {tab === 'partner' ? <PartnerPanel /> : <EnterprisePanel />}

        <p className="text-center text-xs text-gray-400 mt-6">
          Observer AI · {tab === 'partner' ? 'Partner Program' : 'Internal use only'}
        </p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-xl py-2.5 transition ${
        active ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export default App;
