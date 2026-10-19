// components/AppHeader.tsx
import React from 'react';
import { Menu } from 'lucide-react';
import SharingPermissionsModal from './SharingPermissionsModal';
import AccountModal from './AccountModal';
import type { TokenProvider } from '@utils/main_loop';

interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: any;
  loginWithRedirect: () => void;
  logout: (options?: any) => void;
}

interface AppHeaderProps {
  authState?: AuthState;
  getToken: TokenProvider;
  onToggleMobileMenu?: () => void;
  /** Lifted so the sidebar's logo button (PersistentSidebar) can open the same modal. */
  isPermissionsModalOpen: boolean;
  onClosePermissionsModal: () => void;
  /** Lifted so the sidebar's account button (PersistentSidebar) can open the same modal. */
  isAccountModalOpen: boolean;
  onCloseAccountModal: () => void;
}

const AppHeader: React.FC<AppHeaderProps> = ({
  authState,
  getToken,
  onToggleMobileMenu,
  isPermissionsModalOpen,
  onClosePermissionsModal,
  isAccountModalOpen,
  onCloseAccountModal,
}) => {
  const user = authState?.user;

  const handleLogout = () => {
    authState?.logout();
  };

  const handleDeleteAccount = async () => {
    try {
      const token = await getToken();
      await fetch('https://api.observer-ai.com/delete-account', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
    // Logout after deletion (or failed deletion attempt)
    handleLogout();
  };

  return (
    <>
      {/* Mobile-only sidebar toggle — no header bar left to host it now that the sidebar
          carries the logo/auth (desktop) and stays hidden until opened (mobile). */}
      <button
        onClick={onToggleMobileMenu}
        className="md:hidden fixed left-4 z-40 p-2.5 rounded-full bg-white/90 backdrop-blur-sm shadow-md border border-gray-200 hover:bg-gray-50"
        style={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}
        aria-label="Toggle navigation menu"
      >
        <Menu className="h-5 w-5 text-gray-600" />
      </button>

      <SharingPermissionsModal
        isOpen={isPermissionsModalOpen}
        onClose={onClosePermissionsModal}
      />

      <AccountModal
        isOpen={isAccountModalOpen}
        onClose={onCloseAccountModal}
        user={user}
        onLogout={handleLogout}
        onDeleteAccount={handleDeleteAccount}
      />
    </>
  );
};

export default AppHeader;
