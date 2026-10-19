// src/components/GetStarted.tsx
import React from 'react';
import { Users, Plus } from 'lucide-react';
import type { TokenProvider } from '@utils/main_loop';

interface GetStartedProps {
  onExploreCommunity: () => void;
  onCreateNewAgent: () => void;
  getToken: TokenProvider;
  isAuthenticated: boolean;
  isUsingObServer: boolean;
  onSignIn?: () => void;
  onSwitchToObServer?: () => void;
  onUpgrade?: () => void;
  onRefresh?: () => void;
  onUpgradeClick?: () => void;
  onOpenRecipe?: () => void;
}

const GetStarted: React.FC<GetStartedProps> = ({
  onExploreCommunity,
  onCreateNewAgent,
}) => {
  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="flex flex-col md:grid md:grid-cols-2 gap-4 md:gap-6">
        {/* Community Card */}
        <div
          onClick={onExploreCommunity}
          className="bg-white shadow-sm cursor-pointer p-6 md:p-8 border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-colors flex flex-col items-center text-center"
        >
          <div className="mb-4 bg-blue-50 flex justify-center items-center rounded-lg w-12 h-12 shrink-0">
            <Users className="text-blue-600 w-6 h-6" strokeWidth={2} />
          </div>
          <h3 className="text-gray-900 font-semibold text-lg mb-1">
            Browse Community
          </h3>
          <p className="text-gray-600 text-sm">
            Browse and use pre-built agents from the community
          </p>
        </div>

        {/* Build Custom Card */}
        <div
          onClick={onCreateNewAgent}
          data-tutorial-build-custom
          className="bg-white shadow-sm cursor-pointer p-6 md:p-8 border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-colors flex flex-col items-center text-center"
        >
          <div className="mb-4 bg-purple-50 flex justify-center items-center rounded-lg w-12 h-12 shrink-0">
            <Plus className="text-purple-600 w-6 h-6" strokeWidth={2} />
          </div>
          <h3 className="text-gray-900 font-semibold text-lg mb-1">
            Create Micro-Agent
          </h3>
          <p className="text-gray-600 text-sm">
            Create a micro-agent manually
          </p>
        </div>
      </div>
    </div>
  );
};

export default GetStarted;
