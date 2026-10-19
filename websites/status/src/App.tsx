import { useEffect, useState } from 'react';
import { StatusResponse } from './types';
import { StatusGrid } from './components/StatusGrid';
import { ErrorState } from './components/ErrorState';

const API_URL = 'https://api.observer-ai.com/status';
const REFRESH_INTERVAL = 60000; // 60 seconds

// Normalize null values to 100 (assume 100% if no data)
const normalizeStatusData = (data: StatusResponse): StatusResponse => ({
  ...data,
  models: data.models.map(model => ({
    ...model,
    overall_success_rate: model.overall_success_rate ?? 100,
    hourly_stats: model.hourly_stats.map(stat => ({
      ...stat,
      success_rate: stat.success_rate ?? 100,
    })),
  })),
});

function App() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchStatus = async () => {
    try {
      const response = await fetch(API_URL);

      if (!response.ok) {
        throw new Error('Failed to fetch status');
      }

      const json: StatusResponse = await response.json();
      setData(normalizeStatusData(json));
      setError(false);
    } catch (err) {
      console.error('Error fetching status:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();

    const interval = setInterval(() => {
      fetchStatus();
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-success"></div>
          <p className="mt-4 text-gray-400">Loading status...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return <ErrorState />;
  }

  return <StatusGrid data={data} />;
}

export default App;
