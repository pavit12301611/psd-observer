import { useState, useEffect, useMemo } from 'react';
import { getAllRecordings, deleteRecording } from '@utils/recordingsDB'; // Assuming deleteRecording exists
import ClipPlayer from '@components/ClipPlayer';
import { Play, ChevronUp, Download, Trash2, Clock, RefreshCw, Video } from 'lucide-react';
import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { confirm } from '@utils/platform';

// --- TYPE DEFINITIONS ---
interface ClipMarker {
  label: string;
  timestamp: number;
}
interface RecordingData {
  id: string;
  blob: Blob;
  createdAt: Date; // Important: ensure this is a Date object
  metadata: ClipMarker[];
}

// --- HELPER FUNCTION ---
const groupRecordingsByDate = (recordings: RecordingData[]) => {
    const groups: { [key: string]: RecordingData[] } = {};
    const sortedRecordings = [...recordings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    sortedRecordings.forEach(rec => {
        const date = rec.createdAt;
        let groupKey: string;

        if (isToday(date)) {
            groupKey = 'Today';
        } else if (isYesterday(date)) {
            groupKey = 'Yesterday';
        } else if (isThisWeek(date, { weekStartsOn: 1 })) {
            groupKey = 'This Week';
        } else {
            groupKey = format(date, 'MMMM d, yyyy');
        }
        
        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(rec);
    });
    return groups;
};


// --- MAIN COMPONENT ---
export default function RecordingsViewer() {
    const [recordings, setRecordings] = useState<RecordingData[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [expandedRecordingId, setExpandedRecordingId] = useState<string | null>(null);
    const [isReloading, setIsReloading] = useState(false);

    const fetchRecordings = async () => {
        setIsReloading(true);
        setError(null);
        try {
            const allRecs = await getAllRecordings();
            // Ensure createdAt is a Date object for reliable sorting and formatting
            const formattedRecs = allRecs.map(rec => ({
              ...rec,
              createdAt: rec.createdAt instanceof Date ? rec.createdAt : new Date(rec.createdAt),
            }));
            setRecordings(formattedRecs);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(`Failed to load recordings: ${msg}`);
        } finally {
            setIsReloading(false);
        }
    };

    useEffect(() => {
        fetchRecordings();
    }, []);

    const groupedRecordings = useMemo(() => groupRecordingsByDate(recordings), [recordings]);

    const handleToggleExpand = (id: string) => {
        setExpandedRecordingId(prevId => (prevId === id ? null : id));
    };

    const handleDownload = (e: React.MouseEvent, recording: RecordingData) => {
        e.stopPropagation(); // Prevent card from toggling
        const url = URL.createObjectURL(recording.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Observer-Recording-${recording.createdAt.toISOString()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // Prevent card from toggling
        if (await confirm('Are you sure you want to permanently delete this recording?')) {
            try {
                await deleteRecording(id);
                setRecordings(prev => prev.filter(rec => rec.id !== id));
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setError(`Failed to delete recording: ${msg}`);
            }
        }
    };

    if (error) {
        return <div className="text-red-600 dark:text-red-400 p-5">Error: {error}</div>;
    }

    return (
        <div className="py-6">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <Video className="w-7 h-7 text-blue-600 dark:text-blue-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Video Memories</h1>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            {recordings.length} {recordings.length === 1 ? 'recording' : 'recordings'}
                        </p>
                    </div>
                </div>
                <button
                    onClick={fetchRecordings}
                    disabled={isReloading}
                    className="flex items-center justify-center p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 disabled:opacity-50"
                    title="Reload recordings"
                >
                    <RefreshCw size={18} className={isReloading ? 'animate-spin' : ''} />
                </button>
            </div>

            {recordings.length > 0 ? (
                Object.entries(groupedRecordings).map(([groupTitle, groupRecordings]) => (
                    <div key={groupTitle} className="mb-6">
                        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-200 dark:border-gray-700 mb-3">
                            {groupTitle}
                        </h2>
                        {groupRecordings.map(recording => {
                            const isExpanded = expandedRecordingId === recording.id;
                            return (
                                <div
                                    key={recording.id}
                                    className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow mb-3 overflow-hidden transition-shadow hover:shadow-lg"
                                >
                                    <header
                                        className="flex justify-between items-center px-4 py-3 cursor-pointer"
                                        onClick={() => handleToggleExpand(recording.id)}
                                    >
                                        <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-medium">
                                            <Clock size={16} />
                                            <span>Recording at {format(recording.createdAt, 'p')}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button
                                                className="flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                                                title={isExpanded ? 'Collapse' : 'Play'}
                                            >
                                                {isExpanded ? <ChevronUp size={20} /> : <Play size={20} />}
                                            </button>
                                            <button
                                                className="flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                                                title="Download"
                                                onClick={(e) => handleDownload(e, recording)}
                                            >
                                                <Download size={18} />
                                            </button>
                                            <button
                                                className="flex items-center justify-center p-1.5 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                                                title="Delete"
                                                onClick={(e) => handleDelete(e, recording.id)}
                                            >
                                                <Trash2 size={18} />
                                            </button>
                                        </div>
                                    </header>
                                    <div
                                        className={`transition-all duration-500 ease-in-out overflow-hidden ${
                                            isExpanded ? 'max-h-[1000px]' : 'max-h-0 invisible'
                                        }`}
                                    >
                                        {/* The player is now always rendered, just hidden by the parent div's style */}
                                        <ClipPlayer recording={recording} />
                                    </div>

                                </div>
                            );
                        })}
                    </div>
                ))
            ) : (
                <p className="text-gray-500 dark:text-gray-400 p-5 text-center bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                    No recordings found. Start an agent and use the recording tools to create one!
                </p>
            )}
          </div>
        </div>
    );
}
