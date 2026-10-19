import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, BookOpen, Image as ImageIcon } from 'lucide-react';
import { getAllMemories, getAllImageMemories, updateAgentMemory, deleteMemory } from '@utils/agent_database';
import { Logger } from '@utils/logging';
import { confirm } from '@utils/platform';
import { MEMORY_UPDATE_EVENT } from '@components/MemoryManager';
import MemoryManager from '@components/MemoryManager';

interface MemoryEntry {
  id: string;
  memory: string;
  images?: string[];
}

interface MemoryStoreTabProps {
  kind: 'text' | 'image';
}

const MemoryStoreTab: React.FC<MemoryStoreTabProps> = ({ kind }) => {
  const [allEntries, setMemories] = useState<MemoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newMemoryId, setNewMemoryId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memories = allEntries.filter(m => {
    const hasImages = (m.images?.length ?? 0) > 0;
    return kind === 'image' ? hasImages : m.memory.length > 0 || !hasImages;
  });

  useEffect(() => {
    loadMemories();

    // Listen for memory updates
    const handleMemoryUpdate = () => {
      loadMemories();
    };

    window.addEventListener(MEMORY_UPDATE_EVENT, handleMemoryUpdate);
    return () => {
      window.removeEventListener(MEMORY_UPDATE_EVENT, handleMemoryUpdate);
    };
  }, []);

  const loadMemories = async () => {
    try {
      setError(null);
      const allMemories = await getAllMemories();
      const allImageMemories = await getAllImageMemories();

      const memoryMap = new Map<string, MemoryEntry>();

      // Add text memories
      allMemories.forEach(mem => {
        memoryMap.set(mem.id, { id: mem.id, memory: mem.memory, images: [] });
      });

      // Add or update with image memories
      allImageMemories.forEach(img => {
        const existing = memoryMap.get(img.id);
        if (existing) {
          existing.images = img.images;
        } else {
          memoryMap.set(img.id, { id: img.id, memory: '', images: img.images });
        }
      });

      const mergedMemories = Array.from(memoryMap.values());
      setMemories(mergedMemories);
      Logger.debug('MEMORY_STORE', `Loaded ${mergedMemories.length} memories`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to load memories: ${errorMessage}`);
      Logger.error('MEMORY_STORE', `Failed to load memories: ${errorMessage}`, err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateMemory = async () => {
    if (!newMemoryId.trim()) {
      setError('Memory ID cannot be empty');
      return;
    }

    if (!newMemoryId.match(/^[a-zA-Z0-9_-]+$/)) {
      setError('Memory ID can only contain letters, numbers, underscores, and hyphens');
      return;
    }

    try {
      setError(null);
      setIsCreating(true);
      await updateAgentMemory(newMemoryId, '');
      Logger.info('MEMORY_STORE', `Created memory: ${newMemoryId}`);
      setNewMemoryId('');
      await loadMemories();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to create memory: ${errorMessage}`);
      Logger.error('MEMORY_STORE', `Failed to create memory: ${errorMessage}`, err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!await confirm(`Delete memory "${memoryId}"?`)) {
      return;
    }

    try {
      setError(null);
      await deleteMemory(memoryId);
      Logger.info('MEMORY_STORE', `Deleted memory: ${memoryId}`);
      await loadMemories();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to delete memory: ${errorMessage}`);
      Logger.error('MEMORY_STORE', `Failed to delete memory: ${errorMessage}`, err);
    }
  };

  const handleEditMemory = (memoryId: string) => {
    setSelectedMemoryId(memoryId);
  };

  return (
    <div className="py-6">
      <div className="max-w-6xl mx-auto">
        {/* Header with inline create */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            {kind === 'image'
              ? <ImageIcon className="w-7 h-7 text-blue-600 dark:text-blue-400" />
              : <BookOpen className="w-7 h-7 text-blue-600 dark:text-blue-400" />}
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {kind === 'image' ? 'Image Memories' : 'Text Memories'}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
              </p>
            </div>
          </div>

          {/* Create new memory - inline */}
          {kind === 'text' && <div className="flex gap-2">
            <input
              type="text"
              value={newMemoryId}
              onChange={(e) => setNewMemoryId(e.target.value.replace(/\s/g, ''))}
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault();
                } else if (e.key === 'Enter') {
                  handleCreateMemory();
                }
              }}
              placeholder="new-memory-id"
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 flex-1 sm:w-48 sm:flex-none min-w-0"
              disabled={isCreating}
            />
            <button
              onClick={handleCreateMemory}
              disabled={isCreating || !newMemoryId.trim()}
              className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" />
              {isCreating ? 'Creating...' : 'Create'}
            </button>
          </div>}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-md">
            {error}
          </div>
        )}

        {/* Memory cards grid */}
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            Loading memories...
          </div>
        ) : memories.length === 0 ? (
          <div className="p-12 text-center">
            {kind === 'image'
              ? <ImageIcon className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600" />
              : <BookOpen className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600" />}
            <p className="text-gray-500 dark:text-gray-400 mb-2">{kind === 'image' ? 'No image memories yet' : 'No text memories yet'}</p>
            {kind === 'text' && <p className="text-sm text-gray-400 dark:text-gray-500">Create one to get started</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {memories.map((memory) => (
              <div
                key={memory.id}
                className="bg-white dark:bg-gray-800 rounded-lg shadow hover:shadow-lg transition-shadow border border-gray-200 dark:border-gray-700 overflow-hidden group"
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 break-all">
                      {memory.id}
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleEditMemory(memory.id)}
                        className="p-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded transition-colors"
                        title="Edit memory"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteMemory(memory.id)}
                        className="p-1.5 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors"
                        title="Delete memory"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <div className="bg-gray-50 dark:bg-gray-700/50 px-2 py-1 rounded">
                      {memory.memory.length === 0 ? (
                        <span className="italic">Empty</span>
                      ) : (
                        <span>{memory.memory.length.toLocaleString()} chars</span>
                      )}
                    </div>
                    {memory.images && memory.images.length > 0 && (
                      <div className="bg-blue-50 dark:bg-blue-900/30 px-2 py-1 rounded flex items-center gap-1">
                        <ImageIcon className="w-3 h-3" />
                        <span>{memory.images.length}</span>
                      </div>
                    )}
                  </div>

                  {memory.memory.length > 0 && (
                    <div className="mt-3 text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
                      {memory.memory}
                    </div>
                  )}

                  {/* Image preview */}
                  {memory.images && memory.images.length > 0 && (
                    <div className="mt-3 flex gap-1 overflow-hidden">
                      {memory.images.slice(0, 3).map((image, idx) => (
                        <img
                          key={idx}
                          src={`data:image/png;base64,${image}`}
                          alt={`Preview ${idx + 1}`}
                          className="w-16 h-16 object-cover rounded border border-gray-200 dark:border-gray-600"
                        />
                      ))}
                      {memory.images.length > 3 && (
                        <div className="w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 flex items-center justify-center text-xs text-gray-500 dark:text-gray-400">
                          +{memory.images.length - 3}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => handleEditMemory(memory.id)}
                  className="w-full px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-t border-gray-200 dark:border-gray-700 transition-colors"
                >
                  Open Memory
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Memory Manager Modal */}
      {selectedMemoryId && (
        <MemoryManager
          agentId={selectedMemoryId}
          agentName={selectedMemoryId}
          isOpen={true}
          onClose={() => setSelectedMemoryId(null)}
        />
      )}
    </div>
  );
};

export default MemoryStoreTab;
