// components/AccountModal.tsx

import React, { useState } from 'react';
import { X } from 'lucide-react';

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: { name?: string; email?: string; picture?: string } | null;
  onLogout: () => void;
  onDeleteAccount: () => void;
}

const AccountModal: React.FC<AccountModalProps> = ({
  isOpen,
  onClose,
  user,
  onLogout,
  onDeleteAccount,
}) => {
  const [isDangerZoneOpen, setIsDangerZoneOpen] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  if (!isOpen) return null;

  const handleClose = () => {
    setIsDangerZoneOpen(false);
    setIsConfirmingDelete(false);
    setIsDeleting(false);
    onClose();
  };

  const handleDeleteClick = () => {
    if (!isConfirmingDelete) {
      setIsConfirmingDelete(true);
    } else {
      setIsDeleting(true);
      onDeleteAccount();
    }
  };

  const handleCancelDelete = () => {
    setIsConfirmingDelete(false);
  };

  // Get user initials for avatar fallback
  const getInitials = () => {
    if (user?.name) {
      return user.name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    if (user?.email) {
      return user.email[0].toUpperCase();
    }
    return 'U';
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 z-[70] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-gray-200 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Account</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 flex flex-col items-center">
          {/* Avatar */}
          {user?.picture ? (
            <img
              src={user.picture}
              alt={user.name || 'User avatar'}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center">
              <span className="text-xl font-semibold text-gray-600">{getInitials()}</span>
            </div>
          )}

          {/* Name */}
          {user?.name && (
            <p className="mt-3 text-lg font-semibold text-gray-800">{user.name}</p>
          )}

          {/* Email */}
          {user?.email && (
            <p className="mt-1 text-sm text-gray-500">{user.email}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 space-y-3">
          {/* Log Out button */}
          <button
            onClick={onLogout}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-700 font-medium"
          >
            Log Out
          </button>

          {/* Collapsible Danger Zone */}
          <div className="pt-2">
            <button
              onClick={() => setIsDangerZoneOpen(!isDangerZoneOpen)}
              className="text-xs text-red-400 hover:text-red-600 flex items-center gap-1"
            >
              <span className={`transition-transform ${isDangerZoneOpen ? 'rotate-90' : ''}`}>
                ›
              </span>
              Danger Zone
            </button>

            {isDangerZoneOpen && (
              <div className="mt-3 p-3 border border-red-200 rounded-lg bg-red-50">
                {!isConfirmingDelete ? (
                  <>
                    <p className="text-xs text-gray-500 mb-2">
                      Permanently delete your account and all data.
                    </p>
                    <button
                      onClick={handleDeleteClick}
                      className="text-sm text-red-600 hover:text-red-700 hover:underline"
                    >
                      Delete Account
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-red-700 mb-2 font-medium">
                      Are you sure? This cannot be undone.
                    </p>
                    <div className="flex space-x-2">
                      <button
                        onClick={handleCancelDelete}
                        className="text-sm text-gray-600 hover:underline"
                        disabled={isDeleting}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleDeleteClick}
                        className="text-sm text-red-600 font-medium hover:underline disabled:opacity-50"
                        disabled={isDeleting}
                      >
                        {isDeleting ? 'Deleting...' : 'Yes, Delete'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AccountModal;
