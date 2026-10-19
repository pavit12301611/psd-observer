import React from 'react';
import { Trash2 } from 'lucide-react';
import Modal from '@components/EditAgent/Modal';

interface ConfirmDeleteModalProps {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onClose: () => void;
}

const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({ open, title, description, onConfirm, onClose }) => (
  <Modal open={open} onClose={onClose} className="w-full max-w-sm mx-4">
    <div className="flex items-start gap-3 px-6 py-4">
      <div className="flex-shrink-0 mt-0.5 flex items-center justify-center h-9 w-9 rounded-full bg-red-100 text-red-600">
        <Trash2 className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold leading-tight text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500 mt-1 break-words">{description}</p>
      </div>
    </div>
    <div className="flex justify-end gap-2 px-6 py-3 bg-gray-50 rounded-b-lg border-t border-gray-100">
      <button
        onClick={onClose}
        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700"
      >
        Delete
      </button>
    </div>
  </Modal>
);

export default ConfirmDeleteModal;
